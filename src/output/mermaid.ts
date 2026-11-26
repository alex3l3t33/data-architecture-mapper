import type { ArchitectureComponent, ArchitectureGraph, ArchitectureRelationship, ComponentType } from "../model/types";
import { deterministicId, slug } from "../model/ids";
import { DATABASE_TYPES, databaseWorkloads } from "../graph/database-workloads";

export interface MermaidOptions {
  direction?: "LR" | "TB";
  environment?: string;
  kafkaClusterId?: string;
  componentIds?: Set<string>;
  includeAssociations?: boolean;
  groupByScope?: boolean;
}

export interface EnvironmentMermaidDiagram {
  environment: string;
  connectorCount: number;
  mermaid: string;
}

const DEFAULT_ENVIRONMENT_ORDER = ["DEV", "STAGING", "PRODUCTION"];

export class MermaidGenerator {
  generateConnectorDiagrams(
    graph: ArchitectureGraph,
    connectorIds: ReadonlySet<string>,
    direction: "LR" | "TB" = "LR",
    environmentOrder: readonly string[] = []
  ): EnvironmentMermaidDiagram[] {
    const connectors = graph.components.filter((component) =>
      component.type === "kafka-connector" && connectorIds.has(component.id)
    );
    const connectorsByEnvironment = groupBy(connectors, (connector) => connector.environment);
    const componentsByEnvironment = groupBy(graph.components, (component) => component.environment);
    const relationshipsByEnvironment = groupBy(graph.relationships, (relationship) => relationship.environment);
    const rank = (environment: string): number => {
      const requested = environmentOrder.indexOf(environment);
      if (requested !== -1) return requested;
      const fallback = DEFAULT_ENVIRONMENT_ORDER.indexOf(environment.toUpperCase());
      return environmentOrder.length + (fallback === -1 ? DEFAULT_ENVIRONMENT_ORDER.length : fallback);
    };
    return [...connectorsByEnvironment.entries()]
      .sort(([left], [right]) => rank(left) - rank(right) || left.localeCompare(right))
      .map(([environment, environmentConnectors]) => ({
        environment,
        connectorCount: environmentConnectors.length,
        mermaid: this.generateConnectors({
          ...graph,
          components: componentsByEnvironment.get(environment) ?? [],
          relationships: relationshipsByEnvironment.get(environment) ?? []
        }, new Set(environmentConnectors.map((connector) => connector.id)), direction)
      }));
  }

  generateConnectors(graph: ArchitectureGraph, connectorIds: ReadonlySet<string>, direction: "LR" | "TB" = "LR"): string {
    const connectors = new Set(graph.components
      .filter((component) => component.type === "kafka-connector" && connectorIds.has(component.id))
      .map((component) => component.id));
    const byId = new Map(graph.components.map((component) => [component.id, component]));
    const localEdges = graph.relationships.filter((edge) =>
      byId.get(edge.from)?.environment === edge.environment && byId.get(edge.to)?.environment === edge.environment
    );
    const directEdges = localEdges.filter((edge) =>
      edge.metadata.association !== true && (connectors.has(edge.from) || connectors.has(edge.to))
    );
    const relationships = [...new Set([
      ...directEdges,
      ...mongoWorkloadEdges({ ...graph, relationships: localEdges }, connectors, byId)
    ])];
    const componentIds = new Set([...connectors, ...relationships.flatMap((edge) => [edge.from, edge.to])]);
    const related = graph.components.filter((component) => componentIds.has(component.id));
    const environments = new Set(related.map((component) => component.environment));
    const clusters = new Set(related.flatMap((component) => component.kafkaClusterId ? [component.kafkaClusterId] : []));
    return this.generate({ ...graph, relationships }, {
      componentIds, direction, groupByScope: environments.size > 1 || clusters.size > 1, includeAssociations: true
    });
  }

  generate(graph: ArchitectureGraph, options: MermaidOptions = {}): string {
    const components = graph.components.filter((component) =>
      (!options.environment || component.environment === options.environment)
      && (!options.kafkaClusterId || component.kafkaClusterId === options.kafkaClusterId || component.id === options.kafkaClusterId)
      && (!options.componentIds || options.componentIds.has(component.id))
    );
    const included = new Set(components.map((component) => component.id));
    const edges = graph.relationships.filter((edge) =>
      included.has(edge.from) && included.has(edge.to) && (options.includeAssociations || edge.metadata.association !== true)
    );
    const lines = [`flowchart ${options.direction ?? "LR"}`];
    const byEnvironment = groupBy(components, (component) => component.environment);
    if (options.groupByScope === false) {
      for (const component of components) lines.push(`  ${nodeId(component.id)}${nodeShape(component)}`);
    } else {
      for (const [environment, environmentComponents] of [...byEnvironment.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`  subgraph env_${slug(environment)}["${escapeLabel(environment)}"]`);
        const byCluster = groupBy(environmentComponents, (component) => component.kafkaClusterId ?? "other");
        for (const [cluster, clusterComponents] of [...byCluster.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          lines.push(`    subgraph cluster_${deterministicId("g", `${environment}|${cluster}`).replace(/-/g, "_")}["${escapeLabel(clusterLabel(cluster, components))}"]`);
          for (const component of clusterComponents.sort((a, b) => a.id.localeCompare(b.id))) {
            lines.push(`      ${nodeId(component.id)}${nodeShape(component)}`);
          }
          lines.push("    end");
        }
        lines.push("  end");
      }
    }
    for (const edge of edges.sort((a, b) => a.id.localeCompare(b.id))) {
      const style = edge.unresolved || edge.metadata.association === true ? "-.->" : "-->";
      lines.push(`  ${nodeId(edge.from)} ${style}|${escapeLabel(edge.type)}| ${nodeId(edge.to)}`);
    }
    const usedClasses = new Set(components.map((component) => className(component.type)));
    const definitions = classDefinitions().filter((line) => usedClasses.has(line.trim().split(" ")[1] ?? ""));
    const defined = new Set(definitions.map((line) => line.trim().split(" ")[1]));
    lines.push(...definitions);
    for (const component of components) {
      const classId = className(component.type);
      if (defined.has(classId)) lines.push(`  class ${nodeId(component.id)} ${classId}`);
    }
    return lines.join("\n");
  }

  generatePartitions(graph: ArchitectureGraph, maxNodes = 200): Array<{ name: string; mermaid: string }> {
    if (graph.components.length <= maxNodes) return [{ name: "complete", mermaid: this.generate(graph) }];
    const environments = [...new Set(graph.components.map((component) => component.environment))].sort();
    const output: Array<{ name: string; mermaid: string }> = [];
    for (const environment of environments) {
      const environmentIds = graph.components.filter((component) => component.environment === environment).map((component) => component.id);
      if (environmentIds.length <= maxNodes) output.push({ name: environment, mermaid: this.generate(graph, { environment }) });
      else {
        const clusters = [...new Set(graph.components.filter((component) => component.environment === environment).map((component) => component.kafkaClusterId).filter(Boolean))] as string[];
        for (const cluster of clusters.sort()) output.push({
          name: `${environment}-${clusterLabel(cluster, graph.components)}`,
          mermaid: this.generate(graph, { environment, kafkaClusterId: cluster })
        });
      }
    }
    return output;
  }
}

function mongoWorkloadEdges(
  graph: ArchitectureGraph,
  connectors: ReadonlySet<string>,
  byId: ReadonlyMap<string, ArchitectureComponent>
): ArchitectureRelationship[] {
  const instances = graph.components.filter((component) => component.type === "mongodb-instance");
  if (!instances.length || !connectors.size) return [];
  const workloads = databaseWorkloads(graph);
  const selectedInstances = instances.filter((instance) =>
    workloads.get(instance.id)?.some((workload) => connectors.has(workload.id))
  );
  if (!selectedInstances.length) return [];

  const databases = new Set(graph.components
    .filter((component) => DATABASE_TYPES.has(component.type) && !component.unresolved)
    .map((component) => component.id));
  const valid = graph.relationships.filter((edge) => !edge.unresolved && !byId.get(edge.from)?.unresolved && !byId.get(edge.to)?.unresolved);
  const hierarchy = valid.filter((edge) =>
    databases.has(edge.from) && databases.has(edge.to) && (edge.type === "BELONGS_TO" || edge.type === "HOSTED_ON")
  );
  const children = groupBy(hierarchy, (edge) => edge.to);
  const parents = groupBy(hierarchy, (edge) => edge.from);
  const databaseIds = new Set(selectedInstances.map((instance) => instance.id));
  for (const id of databaseIds) {
    for (const child of children.get(id) ?? []) databaseIds.add(child.from);
  }

  const usedDatabases = new Set<string>();
  const workloadEdges = valid.filter((edge) => {
    if (edge.type !== "READS_FROM" && edge.type !== "WRITES_TO" && edge.type !== "USES_DATABASE") return false;
    const [database, workload] = databaseIds.has(edge.from) ? [edge.from, edge.to] : [edge.to, edge.from];
    if (!databaseIds.has(database) || (!connectors.has(workload) && byId.get(workload)?.type !== "application")) return false;
    usedDatabases.add(database);
    return true;
  });
  const hierarchyEdges = new Set<ArchitectureRelationship>();
  // Keep the original path from each workload's database or collection to its instance.
  for (const id of usedDatabases) {
    for (const parent of parents.get(id) ?? []) {
      if (!databaseIds.has(parent.to)) continue;
      hierarchyEdges.add(parent);
      usedDatabases.add(parent.to);
    }
  }
  return [...workloadEdges, ...hierarchyEdges];
}

function nodeId(id: string): string {
  return deterministicId("n", id).replace(/-/g, "_");
}

function nodeShape(component: ArchitectureComponent): string {
  const label = escapeLabel(component.label);
  if (component.type === "kafka-topic") return `(("${label}"))`;
  if (component.type === "kafka-connector") return `{{"${label}"}}`;
  if (DATABASE_TYPES.has(component.type)) return `[("${label}")]`;
  if (component.type === "application") return `["${label}"]`;
  if (component.unresolved) return `>"${label}"]`;
  return `[["${label}"]]`;
}

function escapeLabel(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "#quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\r\n]+/g, " ");
}

function className(type: ComponentType): string {
  return `type_${type.replace(/-/g, "_")}`;
}

function classDefinitions(): string[] {
  return [
    "  classDef type_application fill:#4f7cac,color:#fff,stroke:#315b7d",
    "  classDef type_kafka_topic fill:#f3b61f,color:#17202a,stroke:#b58100",
    "  classDef type_kafka_connector fill:#8e6cbd,color:#fff,stroke:#62478a",
    "  classDef type_kafka_cluster fill:#e8eef7,color:#17202a,stroke:#58718f",
    "  classDef type_dead_letter_queue fill:#fce7f3,color:#831843,stroke:#db2777",
    "  classDef type_file_system fill:#e2e8f0,color:#1e293b,stroke:#8296b5",
    "  classDef type_database fill:#2a9d8f,color:#fff,stroke:#1c6f65",
    "  classDef type_database_server fill:#2a9d8f,color:#fff,stroke:#1c6f65",
    "  classDef type_database_table fill:#2a9d8f,color:#fff,stroke:#1c6f65",
    "  classDef type_mongodb_collection fill:#38a169,color:#fff,stroke:#247a4a",
    "  classDef type_mongodb_instance fill:#237a57,color:#fff,stroke:#14553a,stroke-width:2px",
    "  classDef type_external_source fill:#64748b,color:#fff,stroke:#475569",
    "  classDef type_external_destination fill:#64748b,color:#fff,stroke:#475569",
    "  classDef type_unresolved_dependency fill:#fff1f2,color:#991b1b,stroke:#e11d48,stroke-dasharray: 5 5"
  ];
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const output = new Map<string, T[]>();
  for (const item of items) {
    const groupKey = key(item);
    const group = output.get(groupKey);
    if (group) group.push(item);
    else output.set(groupKey, [item]);
  }
  return output;
}

function clusterLabel(id: string, components: ArchitectureComponent[]): string {
  if (id === "other") return "Other components";
  return components.find((component) => component.id === id)?.label ?? id.split(":").pop() ?? id;
}
