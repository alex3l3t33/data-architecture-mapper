import { describe, expect, it } from "vitest";
import { GraphBuilder } from "../src/graph/builder";
import { ValidationEngine } from "../src/validation/engine";
import type { ArchitectureGraph } from "../src/model/types";
import { project } from "./helpers";

describe("validation engine", () => {
  it("reports policy, inventory, destination, DLQ, conflict, and capacity findings", () => {
    const configuredProject = project({ validation: { minimumReplicationFactor: 3, requireDlqForSinks: true, knownKafkaClusters: ["primary"] } });
    const evidence = { path: "connectors/sink.json", parser: "test" };
    const graph = new GraphBuilder().build(configuredProject, [
      { kind: "topic", name: "orders", clusterAlias: "primary", technology: "kafka", config: { partitions: 2, replicas: 1 }, evidence, diagnostics: [] },
      { kind: "connector", name: "orders-sink", clusterAlias: "primary", technology: "jdbc", config: {
        "connector.class": "io.confluent.connect.jdbc.JdbcSinkConnector",
        "tasks.max": 5,
        topics: "orders"
      }, evidence, diagnostics: [] }
    ]);
    const rules = new Set(new ValidationEngine().validate(graph, configuredProject).map((finding) => finding.ruleId));
    expect(rules.has("missing-connector-destination")).toBe(true);
    expect(rules.has("missing-dlq-configuration")).toBe(true);
    expect(rules.has("replication-factor-below-policy")).toBe(true);
    expect(rules.has("connector-tasks-exceed-input-partitions")).toBe(true);
  });

  it("labels cross-cluster cycles as potential behavior, not confirmed failure", () => {
    const component = (id: string, cluster: string) => ({
      id, projectId: "payments", environment: "PRODUCTION", type: "application" as const, name: id, label: id,
      kafkaClusterId: cluster, properties: {}, evidence: [{ path: `${id}.yml`, parser: "test" }], tags: []
    });
    const graph: ArchitectureGraph = {
      projectId: "payments",
      generatedAt: "2026-01-01T00:00:00Z",
      components: [component("a", "cluster-a"), component("b", "cluster-b")],
      relationships: [
        { id: "a|PRODUCES|b", projectId: "payments", environment: "PRODUCTION", from: "a", to: "b", type: "PRODUCES", evidence: [], metadata: {} },
        { id: "b|PRODUCES|a", projectId: "payments", environment: "PRODUCTION", from: "b", to: "a", type: "PRODUCES", evidence: [], metadata: {} }
      ],
      diagnostics: []
    };
    const finding = new ValidationEngine().validate(graph, project()).find((entry) => entry.ruleId === "potential-cross-cluster-feedback-loop");
    expect(finding).toBeDefined();
    expect(finding?.explanation).toContain("does not prove");
  });

  it("turns parser errors into high-confidence syntax findings", () => {
    const graph: ArchitectureGraph = {
      projectId: "payments", generatedAt: "", components: [], relationships: [],
      diagnostics: [{ path: "broken.json", parser: "structured", severity: "error", message: "Unexpected token" }]
    };
    const finding = new ValidationEngine().validate(graph, project())[0]!;
    expect(finding.ruleId).toBe("invalid-configuration-syntax");
    expect(finding.confidence).toBe("high");
  });
});
