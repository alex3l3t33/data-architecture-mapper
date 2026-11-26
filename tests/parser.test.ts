import { describe, expect, it } from "vitest";
import { ParserRegistry } from "../src/parsing/registry";
import { REDACTED } from "../src/security/redaction";

describe("configuration parsers", () => {
  const registry = new ParserRegistry();

  it("parses Kafka Connect REST JSON and extracts connector properties", () => {
    const result = registry.parse("dev/connectors/orders-sink.json", JSON.stringify({
      name: "orders-sink",
      config: {
        "connector.class": "com.mongodb.kafka.connect.MongoSinkConnector",
        "tasks.max": "4",
        topics: "orders,refunds",
        database: "commerce",
        collection: "orders",
        "writemodel.strategy": "com.mongodb.kafka.connect.sink.writemodel.strategy.ReplaceOneDefaultStrategy",
        "document.id.strategy": "com.mongodb.kafka.connect.sink.processor.id.strategy.PartialValueStrategy",
        "errors.deadletterqueue.topic.name": "orders-dlq",
        "connection.uri": "mongodb://admin:secret@db.internal/commerce"
      }
    }), { environment: "DEV", clusterAlias: "primary" });
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(1);
    const connector = result.artifacts[0]!;
    expect(connector.kind).toBe("connector");
    expect(connector.technology).toBe("mongodb-kafka");
    expect(connector.config.topics).toBe("orders,refunds");
    expect(connector.config["connection.uri"]).toContain(REDACTED);
    expect(String(connector.config["connection.uri"])).not.toContain("secret");
  });

  it("parses properties, continuations, converters, overrides, and SMT routing", () => {
    const content = [
      "name=warehouse-sink",
      "connector.class=io.confluent.connect.jdbc.JdbcSinkConnector",
      "topics=orders,\\",
      " refunds",
      "tasks.max=8",
      "connection.url=jdbc:postgresql://db/warehouse",
      "key.converter=org.apache.kafka.connect.storage.StringConverter",
      "value.converter=io.confluent.connect.avro.AvroConverter",
      "consumer.override.max.poll.records=500",
      "transforms=route",
      "transforms.route.type=org.apache.kafka.connect.transforms.RegexRouter",
      "transforms.route.regex=(.*)",
      "transforms.route.replacement=archive-$1"
    ].join("\n");
    const artifact = registry.parse("warehouse.properties", content).artifacts[0]!;
    expect(artifact.name).toBe("warehouse-sink");
    expect(artifact.config.topics).toBe("orders, refunds");
    expect(artifact.config["consumer.override.max.poll.records"]).toBe(500);
    expect(artifact.config["transforms.route.replacement"]).toBe("archive-$1");
  });

  it("parses Strimzi KafkaConnector, KafkaTopic, and KafkaConnect resources", () => {
    const yaml = `
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnector
metadata:
  name: inventory-source
spec:
  class: io.debezium.connector.postgresql.PostgresConnector
  tasksMax: 2
  config:
    topic.prefix: inventory
    database.hostname: postgres
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: inventory-events
spec:
  partitions: 12
  replicas: 3
  config:
    retention.ms: 86400000
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnect
metadata:
  name: main-workers
spec:
  replicas: 3
`;
    const artifacts = registry.parse("strimzi.yaml", yaml, { environment: "PRODUCTION" }).artifacts;
    expect(artifacts.map((artifact) => artifact.kind).sort()).toEqual(["connect-worker", "connector", "topic"]);
    expect(artifacts.find((artifact) => artifact.kind === "topic")?.config.partitions).toBe(12);
  });

  it("parses JSON topic catalogs with metadata defaults and separate environment and cluster scopes", () => {
    const path = "kafka/topics.json";
    const { artifacts, diagnostics } = registry.parse(path, JSON.stringify({
      env: "DEV",
      clusterAlias: "primary",
      topics: [
        { topicName: "orders", partitions: 6, replicationFactor: 3, config: { "retention.ms": 3600000 } },
        { name: "orders", environment: "PRODUCTION", partitions: 12, configs: { "cleanup.policy": "compact", "replication.factor": 2 } },
        { name: "orders", cluster: "secondary", config: { partitions: 3 } },
        { name: "refunds" },
        "a-topic-selector-not-a-definition"
      ]
    }), { environment: "TEST", clusterAlias: "fallback" });
    expect(diagnostics).toEqual([]);
    expect(artifacts).toMatchObject([
      { kind: "topic", name: "orders", environment: "DEV", clusterAlias: "primary", config: { partitions: 6, "replication.factor": 3, "retention.ms": 3600000 } },
      { kind: "topic", name: "orders", environment: "PRODUCTION", clusterAlias: "primary", config: { partitions: 12, "cleanup.policy": "compact", "replication.factor": 2 } },
      { kind: "topic", name: "orders", environment: "DEV", clusterAlias: "secondary", config: { partitions: 3 } },
      { kind: "topic", name: "refunds", environment: "DEV", clusterAlias: "primary" }
    ]);
    expect(artifacts.map((artifact) => artifact.evidence.path)).toEqual(Array(4).fill(path));
  });

  it("supports standalone and top-level JSON array topic definitions", () => {
    const first = { topicName: "transactions", replicationFactor: 3, config: { "retention.ms": 7200000 } };
    expect(registry.parse("topic.json", JSON.stringify(first)).artifacts).toMatchObject([
      { kind: "topic", name: "transactions", config: { "replication.factor": 3, "retention.ms": 7200000 } }
    ]);
    expect(registry.parse("topics.json", JSON.stringify([first, { name: "refunds", partitions: 3 }])).artifacts).toMatchObject([
      { kind: "topic", name: "transactions" },
      { kind: "topic", name: "refunds" }
    ]);
  });

  it("ignores connector topic selectors and connector partition settings as topic definitions", () => {
    const artifacts = registry.parse("connectors.json", JSON.stringify([
      { name: "sink", partitions: 6, config: { "connector.class": "JdbcSinkConnector", topics: "orders" } },
      { name: "sink-list", partitions: 6, "connector.class": "JdbcSinkConnector", topics: ["orders"] },
      { name: "string-selectors", partitions: 6, topics: ["orders", "refunds"] },
      { name: "source", topic: "orders", "tasks.max": 2, partitions: 6 }
    ])).artifacts;
    expect(artifacts.map(({ kind, name }) => ({ kind, name }))).toEqual([
      { kind: "connector", name: "sink" },
      { kind: "connector", name: "sink-list" }
    ]);
  });

  it("parses Spring Boot bindings and Docker Compose services", () => {
    const spring = registry.parse("application.yml", `
spring:
  application:
    name: fraud-detector
  kafka:
    bootstrap-servers: broker-a:9092
    consumer:
      group-id: fraud-v2
  cloud:
    stream:
      bindings:
        transactions-in-0:
          destination: transactions
        alerts-out-0:
          destination: fraud-alerts
`);
    const application = spring.artifacts.find((artifact) => artifact.kind === "application")!;
    expect(application.name).toBe("fraud-detector");
    expect(application.config["spring.cloud.stream.bindings.transactions-in-0.destination"]).toBe("transactions");

    const compose = registry.parse("docker-compose.yml", `
services:
  reconciler:
    image: example/reconciler:1
    environment:
      KAFKA_INPUT_TOPICS: payments
      KAFKA_OUTPUT_TOPICS: reconciled-payments
`);
    expect(compose.artifacts.some((artifact) => artifact.name === "reconciler")).toBe(true);
  });

  it("reports malformed configuration without throwing", () => {
    const result = registry.parse("broken.json", "{ not-json");
    expect(result.artifacts).toEqual([]);
    expect(result.diagnostics[0]?.severity).toBe("error");
  });

  it("parses Markdown YAML frontmatter architecture descriptors", () => {
    const result = registry.parse("architecture.md", `---
architecture:
  name: manual-boundaries
  components:
    - id: vendor
      type: external-source
      name: Card network
    - id: gateway
      type: application
      name: Gateway
  relationships:
    - from: vendor
      to: gateway
      type: WRITES_TO
---
# Notes
`);
    expect(result.artifacts[0]?.kind).toBe("architecture-descriptor");
  });
});
