import type {
  ArchitectureComponent,
  ArchitectureGraph,
  ArchitectureRelationship,
  ComponentType,
  InfrastructureComponentType,
  ParseDiagnostic,
  ParsedArtifact,
  ProjectConfig,
  ProvenancedValue,
  RelationshipType,
  SourceEvidence,
  SubprojectConfig
} from "../model/types";
import { subprojectForPath } from "../discovery/subprojects";
import { componentId, relationshipId } from "../model/ids";
import { asNumber, asString, firstDefined, stringList } from "../utils/objects";
import { mongoEndpoint } from "./mongo-address";

const CONNECTOR_INPUT_KEYS = ["topics", "kafka.topic", "source.topic", "input.topics"];
const CONNECTOR_REGEX_KEYS = ["topics.regex", "topic.regex"];
const CONNECTOR_CLASS_KEYS = ["connector.class", "connectorClass", "class"];
const BOOTSTRAP_KEYS = [
  "bootstrap.servers",
  "kafka.bootstrap.servers",
  "spring.kafka.bootstrap-servers",
  "spring.kafka.bootstrap.servers",
  "producer.override.bootstrap.servers",
  "consumer.override.bootstrap.servers"
];

export class GraphBuilder {
  private components = new Map<string, ArchitectureComponent>();
  private relationships = new Map<string, ArchitectureRelationship>();
  private subprojectsByPath = new Map<string, SubprojectConfig | undefined>();
  private mongoDatabaseEndpoints = new Map<string, string>();

  build(project: ProjectConfig, artifacts: ParsedArtifact[], diagnostics: ParseDiagnostic[] = []): ArchitectureGraph {
    this.components = new Map();
    this.relationships = new Map();
    this.subprojectsByPath = new Map();
    this.mongoDatabaseEndpoints = new Map();
    const sorted = [...artifacts].sort((a, b) =>
      `${a.evidence.path}|${a.kind}|${a.name}`.localeCompare(`${b.evidence.path}|${b.kind}|${b.name}`)
    );
    for (const artifact of sorted) {
      const path = artifact.evidence.path;
      if (project.subprojects?.length && !this.subprojectsByPath.has(path)) {
        this.subprojectsByPath.set(path, subprojectForPath(project, path));
      }
      this.addArtifact(project, artifact);
    }
    const mongoDiagnostics = this.linkMongoInstances(project, sorted);
    return {
      projectId: project.id,
      generatedAt: new Date().toISOString(),
      components: [...this.components.values()].sort((a, b) => a.id.localeCompare(b.id)),
      relationships: [...this.relationships.values()].sort((a, b) => a.id.localeCompare(b.id)),
      diagnostics: [...diagnostics, ...artifacts.flatMap((artifact) => artifact.diagnostics), ...mongoDiagnostics]
        .sort((a, b) => `${a.path}|${a.message}`.localeCompare(`${b.path}|${b.message}`))
    };
  }

  private addArtifact(project: ProjectConfig, artifact: ParsedArtifact): void {
    const environment = artifact.environment || "unknown";
    if (artifact.kind === "infrastructure") {
      this.addInfrastructure(project, artifact, environment);
      return;
    }
    const clusterName = this.resolveCluster(project, artifact);
    const cluster = this.component(project, environment, "kafka-cluster", clusterName, artifact.evidence, {
      aliases: explicit(Object.entries(project.kafkaClusterAliases).filter(([, value]) => value === clusterName).map(([key]) => key), artifact.evidence)
    }, "apache-kafka", undefined, clusterName === "unknown-cluster");

    if (artifact.kind === "connector") this.addConnector(project, artifact, environment, cluster);
    else if (artifact.kind === "topic") this.addTopic(project, artifact, environment, cluster);
    else if (artifact.kind === "application") this.addApplication(project, artifact, environment, cluster);
    else if (artifact.kind === "connect-worker") this.addWorker(project, artifact, environment, cluster);
    else if (artifact.kind === "architecture-descriptor") this.addDescriptor(project, artifact, environment, cluster);
  }

  private addInfrastructure(project: ProjectConfig, artifact: ParsedArtifact, environment: string): void {
    const entry = artifact.infrastructure;
    if (!entry) return;
    const resourceId = (type: InfrastructureComponentType, name: string, scope?: string): string =>
      infrastructureId(project.id, environment, type, artifact.technology, name, scope);
    const clusterId = entry.cluster ? resourceId("infrastructure-cluster", entry.cluster) : undefined;
    const localScope = clusterId ?? `source:${artifact.evidence.path}`;
    const parentId = entry.type === "cft-service" && entry.edgeNode
      ? resourceId("edge-node", entry.edgeNode, localScope)
      : entry.type === "resource-quota" && entry.namespace
        ? resourceId("kubernetes-namespace", entry.namespace, localScope)
        : clusterId;
    const standalone = entry.type === "infrastructure-cluster" || entry.type === "mongodb-instance";
    const id = resourceId(entry.type, artifact.name, standalone ? undefined : parentId ?? localScope);
    this.component(project, environment, entry.type, artifact.name, artifact.evidence,
      properties(artifact.config, artifact.evidence), artifact.technology, undefined, false, { id, parentId });
    if (parentId) {
      this.relation(project, environment, id, parentId, entry.type === "cft-service" ? "HOSTED_ON" : "BELONGS_TO",
        artifact.evidence, { association: true });
    }
  }

  private linkMongoInstances(project: ProjectConfig, artifacts: ParsedArtifact[]): ParseDiagnostic[] {
    const instances = [...this.components.values()].filter((component) => component.type === "mongodb-instance");
    if (!instances.length) return [];
    const diagnostics: ParseDiagnostic[] = [];
    const targets = [...this.components.values()].filter((component) =>
      component.type === "application" || component.type === "kafka-connector"
    );
    const explicit = new Set<string>();
    // Compare original inventory scopes, before shared instances gain memberships through workload links.
    const instanceScopes = new Map(instances.map((instance) => [instance.id, instance.subprojectIds ?? []]));
    for (const artifact of artifacts) {
      if (artifact.infrastructure?.type !== "mongodb-instance") continue;
      const environment = artifact.environment || "unknown";
      const instance = this.components.get(infrastructureId(project.id, environment, "mongodb-instance", artifact.technology, artifact.name));
      if (!instance) continue;
      for (const link of artifact.infrastructure.links ?? []) {
        const subproject = link.subproject
          ? findReferencedSubproject(project, link.subproject)?.id
          : this.subprojectsByPath.get(artifact.evidence.path)?.id;
        const matches = link.subproject && !subproject ? [] : targets.filter((target) =>
          target.type === link.type && target.environment === environment && target.name === link.name
            && (!subproject || target.subprojectIds?.includes(subproject))
        );
        if (matches.length === 1) {
          const target = matches[0]!;
          this.linkMongoWorkload(project, instance, target, "declared", [artifact.evidence, ...target.evidence]);
          explicit.add(target.id);
        } else {
          const reason = matches.length > 1 ? "is ambiguous" : "could not be resolved";
          diagnostics.push({ path: artifact.evidence.path, parser: artifact.evidence.parser, severity: "warning",
            message: `MongoDB link from '${instance.name}' to '${link.name}' ${reason} in ${environment}.` });
        }
      }
    }

    const instancesByEndpoint = new Map<string, ArchitectureComponent[]>();
    for (const instance of instances) {
      const endpoint = endpointForComponent(instance, "instance");
      if (!endpoint) continue;
      const key = JSON.stringify([instance.environment, endpoint]);
      const candidates = instancesByEndpoint.get(key) ?? [];
      candidates.push(instance);
      instancesByEndpoint.set(key, candidates);
    }
    const matchEndpoint = (target: ArchitectureComponent, endpoint: string): ArchitectureComponent | undefined => {
      const matches = (instancesByEndpoint.get(JSON.stringify([target.environment, endpoint])) ?? []).filter((instance) => {
        const scope = instanceScopes.get(instance.id) ?? [];
        return !scope.length || scope.some((id) => target.subprojectIds?.includes(id));
      });
      return matches.length === 1 ? matches[0] : undefined;
    };
    for (const target of targets) {
      if (explicit.has(target.id)) continue;
      const endpoint = endpointForComponent(target, target.type === "application" ? "application" : "connector");
      if (!endpoint) continue;
      const instance = matchEndpoint(target, endpoint);
      if (instance) this.linkMongoWorkload(project, instance, target, "matched-host", [...instance.evidence, ...target.evidence]);
    }
    for (const [id, endpoint] of this.mongoDatabaseEndpoints) {
      const database = this.components.get(id);
      if (!database) continue;
      const instance = matchEndpoint(database, endpoint);
      if (!instance) continue;
      database.infrastructureParentId = instance.id;
      this.linkMongoEntity(project, instance, database, "BELONGS_TO", "matched-host", [...instance.evidence, ...database.evidence]);
    }
    return diagnostics;
  }

  private linkMongoWorkload(
    project: ProjectConfig,
    instance: ArchitectureComponent,
    target: ArchitectureComponent,
    origin: "declared" | "matched-host",
    evidence: SourceEvidence[]
  ): void {
    const connectorClass = CONNECTOR_CLASS_KEYS.map((key) => asString(target.properties[key]?.value)).find(Boolean) ?? "";
    const direction = target.type === "kafka-connector" ? connectorDirection(connectorClass) : "unknown";
    const type = direction === "source" ? "READS_FROM" : direction === "sink" ? "WRITES_TO" : "USES_DATABASE";
    this.linkMongoEntity(project, instance, target, type, origin, evidence);
  }

  private linkMongoEntity(
    project: ProjectConfig,
    instance: ArchitectureComponent,
    target: ArchitectureComponent,
    type: RelationshipType,
    origin: "declared" | "matched-host",
    evidence: SourceEvidence[]
  ): void {
    const from = type === "READS_FROM" ? instance.id : target.id;
    const to = type === "READS_FROM" ? target.id : instance.id;
    for (const item of evidence) {
      this.relation(project, instance.environment, from, to, type, item, { association: true, mongoLink: origin });
    }
    if (target.subprojectIds?.length) {
      instance.subprojectIds = [...new Set([...(instance.subprojectIds ?? []), ...target.subprojectIds])].sort();
    }
  }

  private resolveCluster(project: ProjectConfig, artifact: ParsedArtifact): string {
    const raw = artifact.clusterAlias ?? asString(firstDefined(artifact.config, BOOTSTRAP_KEYS));
    if (!raw) return "unknown-cluster";
    if (project.kafkaClusterAliases[raw]) return raw;
    const alias = Object.entries(project.kafkaClusterAliases).find(([, value]) => value === raw)?.[0];
    return alias ?? raw;
  }

  private addTopic(
    project: ProjectConfig,
    artifact: ParsedArtifact,
    environment: string,
    cluster: ArchitectureComponent
  ): ArchitectureComponent {
    const topic = this.topic(project, environment, cluster, artifact.name, artifact.evidence, artifact.config);
    this.relation(project, environment, cluster.id, topic.id, "BELONGS_TO", artifact.evidence);
    return topic;
  }

  private addWorker(project: ProjectConfig, artifact: ParsedArtifact, environment: string, cluster: ArchitectureComponent): void {
    const worker = this.component(project, environment, "connect-worker", artifact.name, artifact.evidence,
      properties(artifact.config, artifact.evidence), artifact.technology);
    this.relation(project, environment, worker.id, cluster.id, "HOSTED_ON", artifact.evidence, { association: true });
  }

  private addConnector(project: ProjectConfig, artifact: ParsedArtifact, environment: string, cluster: ArchitectureComponent): void {
    const config = artifact.config;
    const connector = this.component(project, environment, "kafka-connector", artifact.name, artifact.evidence,
      properties(config, artifact.evidence), artifact.technology, cluster.id);
    this.relation(project, environment, connector.id, cluster.id, "HOSTED_ON", artifact.evidence, { association: true });

    const connectorClass = asString(firstDefined(config, CONNECTOR_CLASS_KEYS)) ?? "";
    const direction = connectorDirection(connectorClass);
    const inputTopics = CONNECTOR_INPUT_KEYS.flatMap((key) => stringList(config[key]));
    const regexTopics = CONNECTOR_REGEX_KEYS.flatMap((key) => stringList(config[key]));
    if (direction !== "source" || inputTopics.length > 0) {
      for (const name of inputTopics) {
        const topic = this.topic(project, environment, cluster, name, artifact.evidence);
        this.relation(project, environment, topic.id, connector.id, "CONSUMES", artifact.evidence);
      }
      for (const pattern of regexTopics) {
        const unresolved = this.unresolved(project, environment, `topic-regex:${pattern}`, artifact.evidence, "Kafka topic regex");
        this.relation(project, environment, unresolved.id, connector.id, "CONSUMES", artifact.evidence, { pattern }, true);
      }
    }

    if (direction === "source") {
      const source = this.connectorEndpoint(project, environment, artifact, "source");
      if (source) this.relation(project, environment, source.id, connector.id, "READS_FROM", artifact.evidence);
      const produced = producedTopics(config);
      if (produced.length === 0) {
        const dynamic = asString(firstDefined(config, ["topic.prefix", "topic.namespace.map", "topic.creation.default.partitions"]));
        if (dynamic) {
          const unresolved = this.unresolved(project, environment, `dynamic-topic:${dynamic}`, artifact.evidence, "Dynamic source topic");
          this.relation(project, environment, connector.id, unresolved.id, "PRODUCES", artifact.evidence, { expression: dynamic }, true);
        }
      }
      for (const name of produced) {
        const topic = this.topic(project, environment, cluster, name, artifact.evidence);
        this.relation(project, environment, connector.id, topic.id, "PRODUCES", artifact.evidence);
      }
    } else {
      const destination = this.connectorEndpoint(project, environment, artifact, "destination");
      if (destination) this.relation(project, environment, connector.id, destination.id, "WRITES_TO", artifact.evidence);
    }

    const dlqName = asString(firstDefined(config, ["errors.deadletterqueue.topic.name", "errors.dlq.topic.name", "dlq.topic"]));
    if (dlqName) {
      const dlq = this.component(project, environment, "dead-letter-queue", dlqName, artifact.evidence, {}, "kafka", cluster.id);
      this.relation(project, environment, connector.id, dlq.id, "ROUTES_ERRORS_TO", artifact.evidence);
    }
    this.addTransformRoutes(project, environment, cluster, connector, artifact);
  }

  private addTransformRoutes(
    project: ProjectConfig,
    environment: string,
    cluster: ArchitectureComponent,
    connector: ArchitectureComponent,
    artifact: ParsedArtifact
  ): void {
    const aliases = stringList(artifact.config.transforms);
    for (const alias of aliases) {
      const type = asString(artifact.config[`transforms.${alias}.type`]);
      const replacement = asString(firstDefined(artifact.config, [
        `transforms.${alias}.replacement`,
        `transforms.${alias}.topic.replacement`,
        `transforms.${alias}.regex.replacement`
      ]));
      if (!type) continue;
      if (replacement && !replacement.includes("$")) {
        const topic = this.topic(project, environment, cluster, replacement, artifact.evidence);
        this.relation(project, environment, connector.id, topic.id, "TRANSFORMS", artifact.evidence, { alias, type, replacement });
      } else {
        const unresolved = this.unresolved(project, environment, `smt:${alias}`, artifact.evidence, `SMT ${type}`);
        this.relation(project, environment, connector.id, unresolved.id, "TRANSFORMS", artifact.evidence,
          { alias, type, replacement: replacement ?? null }, true);
      }
    }
  }

  private connectorEndpoint(
    project: ProjectConfig,
    environment: string,
    artifact: ParsedArtifact,
    role: "source" | "destination"
  ): ArchitectureComponent | undefined {
    const config = artifact.config;
    const technology = artifact.technology;
    const evidence = artifact.evidence;
    const className = asString(firstDefined(config, CONNECTOR_CLASS_KEYS))?.toLowerCase();
    if (technology === "mongodb-kafka" || className?.includes("mongo")) {
      const database = asString(firstDefined(config, ["database", "database.name", "mongodb.database", "database.include.list"]));
      const collection = asString(firstDefined(config, ["collection", "collection.name", "mongodb.collection", "collection.include.list"]));
      if (collection || database) {
        const type = collection ? "mongodb-collection" : "database";
        const name = collection ? (database ? `${database}.${collection}` : collection) : database!;
        const address = mongoEndpoint(config, "connector");
        const identity = address ? { id: `${componentId(project.id, environment, type, name)}:mongo:${encodeURIComponent(address)}` } : undefined;
        const endpoint = this.component(project, environment, type, name, evidence,
          properties(collection ? { database, collection, role } : { role }, evidence), "mongodb", undefined, false, identity);
        if (address) this.mongoDatabaseEndpoints.set(endpoint.id, address);
        return endpoint;
      }
    }
    if (technology === "jdbc" || technology === "debezium") {
      const url = asString(firstDefined(config, ["connection.url", "database.url", "jdbc.url", "database.hostname"]));
      const table = asString(firstDefined(config, ["table.name.format", "table.include.list", "table.whitelist"]));
      if (table) return this.component(project, environment, "database-table", table, evidence, properties({ url, role }, evidence), "jdbc");
      if (url) return this.component(project, environment, "database-server", url, evidence, properties({ role }, evidence), "jdbc");
    }
    if (String(config["connector.class"] ?? "").includes("FileStream")) {
      const file = asString(config.file);
      if (file) return this.component(project, environment, "file-system", file, evidence, properties({ role }, evidence), "file-stream");
    }
    if (technology === "hdfs") {
      const path = asString(firstDefined(config, ["hdfs.url", "topics.dir", "logs.dir"]));
      if (path) return this.component(project, environment, "file-system", path, evidence, properties({ role }, evidence), "hdfs");
    }
    if (technology === "object-storage") {
      const bucket = asString(firstDefined(config, ["s3.bucket.name", "gcs.bucket.name", "azure.container.name", "bucket"]));
      if (bucket) return this.component(project, environment, "object-storage", bucket, evidence, properties({ role }, evidence), technology);
    }
    const destination = asString(firstDefined(config, [
      "connection.url", "elasticsearch.url", "database", "database.name", "url", "endpoint", "destination"
    ]));
    if (destination) {
      return this.component(project, environment, role === "source" ? "external-source" : "external-destination",
        destination, evidence, properties({ role }, evidence), technology);
    }
    return undefined;
  }

  private addApplication(project: ProjectConfig, artifact: ParsedArtifact, environment: string, cluster: ArchitectureComponent): void {
    const app = this.component(project, environment, "application", artifact.name, artifact.evidence,
      properties(artifact.config, artifact.evidence), artifact.technology, cluster.id);
    this.relation(project, environment, app.id, cluster.id, "HOSTED_ON", artifact.evidence, { association: true });
    const bindings = applicationBindings(artifact.config);
    for (const name of bindings.inputs) {
      const topic = this.topic(project, environment, cluster, name, artifact.evidence);
      this.relation(project, environment, topic.id, app.id, "CONSUMES", artifact.evidence);
    }
    for (const name of bindings.outputs) {
      const topic = this.topic(project, environment, cluster, name, artifact.evidence);
      this.relation(project, environment, app.id, topic.id, "PRODUCES", artifact.evidence);
    }
    const group = asString(firstDefined(artifact.config, [
      "spring.kafka.consumer.group-id", "kafka.consumer.group.id", "group.id", "KAFKA_GROUP_ID"
    ]));
    if (group) {
      const consumerGroup = this.component(project, environment, "consumer-group", group, artifact.evidence, {}, "kafka", cluster.id);
      this.relation(project, environment, app.id, consumerGroup.id, "BELONGS_TO", artifact.evidence, { association: true });
    }
  }

  private addDescriptor(project: ProjectConfig, artifact: ParsedArtifact, environment: string, cluster: ArchitectureComponent): void {
    const rawComponents = Array.isArray(artifact.config.components) ? artifact.config.components : [];
    const localIds = new Map<string, string>();
    for (const value of rawComponents) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      const name = asString(entry.name);
      const type = normalizeComponentType(asString(entry.type));
      if (!name || !type) continue;
      const component = type === "kafka-topic"
        ? this.topic(project, environment, cluster, name, artifact.evidence, entry.properties as Record<string, unknown> | undefined)
        : this.component(project, environment, type, name, artifact.evidence,
          properties((entry.properties as Record<string, unknown>) ?? {}, artifact.evidence), asString(entry.technology));
      localIds.set(asString(entry.id) ?? name, component.id);
    }
    const rawRelationships = Array.isArray(artifact.config.relationships) ? artifact.config.relationships : [];
    for (const value of rawRelationships) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      const from = localIds.get(asString(entry.from) ?? "");
      const to = localIds.get(asString(entry.to) ?? "");
      const type = normalizeRelationshipType(asString(entry.type));
      if (from && to && type) this.relation(project, environment, from, to, type, artifact.evidence, { descriptor: true });
    }
  }

  private topic(
    project: ProjectConfig,
    environment: string,
    cluster: ArchitectureComponent,
    name: string,
    evidence: SourceEvidence,
    config: Record<string, unknown> = {}
  ): ArchitectureComponent {
    return this.component(project, environment, "kafka-topic", name, evidence, properties(config, evidence), "apache-kafka", cluster.id,
      name.includes("${") || name.includes("*") || name.includes("("));
  }

  private unresolved(project: ProjectConfig, environment: string, name: string, evidence: SourceEvidence, label: string): ArchitectureComponent {
    return this.component(project, environment, "unresolved-dependency", name, evidence,
      { reason: explicit(label, evidence) }, "unresolved", undefined, true);
  }

  private component(
    project: ProjectConfig,
    environment: string,
    type: ComponentType,
    name: string,
    evidence: SourceEvidence,
    componentProperties: Record<string, ProvenancedValue> = {},
    technology?: string,
    scope?: string,
    unresolved = false,
    infrastructure?: { id: string; parentId?: string }
  ): ArchitectureComponent {
    const subproject = this.subprojectsByPath.get(evidence.path);
    const baseId = componentId(project.id, environment, type, name, scope);
    const appSubproject = type === "application" ? subproject : undefined;
    const id = infrastructure?.id ?? (appSubproject ? `${baseId}:subproject:${encodeURIComponent(appSubproject.id)}` : baseId);
    const existing = this.components.get(id);
    if (existing) {
      existing.evidence = mergeEvidence(existing.evidence, [evidence]);
      existing.properties = mergeProperties(existing.properties, componentProperties, evidence);
      existing.tags = [...new Set([...existing.tags, technology ?? ""])].filter(Boolean).sort();
      existing.unresolved = existing.unresolved && unresolved;
      if (subproject && !existing.subprojectIds?.includes(subproject.id)) {
        existing.subprojectIds = [...(existing.subprojectIds ?? []), subproject.id].sort();
      }
      return existing;
    }
    const created: ArchitectureComponent = {
      id,
      projectId: project.id,
      environment,
      type,
      name,
      label: appSubproject ? `${name} · ${appSubproject.name}` : name,
      technology,
      kafkaClusterId: scope,
      properties: componentProperties,
      evidence: [evidence],
      tags: technology ? [technology] : [],
      unresolved,
      ...(infrastructure?.parentId ? { infrastructureParentId: infrastructure.parentId } : {}),
      ...(subproject ? { subprojectIds: [subproject.id] } : {})
    };
    this.components.set(id, created);
    return created;
  }

  private relation(
    project: ProjectConfig,
    environment: string,
    from: string,
    to: string,
    type: RelationshipType,
    evidence: SourceEvidence,
    metadata: Record<string, unknown> = {},
    unresolved = false
  ): void {
    const id = relationshipId(from, type, to);
    const existing = this.relationships.get(id);
    if (existing) {
      existing.evidence = mergeEvidence(existing.evidence, [evidence]);
      existing.metadata = { ...existing.metadata, ...metadata };
      existing.unresolved = existing.unresolved && unresolved;
      return;
    }
    this.relationships.set(id, { id, projectId: project.id, environment, from, to, type, evidence: [evidence], metadata, unresolved });
  }
}

function properties(config: Record<string, unknown>, evidence: SourceEvidence): Record<string, ProvenancedValue> {
  return Object.fromEntries(
    Object.entries(config)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, explicit(value, evidence)])
  );
}

function infrastructureId(
  projectId: string, environment: string, type: InfrastructureComponentType, technology: string, name: string, scope?: string
): string {
  const platform = technology.toLowerCase() === "k8s" ? "kubernetes" : technology.toLowerCase();
  const base = componentId(projectId, environment, type, "inventory");
  return [base, ...[platform, ...(scope ? [scope] : []), name].map(encodeURIComponent)].join(":");
}

function findReferencedSubproject(project: ProjectConfig, reference: string): SubprojectConfig | undefined {
  const subprojects = project.subprojects ?? [];
  const id = subprojects.find((subproject) => subproject.id === reference);
  if (id) return id;
  const matches = subprojects.filter((subproject) => subproject.name === reference || subproject.folder === reference);
  return matches.length === 1 ? matches[0] : undefined;
}

function endpointForComponent(component: ArchitectureComponent, source: Parameters<typeof mongoEndpoint>[1]): string | undefined {
  if (component.properties._conflicts) return undefined;
  const values = Object.fromEntries(Object.entries(component.properties).map(([key, property]) => [key, property.value]));
  return mongoEndpoint(values, source);
}

function explicit(value: unknown, evidence: SourceEvidence): ProvenancedValue {
  return { value, origin: "explicit", evidence: [evidence] };
}

function mergeProperties(
  current: Record<string, ProvenancedValue>,
  next: Record<string, ProvenancedValue>,
  evidence: SourceEvidence
): Record<string, ProvenancedValue> {
  const merged = new Map(Object.entries(current));
  const beforeConflicts = current._conflicts?.value;
  const conflicts = new Map<string, unknown>(beforeConflicts !== null && typeof beforeConflicts === "object"
    ? Object.entries(beforeConflicts) : []);
  for (const [key, value] of Object.entries(next)) {
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, value);
      continue;
    }
    const before = JSON.stringify(existing.value);
    const after = JSON.stringify(value.value);
    if (before !== after) {
      conflicts.set(key, [before, after].map((serialized) => {
        const decoded: unknown = serialized === undefined ? undefined : JSON.parse(serialized);
        return decoded;
      }));
    }
    existing.evidence = mergeEvidence(existing.evidence, value.evidence);
  }
  if (conflicts.size) merged.set("_conflicts", { value: Object.fromEntries(conflicts), origin: "inferred", evidence: [evidence] });
  return Object.fromEntries([...merged].sort(([a], [b]) => a.localeCompare(b)));
}

function mergeEvidence(a: SourceEvidence[], b: SourceEvidence[]): SourceEvidence[] {
  const byKey = new Map<string, SourceEvidence>();
  for (const evidence of [...a, ...b]) byKey.set(`${evidence.path}|${evidence.parser}|${evidence.location ?? ""}`, evidence);
  return [...byKey.values()].sort((left, right) => `${left.path}|${left.parser}`.localeCompare(`${right.path}|${right.parser}`));
}

function connectorDirection(connectorClass: string): "source" | "sink" | "unknown" {
  const value = connectorClass.toLowerCase();
  if (value.includes("source") || value.includes("debezium")) return "source";
  if (value.includes("sink")) return "sink";
  return "unknown";
}

function producedTopics(config: Record<string, unknown>): string[] {
  return [...new Set([
    ...stringList(firstDefined(config, ["output.topics", "topic", "topic.name"])),
    ...stringList(config["topic.prefix"]).filter((topic) => !topic.includes("${"))
  ])].sort();
}

function applicationBindings(config: Record<string, unknown>): { inputs: string[]; outputs: string[] } {
  const inputs = new Set<string>();
  const outputs = new Set<string>();
  for (const [key, value] of Object.entries(config)) {
    const topics = stringList(value);
    if (/spring\.cloud\.stream\.bindings\.[^.]*?(?:input|in|consumer)[^.]*\.destination/i.test(key)
      || /(?:input|consumer|incoming)(?:\.|_|-).*topics?/i.test(key)
      || /mp\.messaging\.incoming\.[^.]+\.topic/i.test(key)) topics.forEach((topic) => inputs.add(topic));
    if (/spring\.cloud\.stream\.bindings\.[^.]*?(?:output|out|producer)[^.]*\.destination/i.test(key)
      || /(?:output|producer|outgoing)(?:\.|_|-).*topics?/i.test(key)
      || /mp\.messaging\.outgoing\.[^.]+\.topic/i.test(key)) topics.forEach((topic) => outputs.add(topic));
  }
  stringList(firstDefined(config, ["spring.kafka.consumer.topics", "kafka.input.topics", "KAFKA_INPUT_TOPICS"]))
    .forEach((topic) => inputs.add(topic));
  stringList(firstDefined(config, ["spring.kafka.producer.topics", "kafka.output.topics", "KAFKA_OUTPUT_TOPICS"]))
    .forEach((topic) => outputs.add(topic));
  return { inputs: [...inputs].sort(), outputs: [...outputs].sort() };
}

function normalizeComponentType(value: string | undefined): ComponentType | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/[_ ]+/g, "-") as ComponentType;
  const supported: ComponentType[] = [
    "application", "kafka-cluster", "kafka-topic", "connect-worker", "kafka-connector", "consumer-group",
    "database-server", "database", "mongodb-collection", "database-table", "schema-registry", "object-storage",
    "file-system", "external-source", "external-destination", "dead-letter-queue", "unresolved-dependency"
  ];
  return supported.includes(normalized) ? normalized : undefined;
}

function normalizeRelationshipType(value: string | undefined): RelationshipType | undefined {
  if (!value) return undefined;
  const normalized = value.toUpperCase().replace(/[ -]+/g, "_") as RelationshipType;
  const supported: RelationshipType[] = [
    "READS_FROM", "WRITES_TO", "CONSUMES", "PRODUCES", "HOSTED_ON", "BELONGS_TO", "REPLICATES_TO",
    "USES_SCHEMA", "USES_DATABASE", "ROUTES_ERRORS_TO", "TRANSFORMS"
  ];
  return supported.includes(normalized) ? normalized : undefined;
}

export function topicPartitionCount(component: ArchitectureComponent): number | undefined {
  return asNumber(component.properties.partitions?.value ?? component.properties["topic.partitions"]?.value);
}
