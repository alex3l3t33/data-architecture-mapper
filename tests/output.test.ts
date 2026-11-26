import { describe, expect, it } from "vitest";
import { GraphBuilder } from "../src/graph/builder";
import { MermaidGenerator } from "../src/output/mermaid";
import { MarkdownGenerator } from "../src/output/markdown";
import { deterministicId } from "../src/model/ids";
import type { ArchitectureRelationship } from "../src/model/types";
import { ParserRegistry } from "../src/parsing/registry";
import { project } from "./helpers";

const artifacts = [
  { kind: "application" as const, name: "A \"checkout\"", environment: "DEV", clusterAlias: "primary", technology: "spring-boot", config: { "kafka.output.topics": "orders" }, evidence: { path: "dev/application.yml", parser: "test" }, diagnostics: [] },
  { kind: "connector" as const, name: "orders-sink", environment: "DEV", clusterAlias: "primary", technology: "jdbc", config: { "connector.class": "JdbcSinkConnector", topics: "orders", "connection.url": "jdbc:postgresql://db/orders" }, evidence: { path: "dev/orders.json", parser: "test" }, diagnostics: [] }
];

const mongoEnvironments = ["DEV", "STAGING", "PRODUCTION"];

function mongoPipeline(instancePrefixes = [""]) {
  const registry = new ParserRegistry();
  const instances = mongoEnvironments.flatMap((environment) => instancePrefixes.map((prefix) => ({
    environment,
    prefix,
    name: `mongo-${prefix}${environment}`,
    host: `mongo-${prefix}${environment.toLowerCase()}.example.test`
  })));
  const inventory = registry.parse("architecture/infrastructure.json", JSON.stringify({
    infrastructure: {
      mongoInstances: instances.map(({ name, environment, host }) => ({ name, environment, properties: { host } }))
    }
  })).artifacts;
  const workloads = instances.flatMap(({ environment, prefix, host }) => {
    const uri = `mongodb://${host}/orders`;
    const root = `architecture/${environment.toLowerCase()}`;
    const connector = (direction: "Source" | "Sink") => registry.parse(`${root}/${prefix}${direction.toLowerCase()}.json`, JSON.stringify({
      name: `${direction}-${prefix}${environment}`,
      config: {
        "connector.class": `com.mongodb.kafka.connect.Mongo${direction}Connector`,
        "connection.uri": uri,
        "kafka.cluster": "primary",
        [direction === "Source" ? "topic" : "topics"]: "orders",
        database: "orders",
        collection: "activity"
      }
    }), { environment }).artifacts;
    const application = (name: string, endpoint?: string) => registry.parse(`${root}/${prefix}${name}/application.yml`, JSON.stringify({
      "spring.application.name": `${name}-${prefix}${environment}`,
      "spring.data.mongodb.uri": endpoint,
      "kafka.cluster": "primary",
      "kafka.input.topics": "orders"
    }), { environment }).artifacts;
    return [
      ...connector("Source"), ...connector("Sink"),
      ...application("mongo-app", uri), ...application("kafka-only-app")
    ];
  });
  return new GraphBuilder().build(project(), [...inventory, ...workloads]);
}

function mermaidEdge(fromId: string, relationship: string, toId: string): RegExp {
  const from = deterministicId("n", fromId).replace(/-/g, "_");
  const to = deterministicId("n", toId).replace(/-/g, "_");
  return new RegExp(`^\\s*${from} (?:-->|-\\.->)\\|${relationship}\\| ${to}$`, "m");
}

function expectMermaidEdge(mermaid: string, fromId: string, relationship: string, toId: string): void {
  expect(mermaid).toMatch(mermaidEdge(fromId, relationship, toId));
}

describe("deterministic output", () => {
  const graph = new GraphBuilder().build(project(), artifacts);

  it("generates deterministic Mermaid with safe identifiers and escaped labels", () => {
    const generator = new MermaidGenerator();
    const first = generator.generate(graph);
    const second = generator.generate(graph);
    expect(first).toBe(second);
    expect(first).toMatch(/^flowchart LR/);
    expect(first).not.toContain("A \"checkout\"");
    expect(first).toContain("A #quot;checkout#quot;");
    expect(first).toContain("-->|PRODUCES|");
    expect((first.match(/subgraph/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("generates stable Markdown without timestamps and with source links", () => {
    const generator = new MarkdownGenerator();
    const first = generator.generate("Payments", graph, []);
    const second = generator.generate("Payments", { ...graph, generatedAt: "2099-01-01T00:00:00Z" }, []);
    expect(first).toEqual(second);
    expect(first.find((file) => file.path === "Connectors.md")?.content).toContain("[[dev/orders.json\\|orders.json]]");
    expect(first.find((file) => file.path === "Architecture Overview.md")?.content).toContain("```mermaid");
    const connectorIndex = first.find((file) => file.path === "Connector Architecture.md")?.content;
    expect(connectorIndex).toContain("[[Connector Architecture - DEV]]");
    expect(connectorIndex).not.toContain("```mermaid");
    const connectorNote = first.find((file) => file.path === "Connector Architecture - DEV.md")?.content;
    expect(connectorNote).toContain("orders-sink");
    expect(connectorNote).not.toContain("checkout");
  });

  it("links source and sink connectors through the same topic with data flowing in the correct direction", () => {
    const pipeline = new GraphBuilder().build(project(), [
      ...artifacts.slice(1),
      { kind: "connector", name: "file-source", environment: "DEV", clusterAlias: "primary", technology: "kafka-connect",
        config: { "connector.class": "FileStreamSourceConnector", topic: "orders", file: "/data/orders" },
        evidence: { path: "dev/source.properties", parser: "test" }, diagnostics: [] }
    ]);
    const ids = new Set(pipeline.components.filter((item) => item.type === "kafka-connector").map((item) => item.id));
    const diagram = new MermaidGenerator().generateConnectors(pipeline, ids);
    expect(diagram).toContain('"/data/orders"');
    expect(diagram).toContain("file-source");
    expect(diagram).toContain("orders-sink");
    const topic = diagram.match(/(n_\w+)\(\("orders"\)\)/)?.[1];
    expect(topic).toBeDefined();
    expect(diagram).toContain(`-->|PRODUCES| ${topic}`);
    expect(diagram).toContain(`${topic} -->|CONSUMES|`);
    expect(diagram).not.toContain("HOSTED_ON");
  });

  it("identifies applications by the owning subproject's display name or parent project", () => {
    const subprojects = [{ id: "shop", name: "Customer Shop", folder: "shop" }];
    const application = artifacts[0]!;
    const scopedGraph = new GraphBuilder().build(project({ subprojects }), [
      { ...application, evidence: { path: "architecture/shop/dev/application.yml", parser: "test" } },
      { ...application, name: "Shared app", evidence: { path: "architecture/dev/application.yml", parser: "test" } }
    ]);
    const note = new MarkdownGenerator().generate("Payments", scopedGraph, [], subprojects)
      .find((file) => file.path === "Applications.md")?.content;
    expect(note).toContain("| Name | Type | Subproject | Environment |");
    expect(note).toContain("| application | Customer Shop | DEV |");
    expect(note).toContain("| Shared app | application | Parent project | DEV |");
  });

  it("scopes connector diagrams to local edges and separates same-named topics by environment", () => {
    const envs = ["PRODUCTION", "Zeta", "STAGING", "Alpha", "DEV"];
    const pipeline = new GraphBuilder().build(project(), envs.map((environment) => ({
      ...artifacts[1]!, name: `sink-${environment}`, environment
    })));
    const connectors = pipeline.components.filter((component) => component.type === "kafka-connector");
    const devConnector = connectors.find((component) => component.environment === "DEV")!;
    const productionTopic = pipeline.components.find((component) => component.type === "kafka-topic" && component.environment === "PRODUCTION")!;
    const crossEnvironmentRelationship: ArchitectureRelationship = {
      id: "malformed-cross-environment",
      projectId: pipeline.projectId,
      environment: "DEV",
      from: devConnector.id,
      to: productionTopic.id,
      type: "TRANSFORMS",
      evidence: [],
      metadata: {}
    };
    const graph = { ...pipeline, relationships: [...pipeline.relationships, crossEnvironmentRelationship] };
    const ids = new Set(connectors.map((connector) => connector.id));
    const generator = new MermaidGenerator();
    const diagrams = generator.generateConnectorDiagrams(graph, ids, "TB");
    expect(diagrams.map((diagram) => diagram.environment)).toEqual(["DEV", "STAGING", "PRODUCTION", "Alpha", "Zeta"]);
    expect(generator.generateConnectorDiagrams(graph, ids, "LR", ["Zeta", "PRODUCTION"]).map((diagram) => diagram.environment))
      .toEqual(["Zeta", "PRODUCTION", "DEV", "STAGING", "Alpha"]);
    expect(diagrams.every((diagram) => diagram.connectorCount === 1)).toBe(true);
    expect(diagrams.every(({ mermaid }) => mermaid.startsWith("flowchart TB"))).toBe(true);
    const topicIds = diagrams.map(({ mermaid }) => mermaid.match(/(n_\w+)\(\("orders"\)\)/)?.[1]);
    expect(topicIds.every(Boolean)).toBe(true);
    expect(new Set(topicIds).size).toBe(envs.length);
    const dev = diagrams[0]!.mermaid;
    expect(dev).toContain(`${topicIds[0]} -->|CONSUMES|`);
    expect(dev).toContain("sink-DEV");
    expect(dev).not.toContain(topicIds[2]);
    expect(dev).not.toContain("sink-PRODUCTION");
    expect(dev).not.toContain("TRANSFORMS");
    expect(dev).not.toContain("HOSTED_ON");
  });

  it("links distinct, safe notes for each connector environment in the requested order", () => {
    const environments = ["DEV", "STAGING", "PRODUCTION", "QA/Blue", "QA:Blue"];
    const pipeline = new GraphBuilder().build(project(), environments.map((environment, index) => ({
      ...artifacts[1]!, name: `sink-${environment}-${index}`, environment
    })));
    const generated = new MarkdownGenerator().generate("Payments", pipeline, [], [], ["STAGING"]);
    const index = generated.find((document) => document.path === "Connector Architecture.md")!;
    const notes = generated.filter((document) => document.path.startsWith("Connector Architecture - "));
    expect(notes.slice(0, 3).map(({ path }) => path)).toEqual([
      "Connector Architecture - STAGING.md", "Connector Architecture - DEV.md", "Connector Architecture - PRODUCTION.md"
    ]);
    expect(notes).toHaveLength(environments.length);
    expect(new Set(notes.map(({ path }) => path.toLowerCase())).size).toBe(environments.length);
    for (const note of notes) {
      expect(note.path).not.toMatch(/[/:\\\[\]|]/);
      expect(index.content).toContain(`[[${note.path.replace(/\.md$/, "")}]]`);
      expect(note.content).toContain("```mermaid");
    }
    const dev = notes.find(({ path }) => path === "Connector Architecture - DEV.md")!;
    expect(dev.content).toContain("sink-DEV");
    expect(dev.content).not.toContain("sink-STAGING");
  });

  it("shows MongoDB instances, their linked apps and connector directions in each environment and its generated note", () => {
    const graph = mongoPipeline();
    const connectors = graph.components.filter((component) => component.type === "kafka-connector");
    const generator = new MermaidGenerator();
    const diagrams = generator.generateConnectorDiagrams(graph, new Set(connectors.map(({ id }) => id)));
    const notes = new MarkdownGenerator().generate("Payments", graph, []);

    expect(diagrams.map(({ environment }) => environment)).toEqual(mongoEnvironments);
    for (const { environment, connectorCount, mermaid } of diagrams) {
      const idFor = (name: string) => graph.components.find((component) => component.name === `${name}-${environment}`)!.id;
      expect(connectorCount).toBe(2);
      expect(mermaid).toContain(`"mongo-${environment}"`);
      expect(mermaid).toContain(`"mongo-app-${environment}"`);
      expect(mermaid).toContain('"orders"');
      expectMermaidEdge(mermaid, idFor("mongo"), "READS_FROM", idFor("Source"));
      expectMermaidEdge(mermaid, idFor("Sink"), "WRITES_TO", idFor("mongo"));
      expectMermaidEdge(mermaid, idFor("mongo-app"), "USES_DATABASE", idFor("mongo"));
      expect(mermaid).not.toContain("kafka-only-app");
      for (const other of mongoEnvironments.filter((name) => name !== environment)) {
        expect(mermaid).not.toContain(`-${other}`);
      }
      expect(notes.find(({ path }) => path === `Connector Architecture - ${environment}.md`)?.content).toContain(mermaid);
    }
  });

  it("includes proven MongoDB paths through a collection while keeping the folder connector selection", () => {
    const graph = mongoPipeline();
    const source = graph.components.find(({ name }) => name === "Source-DEV")!;
    const app = graph.components.find(({ name }) => name === "mongo-app-DEV")!;
    const mongo = graph.components.find(({ name }) => name === "mongo-DEV")!;
    const collection = graph.components.find(({ environment, type }) => environment === "DEV" && type === "mongodb-collection")!;
    const appLink = graph.relationships.find(({ from, to }) => from === app.id && to === mongo.id)!;
    const relationships = graph.relationships.filter(({ from, to }) =>
      !(from === mongo.id && to === source.id) && !(from === app.id && to === mongo.id)
    );
    relationships.push({ ...appLink, id: "application-collection-dependency", to: collection.id });
    const diagrams = new MermaidGenerator().generateConnectorDiagrams({ ...graph, relationships }, new Set([source.id]));

    expect(diagrams).toHaveLength(1);
    const { environment, connectorCount, mermaid } = diagrams[0]!;
    expect(environment).toBe("DEV");
    expect(connectorCount).toBe(1);
    expect(mermaid).toContain('"mongo-DEV"');
    expectMermaidEdge(mermaid, collection.id, "READS_FROM", source.id);
    expectMermaidEdge(mermaid, collection.id, "BELONGS_TO", mongo.id);
    expectMermaidEdge(mermaid, app.id, "USES_DATABASE", collection.id);
    expect(mermaid).not.toContain("Sink-DEV");
  });

  it("keeps two MongoDB instances and their identically named collections separate within each environment", () => {
    const prefixes = ["", "audit-"];
    const graph = mongoPipeline(prefixes);
    const connectors = graph.components.filter(({ type }) => type === "kafka-connector");
    const diagrams = new MermaidGenerator().generateConnectorDiagrams(graph, new Set(connectors.map(({ id }) => id)));
    expect(diagrams.map(({ environment }) => environment)).toEqual(mongoEnvironments);

    for (const { environment, connectorCount, mermaid } of diagrams) {
      expect(connectorCount).toBe(4);
      const collections = graph.components.filter((component) =>
        component.type === "mongodb-collection" && component.environment === environment
      );
      expect(collections.map(({ name }) => name)).toEqual(["orders.activity", "orders.activity"]);
      expect(new Set(collections.map(({ id }) => id)).size).toBe(2);
      expect(mermaid.match(/"orders\.activity"/g)).toHaveLength(2);

      for (const prefix of prefixes) {
        const otherPrefix = prefixes.find((candidate) => candidate !== prefix);
        const idFor = (name: string, instancePrefix = prefix) =>
          graph.components.find((component) => component.name === `${name}-${instancePrefix}${environment}`)!.id;
        const instance = idFor("mongo");
        const otherInstance = idFor("mongo", otherPrefix);
        const sourcePath = `architecture/${environment.toLowerCase()}/${prefix}source.json`;
        const collection = collections.find(({ evidence }) => evidence.some(({ path }) => path === sourcePath))!;
        expect(mermaid).toContain(`"mongo-${prefix}${environment}"`);
        expectMermaidEdge(mermaid, collection.id, "BELONGS_TO", instance);
        expectMermaidEdge(mermaid, instance, "READS_FROM", idFor("Source"));
        expectMermaidEdge(mermaid, idFor("Sink"), "WRITES_TO", instance);
        expectMermaidEdge(mermaid, idFor("mongo-app"), "USES_DATABASE", instance);
        expect(mermaid).not.toMatch(mermaidEdge(collection.id, "BELONGS_TO", otherInstance));
        expect(mermaid).not.toMatch(mermaidEdge(otherInstance, "READS_FROM", idFor("Source")));
        expect(mermaid).not.toMatch(mermaidEdge(idFor("Sink"), "WRITES_TO", otherInstance));
        expect(mermaid).not.toMatch(mermaidEdge(idFor("mongo-app"), "USES_DATABASE", otherInstance));
      }
    }
  });
});
