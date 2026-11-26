import { describe, expect, it } from "vitest";
import { GraphBuilder } from "../src/graph/builder";
import { ParserRegistry } from "../src/parsing/registry";
import { REDACTED } from "../src/security/redaction";
import { project } from "./helpers";

const registry = new ParserRegistry();

describe("infrastructure discovery", () => {
  it("preserves cluster, node and edge-hosted CFT characteristics with distinct parent identities", () => {
    const content = `
infrastructure:
  environment: DEV
  clusters:
    - name: west
      platform: CDP
      properties:
        version: "7.1.9"
        management:
          password: private
          endpoint: https://user:secret@example.test
      nodes:
        - name: worker
          properties: {cores: 16, osVersion: RHEL 9}
      edgeNodes:
        - name: edge-a
          cfts:
            - name: orders-transfer
              properties: {protocol: SFTP}
        - name: edge-b
          cfts:
            - name: orders-transfer
    - name: west
      platform: Kubernetes
      nodes:
        - name: worker
          properties: {cores: 8}
`;
    const parsed = registry.parse("architecture/infra.yml", content, { environment: "STAGING" });
    expect(parsed.diagnostics).toHaveLength(0);
    expect(parsed.artifacts.every((artifact) => artifact.kind === "infrastructure")).toBe(true);
    const graph = new GraphBuilder().build(project(), parsed.artifacts);
    const clusters = graph.components.filter((component) => component.type === "infrastructure-cluster");
    const nodes = graph.components.filter((component) => component.type === "cluster-node");
    const edgeNodes = graph.components.filter((component) => component.type === "edge-node");
    const cfts = graph.components.filter((component) => component.type === "cft-service");
    expect(clusters.map((component) => component.technology)).toEqual(["CDP", "Kubernetes"]);
    expect(nodes).toHaveLength(2);
    expect(cfts).toHaveLength(2);
    expect(new Set(cfts.map((cft) => cft.infrastructureParentId))).toEqual(new Set(edgeNodes.map((node) => node.id)));
    expect(graph.components.every((component) => component.environment === "DEV" && !component.kafkaClusterId)).toBe(true);
    expect(graph.relationships.filter((relationship) => relationship.type === "HOSTED_ON")).toHaveLength(2);
    expect(graph.relationships.filter((relationship) => relationship.type === "BELONGS_TO")).toHaveLength(4);
    expect(graph.relationships.every((relationship) => relationship.metadata.association === true)).toBe(true);
    const cdp = clusters.find((component) => component.technology === "CDP");
    expect(cdp?.properties.management?.value).toEqual({ password: REDACTED, endpoint: `https://${REDACTED}:${REDACTED}@example.test` });
    expect(nodes.find((node) => node.technology === "CDP")?.evidence[0]).toMatchObject({
      path: "architecture/infra.yml", location: "document[0].infrastructure.clusters[0].nodes[0]"
    });
  });

  it("loads JSON namespace quotas and keeps an edited MongoDB instance's identity", () => {
    const inventory = (cpu: number) => ({
      infrastructure: {
        clusters: [{
          name: "east", platform: "Kubernetes", environment: "PRODUCTION",
          namespaces: [{ name: "orders", quotas: [{ name: "compute", properties: { "limits.cpu": "8", "limits.memory": "32Gi" } }] }]
        }],
        mongoInstances: [{ name: "mongo-orders", properties: { cpu, memoryGiB: 64 } }]
      }
    });
    const build = (cpu: number) => new GraphBuilder().build(project(), registry.parse(
      "architecture/infra.json", JSON.stringify(inventory(cpu)), { environment: "STAGING" }
    ).artifacts);
    const initial = build(8);
    const edited = build(16);
    const mongo = initial.components.find((component) => component.type === "mongodb-instance");
    expect(mongo).toMatchObject({ technology: "MongoDB", environment: "STAGING" });
    expect(edited.components.find((component) => component.id === mongo?.id)?.properties.cpu?.value).toBe(16);
    const namespace = initial.components.find((component) => component.type === "kubernetes-namespace");
    const quota = initial.components.find((component) => component.type === "resource-quota");
    expect(quota).toMatchObject({ environment: "PRODUCTION", infrastructureParentId: namespace?.id });
    expect(quota?.properties["limits.memory"]?.value).toBe("32Gi");
  });

  it("uses declared Kubernetes node facts and quota limits from local kubectl exports", () => {
    const content = JSON.stringify({
      kind: "List",
      apiVersion: "v1",
      metadata: { annotations: { "data-architecture-mapper/cluster": "east", "data-architecture-mapper/environment": "PRODUCTION" } },
      items: [
        {
          kind: "Node",
          metadata: { name: "worker-a", labels: { "node-role.kubernetes.io/worker": "" } },
          status: {
            capacity: { cpu: "16", memory: "64Gi" },
            allocatable: { cpu: "15400m", memory: "60Gi" },
            nodeInfo: { kubeletVersion: "v1.31.4", architecture: "amd64", osImage: "RHEL 9.4", machineID: "ignored" }
          }
        },
        { kind: "Namespace", metadata: { name: "orders" }, status: { phase: "Active" } },
        {
          kind: "ResourceQuota",
          metadata: { name: "compute", namespace: "orders" },
          spec: { hard: { "requests.cpu": "4", "limits.memory": "8Gi" } },
          status: { used: { "requests.cpu": "2" } }
        },
        { kind: "Pod", metadata: { name: "ignored" } }
      ]
    });
    const result = registry.parse("architecture/staged.json", content);
    const graph = new GraphBuilder().build(project(), result.artifacts);
    expect(graph.components).toHaveLength(4);
    const cluster = graph.components.find((component) => component.type === "infrastructure-cluster");
    const node = graph.components.find((component) => component.type === "cluster-node");
    const namespace = graph.components.find((component) => component.type === "kubernetes-namespace");
    const quota = graph.components.find((component) => component.type === "resource-quota");
    expect(cluster).toMatchObject({ name: "east", environment: "PRODUCTION" });
    expect(node?.infrastructureParentId).toBe(cluster?.id);
    expect(node?.properties.capacity?.value).toEqual({ cpu: "16", memory: "64Gi" });
    expect(node?.properties.allocatable?.value).toEqual({ cpu: "15400m", memory: "60Gi" });
    expect(node?.properties.roles?.value).toEqual(["worker"]);
    expect(node?.properties.kubeletVersion?.value).toBe("v1.31.4");
    expect(node?.properties.osImage?.value).toBe("RHEL 9.4");
    expect(node?.properties.machineID).toBeUndefined();
    expect(namespace?.properties.phase?.value).toBe("Active");
    expect(quota?.properties["requests.cpu"]?.value).toBe("4");
    expect(quota?.properties["limits.memory"]?.value).toBe("8Gi");
    expect(quota?.properties.used).toBeUndefined();
    expect(quota?.infrastructureParentId).toBe(namespace?.id);
  });

  it("leaves unannotated Kubernetes nodes unassociated and scoped to the export file", () => {
    const content = `
apiVersion: v1
kind: NodeList
items:
  - metadata:
      name: worker
    status:
      capacity:
        memory: 8Gi
`;
    const exports = ["architecture/a.yaml", "architecture/b.yaml"];
    const artifacts = exports.flatMap((path) => registry.parse(path, content, { environment: "DEV", clusterAlias: "primary" }).artifacts);
    const graph = new GraphBuilder().build(project(), artifacts);
    expect(graph.components).toHaveLength(2);
    expect(graph.components.every((component) => component.type === "cluster-node" && !component.infrastructureParentId)).toBe(true);
    expect(graph.relationships).toHaveLength(0);
  });
});
