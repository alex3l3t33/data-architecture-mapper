import { deterministicId } from "../model/ids";
import type {
  ArchitectureComponent,
  ArchitectureGraph,
  FindingSeverity,
  ProjectConfig,
  SourceEvidence,
  ValidationFinding
} from "../model/types";
import { asNumber, asString, firstDefined } from "../utils/objects";
import { LineageAnalyzer } from "../graph/lineage";
import { topicPartitionCount } from "../graph/builder";

export class ValidationEngine {
  validate(graph: ArchitectureGraph, project: ProjectConfig): ValidationFinding[] {
    const findings: ValidationFinding[] = [];
    const add = (finding: Omit<ValidationFinding, "id">): void => {
      const override = project.validation.severityOverrides?.[finding.ruleId];
      if (override === "off") return;
      findings.push({
        ...finding,
        severity: override ?? finding.severity,
        id: deterministicId(finding.ruleId, `${finding.affectedComponentIds.sort().join("|")}|${finding.explanation}`)
      });
    };

    this.invalidSyntax(graph, add);
    this.missingTopicInventory(graph, add);
    this.conflictingDefinitions(graph, add);
    this.unknownClusters(graph, project, add);
    this.missingDestinations(graph, add);
    this.unresolvedReferences(graph, add);
    this.cycles(graph, add);
    this.orphanTopics(graph, add);
    this.partitionCapacity(graph, add);
    this.replicationPolicy(graph, project, add);
    this.serialization(graph, add);
    this.dlqPolicy(graph, project, add);
    this.databaseWriters(graph, add);
    return findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.ruleId.localeCompare(b.ruleId) || a.id.localeCompare(b.id));
  }

  private invalidSyntax(graph: ArchitectureGraph, add: FindingAdder): void {
    for (const diagnostic of graph.diagnostics.filter((entry) => entry.severity === "error")) {
      add({
        ruleId: "invalid-configuration-syntax",
        severity: "error",
        confidence: "high",
        affectedComponentIds: [],
        explanation: `${diagnostic.path}: ${diagnostic.message}`,
        evidence: [{ path: diagnostic.path, parser: diagnostic.parser }],
        recommendation: "Correct the configuration syntax and refresh the project."
      });
    }
  }

  private missingTopicInventory(graph: ArchitectureGraph, add: FindingAdder): void {
    for (const topic of graph.components.filter((component) => component.type === "kafka-topic")) {
      const explicitlyDefined = topic.evidence.some((evidence) => evidence.parser === "kafka-topic" || evidence.parser === "architecture-descriptor");
      if (!explicitlyDefined) add({
        ruleId: "referenced-topic-not-in-inventory",
        severity: "warning",
        confidence: "medium",
        affectedComponentIds: [topic.id],
        explanation: `Topic ${topic.name} is referenced, but no topic definition was discovered. This may reflect incomplete inventory rather than missing infrastructure.`,
        evidence: topic.evidence,
        recommendation: "Add the topic definition or an architecture descriptor if the topic is managed outside this project."
      });
    }
  }

  private conflictingDefinitions(graph: ArchitectureGraph, add: FindingAdder): void {
    for (const component of graph.components) {
      const conflicts = component.properties._conflicts?.value as Record<string, unknown> | undefined;
      if (conflicts && Object.keys(conflicts).length > 0) add({
        ruleId: "conflicting-component-definitions",
        severity: "error",
        confidence: "high",
        affectedComponentIds: [component.id],
        explanation: `${component.label} has conflicting explicit values for: ${Object.keys(conflicts).sort().join(", ")}.`,
        evidence: component.evidence,
        recommendation: "Reconcile the source definitions or map them to distinct environments or clusters."
      });
    }
  }

  private unknownClusters(graph: ArchitectureGraph, project: ProjectConfig, add: FindingAdder): void {
    const known = new Set(project.validation.knownKafkaClusters ?? Object.keys(project.kafkaClusterAliases));
    for (const cluster of graph.components.filter((component) => component.type === "kafka-cluster")) {
      if (cluster.name === "unknown-cluster" || known.size > 0 && !known.has(cluster.name)) add({
        ruleId: "unknown-kafka-cluster",
        severity: "warning",
        confidence: cluster.name === "unknown-cluster" ? "high" : "medium",
        affectedComponentIds: [cluster.id],
        explanation: cluster.name === "unknown-cluster"
          ? "A Kafka cluster reference could not be resolved from the available configuration."
          : `Kafka cluster ${cluster.name} is not in the project's known cluster policy.`,
        evidence: cluster.evidence,
        recommendation: "Configure a Kafka cluster alias or add the cluster to the validation policy."
      });
    }
  }

  private missingDestinations(graph: ArchitectureGraph, add: FindingAdder): void {
    for (const connector of graph.components.filter((component) => component.type === "kafka-connector")) {
      const connectorClass = asString(firstDefined(values(connector), ["connector.class", "connectorClass", "class"]))?.toLowerCase() ?? "";
      if (!connectorClass.includes("sink")) continue;
      const hasDestination = graph.relationships.some((relationship) => relationship.from === connector.id && relationship.type === "WRITES_TO");
      if (!hasDestination) add({
        ruleId: "missing-connector-destination",
        severity: "error",
        confidence: "high",
        affectedComponentIds: [connector.id],
        explanation: `Sink connector ${connector.name} has no discoverable destination.`,
        evidence: connector.evidence,
        recommendation: "Add the connector-specific destination property or describe it in an architecture descriptor."
      });
    }
  }

  private unresolvedReferences(graph: ArchitectureGraph, add: FindingAdder): void {
    for (const component of graph.components.filter((entry) => entry.unresolved)) add({
      ruleId: "unresolved-configuration-reference",
      severity: "warning",
      confidence: "high",
      affectedComponentIds: [component.id],
      explanation: `${component.label} cannot be statically resolved from the scanned files.`,
      evidence: component.evidence,
      recommendation: "Provide an explicit value, a safe architecture descriptor, or leave this documented as a runtime-resolved dependency."
    });
  }

  private cycles(graph: ArchitectureGraph, add: FindingAdder): void {
    const analyzer = new LineageAnalyzer(graph);
    const byId = new Map(graph.components.map((component) => [component.id, component]));
    for (const cycle of analyzer.stronglyConnectedComponents()) {
      const clusters = new Set(cycle.map((id) => byId.get(id)?.kafkaClusterId).filter(Boolean));
      add({
        ruleId: clusters.size > 1 ? "potential-cross-cluster-feedback-loop" : "potential-circular-dependency",
        severity: clusters.size > 1 ? "error" : "warning",
        confidence: "medium",
        affectedComponentIds: cycle,
        explanation: `Architectural reachability forms a cycle across ${cycle.length} components. This does not prove a runtime feedback loop.`,
        evidence: evidenceFor(cycle, byId),
        recommendation: "Review routing, filtering, and runtime safeguards for intentional or accidental feedback."
      });
    }
  }

  private orphanTopics(graph: ArchitectureGraph, add: FindingAdder): void {
    for (const topic of graph.components.filter((component) => component.type === "kafka-topic")) {
      const hasProducer = graph.relationships.some((relationship) => relationship.to === topic.id && ["PRODUCES", "TRANSFORMS"].includes(relationship.type));
      const hasConsumer = graph.relationships.some((relationship) => relationship.from === topic.id && relationship.type === "CONSUMES");
      if (!hasProducer || !hasConsumer) add({
        ruleId: !hasProducer ? "topic-without-known-producer" : "topic-without-known-consumer",
        severity: "info",
        confidence: "low",
        affectedComponentIds: [topic.id],
        explanation: `No known ${!hasProducer ? "producer" : "consumer"} was discovered for ${topic.name}; the scanned inventory may be incomplete.`,
        evidence: topic.evidence,
        recommendation: "Add missing application or connector configuration, or accept this as an intentional boundary topic."
      });
    }
  }

  private partitionCapacity(graph: ArchitectureGraph, add: FindingAdder): void {
    const byId = new Map(graph.components.map((component) => [component.id, component]));
    for (const connector of graph.components.filter((component) => component.type === "kafka-connector")) {
      const tasks = asNumber(connector.properties["tasks.max"]?.value);
      if (tasks === undefined) continue;
      const inputs = graph.relationships
        .filter((relationship) => relationship.to === connector.id && relationship.type === "CONSUMES")
        .map((relationship) => byId.get(relationship.from))
        .filter((component): component is ArchitectureComponent => Boolean(component));
      const partitionCounts = inputs.map(topicPartitionCount);
      if (inputs.length > 0 && partitionCounts.every((count) => count !== undefined)) {
        const total = partitionCounts.reduce((sum, count) => sum + (count ?? 0), 0);
        if (tasks > total) add({
          ruleId: "connector-tasks-exceed-input-partitions",
          severity: "warning",
          confidence: "high",
          affectedComponentIds: [connector.id, ...inputs.map((input) => input.id)],
          explanation: `${connector.name} configures ${tasks} tasks for ${total} known input partitions. Extra tasks may remain idle.`,
          evidence: [...connector.evidence, ...inputs.flatMap((input) => input.evidence)],
          recommendation: "Align tasks.max with available partitions unless idle task capacity is intentional."
        });
      }
    }
  }

  private replicationPolicy(graph: ArchitectureGraph, project: ProjectConfig, add: FindingAdder): void {
    const minimum = project.validation.minimumReplicationFactor;
    if (minimum === undefined) return;
    for (const topic of graph.components.filter((component) => component.type === "kafka-topic")) {
      const actual = asNumber(topic.properties.replicas?.value ?? topic.properties["replication.factor"]?.value);
      if (actual !== undefined && actual < minimum) add({
        ruleId: "replication-factor-below-policy",
        severity: "error",
        confidence: "high",
        affectedComponentIds: [topic.id],
        explanation: `${topic.name} has replication factor ${actual}; policy requires at least ${minimum}.`,
        evidence: topic.evidence,
        recommendation: `Raise the replication factor to ${minimum} or document an environment-specific exception.`
      });
    }
  }

  private serialization(graph: ArchitectureGraph, add: FindingAdder): void {
    const byId = new Map(graph.components.map((component) => [component.id, component]));
    for (const topic of graph.components.filter((component) => component.type === "kafka-topic")) {
      const adjacent = graph.relationships
        .filter((edge) => edge.from === topic.id || edge.to === topic.id)
        .map((edge) => byId.get(edge.from === topic.id ? edge.to : edge.from))
        .filter((component): component is ArchitectureComponent => Boolean(component));
      const converters = new Set(adjacent.flatMap((component) => [
        asString(component.properties["key.converter"]?.value),
        asString(component.properties["value.converter"]?.value)
      ]).filter((value): value is string => Boolean(value)));
      if (converters.size > 2) add({
        ruleId: "inconsistent-serialization-settings",
        severity: "warning",
        confidence: "medium",
        affectedComponentIds: [topic.id, ...adjacent.map((component) => component.id)],
        explanation: `${topic.name} is adjacent to multiple converter configurations: ${[...converters].sort().join(", ")}.`,
        evidence: adjacent.flatMap((component) => component.evidence),
        recommendation: "Verify key/value serialization compatibility and Schema Registry usage across producers and consumers."
      });
    }
  }

  private dlqPolicy(graph: ArchitectureGraph, project: ProjectConfig, add: FindingAdder): void {
    if (!project.validation.requireDlqForSinks) return;
    for (const connector of graph.components.filter((component) => component.type === "kafka-connector")) {
      const connectorClass = asString(connector.properties["connector.class"]?.value)?.toLowerCase() ?? "";
      if (!connectorClass.includes("sink")) continue;
      const hasDlq = graph.relationships.some((edge) => edge.from === connector.id && edge.type === "ROUTES_ERRORS_TO");
      if (!hasDlq) add({
        ruleId: "missing-dlq-configuration",
        severity: "warning",
        confidence: "high",
        affectedComponentIds: [connector.id],
        explanation: `${connector.name} has no discovered dead-letter queue configuration.`,
        evidence: connector.evidence,
        recommendation: "Configure a DLQ or record a reviewed exception."
      });
    }
  }

  private databaseWriters(graph: ArchitectureGraph, add: FindingAdder): void {
    const databaseTypes = new Set(["database", "database-table", "mongodb-collection", "database-server"]);
    for (const destination of graph.components.filter((component) => databaseTypes.has(component.type))) {
      const writers = graph.relationships.filter((edge) => edge.to === destination.id && edge.type === "WRITES_TO");
      if (writers.length > 1) add({
        ruleId: "potential-conflicting-database-writers",
        severity: "warning",
        confidence: "medium",
        affectedComponentIds: [destination.id, ...writers.map((writer) => writer.from)],
        explanation: `${writers.length} components write to ${destination.name}. Configuration reachability alone cannot confirm write conflicts.`,
        evidence: destination.evidence,
        recommendation: "Review ownership, keys, idempotency, and write strategies for the shared destination."
      });
    }
  }
}

type FindingAdder = (finding: Omit<ValidationFinding, "id">) => void;

function values(component: ArchitectureComponent): Record<string, unknown> {
  return Object.fromEntries(Object.entries(component.properties).map(([key, value]) => [key, value.value]));
}

function evidenceFor(ids: string[], byId: Map<string, ArchitectureComponent>): SourceEvidence[] {
  const values = ids.flatMap((id) => byId.get(id)?.evidence ?? []);
  return [...new Map(values.map((evidence) => [`${evidence.path}|${evidence.parser}`, evidence])).values()];
}

function severityRank(severity: FindingSeverity): number {
  return severity === "error" ? 3 : severity === "warning" ? 2 : 1;
}
