import type { MongoInstanceLink, ParsedArtifact } from "../model/types";
import { redactedRecord, redactString } from "../security/redaction";
import type { ArtifactParser, ParseContext } from "./parser";
import { record } from "./parser";

const CLUSTER_ANNOTATION = "data-architecture-mapper/cluster";
const ENVIRONMENT_ANNOTATION = "data-architecture-mapper/environment";
const NODE_ROLE_PREFIX = "node-role.kubernetes.io/";

type KubernetesKind = "Node" | "Namespace" | "ResourceQuota";

export class InfrastructureParser implements ArtifactParser {
  readonly id = "infrastructure";

  parse(documents: unknown[], context: ParseContext): ParsedArtifact[] {
    return documents.flatMap((document, index) => this.parseDocument(document, context, `document[${index}]`));
  }

  private parseDocument(value: unknown, context: ParseContext, location: string): ParsedArtifact[] {
    if (Array.isArray(value)) {
      return value.flatMap((entry, index) => this.parseDocument(entry, context, `${location}[${index}]`));
    }
    const document = record(value);
    if (!document) return [];
    const inventory = record(document.infrastructure);
    if (inventory) return this.parseInventory(inventory, context, `${location}.infrastructure`);
    const kind = kubernetesKind(document.kind);
    if (kind) return this.parseKubernetesResource(document, kind, context, location);
    const listKind = typeof document.kind === "string" && document.kind.endsWith("List")
      ? kubernetesKind(document.kind.slice(0, -"List".length))
      : undefined;
    if ((listKind || document.kind === "List") && Array.isArray(document.items)) {
      const list = kubernetesScope(document);
      return document.items.flatMap((entry, index) => {
        const item = record(entry);
        if (!item) return [];
        const itemKind = item.kind === undefined ? listKind : kubernetesKind(item.kind);
        return itemKind ? this.parseKubernetesResource(item, itemKind, context, `${location}.items[${index}]`, list) : [];
      });
    }
    return [];
  }

  private parseInventory(inventory: Record<string, unknown>, context: ParseContext, location: string): ParsedArtifact[] {
    const artifacts: ParsedArtifact[] = [];
    for (const [cluster, clusterPath] of entries(inventory.clusters, `${location}.clusters`)) {
      const name = inventoryText(cluster.name);
      const platform = inventoryText(cluster.platform);
      if (!name || !platform) continue;
      const environment = inventoryText(cluster.environment) ?? inventoryText(inventory.environment) ?? context.environment;
      artifacts.push(this.artifact(context.path, clusterPath, name, platform, environment,
        { type: "infrastructure-cluster" }, record(cluster.properties)));
      for (const [node, nodePath] of entries(cluster.nodes, `${clusterPath}.nodes`)) {
        const nodeName = inventoryText(node.name);
        if (!nodeName) continue;
        artifacts.push(this.artifact(context.path, nodePath, nodeName, platform, environment,
          { type: "cluster-node", cluster: name }, record(node.properties)));
      }
      for (const [node, nodePath] of entries(cluster.edgeNodes, `${clusterPath}.edgeNodes`)) {
        const edgeName = inventoryText(node.name);
        if (!edgeName) continue;
        artifacts.push(this.artifact(context.path, nodePath, edgeName, platform, environment,
          { type: "edge-node", cluster: name }, record(node.properties)));
        for (const [cft, cftPath] of entries(node.cfts, `${nodePath}.cfts`)) {
          const cftName = inventoryText(cft.name);
          if (!cftName) continue;
          artifacts.push(this.artifact(context.path, cftPath, cftName, platform, environment,
            { type: "cft-service", cluster: name, edgeNode: edgeName }, record(cft.properties)));
        }
      }
      for (const [namespace, namespacePath] of entries(cluster.namespaces, `${clusterPath}.namespaces`)) {
        const namespaceName = inventoryText(namespace.name);
        if (!namespaceName) continue;
        artifacts.push(this.artifact(context.path, namespacePath, namespaceName, platform, environment,
          { type: "kubernetes-namespace", cluster: name }, record(namespace.properties)));
        for (const [quota, quotaPath] of entries(namespace.quotas, `${namespacePath}.quotas`)) {
          const quotaName = inventoryText(quota.name);
          if (!quotaName) continue;
          artifacts.push(this.artifact(context.path, quotaPath, quotaName, platform, environment,
            { type: "resource-quota", cluster: name, namespace: namespaceName }, record(quota.properties)));
        }
      }
    }
    for (const [instance, instancePath] of entries(inventory.mongoInstances, `${location}.mongoInstances`)) {
      const name = inventoryText(instance.name);
      if (!name) continue;
      const environment = inventoryText(instance.environment) ?? inventoryText(inventory.environment) ?? context.environment;
      artifacts.push(this.artifact(context.path, instancePath, name, "MongoDB", environment,
        { type: "mongodb-instance", links: mongoLinks(instance.links) }, record(instance.properties)));
    }
    return artifacts;
  }

  private parseKubernetesResource(
    resource: Record<string, unknown>,
    kind: KubernetesKind,
    context: ParseContext,
    location: string,
    list: ReturnType<typeof kubernetesScope> = {}
  ): ParsedArtifact[] {
    const metadata = record(resource.metadata);
    const name = inventoryText(metadata?.name);
    if (!name) return [];
    const scope = kubernetesScope(resource);
    const cluster = scope.cluster ?? list.cluster;
    const environment = scope.environment ?? list.environment ?? context.environment;
    const artifacts: ParsedArtifact[] = [];
    if (cluster) {
      const annotationLocation = scope.cluster ? location : location.replace(/\.items\[\d+\]$/, "");
      artifacts.push(this.artifact(context.path, `${annotationLocation}.metadata.annotations[${CLUSTER_ANNOTATION}]`, cluster,
        "Kubernetes", environment, { type: "infrastructure-cluster" }));
    }
    if (kind === "Node") {
      artifacts.push(this.artifact(context.path, location, name, "Kubernetes", environment,
        { type: "cluster-node", cluster }, nodeCharacteristics(resource)));
    } else if (kind === "Namespace") {
      artifacts.push(this.artifact(context.path, location, name, "Kubernetes", environment,
        { type: "kubernetes-namespace", cluster }, { phase: inventoryText(record(resource.status)?.phase) }));
    } else {
      const namespace = inventoryText(metadata?.namespace);
      if (namespace) {
        artifacts.push(this.artifact(context.path, `${location}.metadata.namespace`, namespace, "Kubernetes", environment,
          { type: "kubernetes-namespace", cluster }));
      }
      artifacts.push(this.artifact(context.path, location, name, "Kubernetes", environment,
        { type: "resource-quota", cluster, namespace }, record(record(resource.spec)?.hard)));
    }
    return artifacts;
  }

  private artifact(
    path: string,
    location: string,
    name: string,
    technology: string,
    environment: string | undefined,
    infrastructure: NonNullable<ParsedArtifact["infrastructure"]>,
    values: Record<string, unknown> = {}
  ): ParsedArtifact {
    const config = redactedRecord(Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)));
    return {
      kind: "infrastructure", name, technology, environment, infrastructure, config,
      evidence: { path, parser: this.id, location, keys: Object.keys(config).sort() },
      diagnostics: []
    };
  }
}

function entries(values: unknown, location: string): Array<[Record<string, unknown>, string]> {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value, index) => {
    const item = record(value);
    return item ? [[item, `${location}[${index}]`]] : [];
  });
}

function inventoryText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? redactString(value.trim()) : undefined;
}

function mongoLinks(value: unknown): MongoInstanceLink[] {
  const links = record(value);
  const list: Array<[MongoInstanceLink["type"], unknown]> = [
    ["kafka-connector", links?.connectors], ["application", links?.applications]
  ];
  return list.flatMap(([type, entries]) => Array.isArray(entries) ? entries.flatMap((entry) => {
    const reference = record(entry);
    const name = inventoryText(reference?.name ?? entry);
    const subproject = inventoryText(reference?.subproject);
    return name ? [{ type, name, ...(subproject ? { subproject } : {}) }] : [];
  }) : []);
}

function kubernetesKind(value: unknown): KubernetesKind | undefined {
  return value === "Node" || value === "Namespace" || value === "ResourceQuota" ? value : undefined;
}

function kubernetesScope(resource: Record<string, unknown>): { cluster?: string; environment?: string } {
  const annotations = record(record(resource.metadata)?.annotations);
  return {
    cluster: inventoryText(annotations?.[CLUSTER_ANNOTATION]),
    environment: inventoryText(annotations?.[ENVIRONMENT_ANNOTATION])
  };
}

function nodeCharacteristics(node: Record<string, unknown>): Record<string, unknown> {
  const metadata = record(node.metadata);
  const roles = Object.keys(record(metadata?.labels) ?? {})
    .filter((label) => label.startsWith(NODE_ROLE_PREFIX) && label.length > NODE_ROLE_PREFIX.length)
    .map((label) => label.slice(NODE_ROLE_PREFIX.length)).sort();
  const status = record(node.status);
  const nodeInfo = record(status?.nodeInfo);
  const spec = record(node.spec);
  const ready = Array.isArray(status?.conditions)
    ? status.conditions.map(record).find((condition) => condition?.type === "Ready")?.status
    : undefined;
  return {
    capacity: record(status?.capacity),
    allocatable: record(status?.allocatable),
    roles: roles.length ? roles : undefined,
    kubeletVersion: inventoryText(nodeInfo?.kubeletVersion),
    containerRuntimeVersion: inventoryText(nodeInfo?.containerRuntimeVersion),
    operatingSystem: inventoryText(nodeInfo?.operatingSystem),
    osImage: inventoryText(nodeInfo?.osImage),
    kernelVersion: inventoryText(nodeInfo?.kernelVersion),
    architecture: inventoryText(nodeInfo?.architecture),
    unschedulable: typeof spec?.unschedulable === "boolean" ? spec.unschedulable : undefined,
    ready: inventoryText(ready)
  };
}
