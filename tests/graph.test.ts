import { describe, expect, it } from "vitest";
import { subprojectForPath } from "../src/discovery/subprojects";
import { GraphBuilder } from "../src/graph/builder";
import { graphForSubproject } from "../src/graph/subproject-scope";
import { componentId } from "../src/model/ids";
import type { ParsedArtifact } from "../src/model/types";
import { project } from "./helpers";

const evidence = (path: string) => ({ path, parser: "test" });

function artifact(value: Partial<ParsedArtifact> & Pick<ParsedArtifact, "kind" | "name" | "config">): ParsedArtifact {
  return {
    technology: value.kind === "connector" ? "kafka-connect" : "kafka",
    evidence: evidence(`${value.name}.json`),
    diagnostics: [],
    ...value
  };
}

describe("normalized graph construction", () => {
  it("keeps identical topic names separate across Kafka clusters and environments", () => {
    const graph = new GraphBuilder().build(project(), [
      artifact({ kind: "topic", name: "orders", environment: "DEV", clusterAlias: "primary", config: { partitions: 3 } }),
      artifact({ kind: "topic", name: "orders", environment: "DEV", clusterAlias: "secondary", config: { partitions: 6 } }),
      artifact({ kind: "topic", name: "orders", environment: "PRODUCTION", clusterAlias: "primary", config: { partitions: 12 } })
    ]);
    const topics = graph.components.filter((component) => component.type === "kafka-topic");
    expect(topics).toHaveLength(3);
    expect(new Set(topics.map((topic) => topic.id)).size).toBe(3);
  });

  it("builds fan-in, fan-out, MongoDB mappings, DLQ, and provenance", () => {
    const graph = new GraphBuilder().build(project(), [
      artifact({ kind: "application", name: "checkout", environment: "DEV", clusterAlias: "primary", technology: "spring-boot", config: {
        "kafka.input.topics": "cart,pricing,inventory",
        "kafka.output.topics": "orders",
        "spring.kafka.consumer.group-id": "checkout-v1"
      } }),
      artifact({ kind: "connector", name: "mongo-orders", environment: "DEV", clusterAlias: "primary", technology: "mongodb-kafka", config: {
        "connector.class": "com.mongodb.kafka.connect.MongoSinkConnector",
        topics: "orders,order-updates",
        database: "commerce",
        collection: "orders",
        "errors.deadletterqueue.topic.name": "orders-dlq"
      } })
    ]);
    expect(graph.components.filter((component) => component.type === "kafka-topic").map((component) => component.name)).toEqual(
      expect.arrayContaining(["cart", "pricing", "inventory", "orders", "order-updates"])
    );
    expect(graph.components.some((component) => component.type === "mongodb-collection" && component.name === "commerce.orders")).toBe(true);
    expect(graph.relationships.some((edge) => edge.type === "ROUTES_ERRORS_TO")).toBe(true);
    expect(graph.components.every((component) => component.evidence.length > 0)).toBe(true);
  });

  it("represents topic regex and dynamic source topics as unresolved", () => {
    const graph = new GraphBuilder().build(project(), [
      artifact({ kind: "connector", name: "regex-sink", clusterAlias: "primary", technology: "jdbc", config: {
        "connector.class": "io.confluent.connect.jdbc.JdbcSinkConnector",
        "topics.regex": "orders-.*",
        "connection.url": "jdbc:postgresql://db/orders"
      } }),
      artifact({ kind: "connector", name: "cdc-source", clusterAlias: "primary", technology: "debezium", config: {
        "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
        "topic.prefix": "${TENANT}",
        "database.hostname": "postgres"
      } })
    ]);
    expect(graph.components.filter((component) => component.unresolved)).toHaveLength(2);
    expect(graph.relationships.filter((edge) => edge.unresolved).map((edge) => edge.type)).toEqual(expect.arrayContaining(["CONSUMES", "PRODUCES"]));
  });

  it("preserves conflicting explicit topic definitions for validation", () => {
    const graph = new GraphBuilder().build(project(), [
      artifact({ kind: "topic", name: "orders", clusterAlias: "primary", config: { partitions: 3 } }),
      artifact({ kind: "topic", name: "orders", clusterAlias: "primary", config: { partitions: 6 }, evidence: evidence("other.yaml") })
    ]);
    const topic = graph.components.find((component) => component.type === "kafka-topic")!;
    expect(topic.properties._conflicts?.value).toEqual({ partitions: [3, 6] });
  });

  it("keeps sibling applications distinct and links them through a shared topic", () => {
    const config = project({
      subprojects: [
        { id: "payments", name: "Payment processing", folder: "teams/payments" },
        { id: "reports", name: "Reporting", folder: "teams/reports" }
      ]
    });
    const artifacts = [
      artifact({
        kind: "application", name: "worker", environment: "DEV", clusterAlias: "primary",
        config: { "kafka.output.topics": "payments" },
        evidence: evidence("architecture/teams/payments/application.yaml")
      }),
      artifact({
        kind: "application", name: "worker", environment: "DEV", clusterAlias: "primary",
        config: { "kafka.input.topics": "payments" },
        evidence: evidence("architecture/teams/reports/application.yaml")
      }),
      artifact({
        kind: "topic", name: "payments", environment: "DEV", clusterAlias: "primary",
        config: { partitions: 3 }, evidence: evidence("architecture/shared/payments.yaml")
      })
    ];

    const builder = new GraphBuilder();
    const graph = builder.build(config, artifacts);
    const apps = graph.components.filter((component) => component.type === "application");
    const topics = graph.components.filter((component) => component.type === "kafka-topic");
    expect(apps).toHaveLength(2);
    expect(topics).toHaveLength(1);
    const [topic] = topics;
    const producer = apps.find((component) => component.subprojectIds?.includes("payments"))!;
    const consumer = apps.find((component) => component.subprojectIds?.includes("reports"))!;
    expect(producer.id).not.toEqual(consumer.id);
    expect(producer.label).toBe("worker · Payment processing");
    expect(consumer.kafkaClusterId).toBe(producer.kafkaClusterId);
    expect(topic?.subprojectIds).toEqual(["payments", "reports"]);
    expect(graph.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "PRODUCES", from: producer.id, to: topic?.id }),
      expect.objectContaining({ type: "CONSUMES", from: topic?.id, to: consumer.id })
    ]));

    const scoped = graphForSubproject(graph, "payments");
    expect(scoped.components.map((component) => component.id)).toContain(topic?.id);
    expect(scoped.components.map((component) => component.id)).not.toContain(consumer.id);
    expect(scoped.relationships.map((edge) => edge.type)).not.toContain("CONSUMES");

    const legacy = builder.build(project(), artifacts).components.filter((component) => component.type === "application");
    expect(legacy).toHaveLength(1);
    expect(legacy[0]?.id).toBe(componentId(config.id, "DEV", "application", "worker", producer.kafkaClusterId));
    expect(legacy[0]?.subprojectIds).toBeUndefined();
  });

  it("assigns descriptor applications to the deepest matching folder and ignores path lookalikes", () => {
    const config = project({
      subprojects: [
        { id: "team", name: "Team", folder: "team" },
        { id: "special", name: "Special work", folder: "team/special" }
      ]
    });
    expect(subprojectForPath(config, "architecture/team/special/src/architecture.md")?.id).toBe("special");
    expect(subprojectForPath(config, "architecture/team/specialty/architecture.md")?.id).toBe("team");
    expect(subprojectForPath(config, "architecture/teamwork/architecture.md")).toBeUndefined();
    expect(subprojectForPath(config, "another-project/team/architecture.md")).toBeUndefined();
    const graph = new GraphBuilder().build(config, [
      artifact({
        kind: "architecture-descriptor", name: "team", config: { components: [{ type: "application", name: "inbound" }] },
        evidence: evidence("architecture/team/architecture.md")
      }),
      artifact({
        kind: "architecture-descriptor", name: "special", config: { components: [{ type: "application", name: "inbound" }] },
        evidence: evidence("architecture/team/special/architecture.md")
      })
    ]);
    const apps = graph.components.filter((component) => component.type === "application");
    expect(apps).toHaveLength(2);
    expect(apps.map((app) => app.subprojectIds)).toEqual([["special"], ["team"]]);
  });
});
