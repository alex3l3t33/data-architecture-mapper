import { describe, expect, it } from "vitest";
import { GraphBuilder } from "../src/graph/builder";
import { graphForSubproject } from "../src/graph/subproject-scope";
import type { ArchitectureGraph } from "../src/model/types";
import { ParserRegistry } from "../src/parsing/registry";
import { project } from "./helpers";

const registry = new ParserRegistry();
const config = project({ subprojects: [
  { id: "a", name: "Team A", folder: "a" },
  { id: "b", name: "Team B", folder: "b" }
] });

function catalog(mongoInstances: unknown[]) {
  return registry.parse("architecture/infrastructure.json", JSON.stringify({ infrastructure: { mongoInstances } })).artifacts;
}

function app(path: string, name: string, environment: string, mongoUri?: string) {
  return registry.parse(`architecture/${path}/application.yml`, JSON.stringify({
    spring: { application: { name }, data: { mongodb: { uri: mongoUri } } }
  }), { environment }).artifacts;
}

function connector(path: string, name: string, environment: string, mongoUri?: string, direction = "Sink") {
  return registry.parse(`architecture/${path}/${name}.json`, JSON.stringify({
    name,
    config: {
      "connector.class": `org.mongodb.kafka.connect.Mongo${direction}Connector`,
      "connection.uri": mongoUri,
      database: "orders",
      collection: "activity"
    }
  }), { environment }).artifacts;
}

function mongoEdges(graph: ArchitectureGraph) {
  return graph.relationships.filter((edge) => edge.metadata.mongoLink);
}

describe("MongoDB workload links", () => {
  it("uses exact same-environment names with an explicit subproject and preserves provenance", () => {
    const parsed = [
      ...catalog([{
        name: "mongo-east", environment: "PRODUCTION",
        links: { applications: ["order-review", { name: "order-review", subproject: "Team B" }], connectors: ["mongo-source"] }
      }]),
      ...app("a", "order-review", "PRODUCTION"),
      ...app("b", "order-review", "PRODUCTION"),
      ...app("b/dev", "order-review", "DEV"),
      ...connector("a", "mongo-source", "PRODUCTION", undefined, "Source")
    ];
    const graph = new GraphBuilder().build(config, parsed);
    const mongo = graph.components.find((component) => component.type === "mongodb-instance")!;
    const application = graph.components.find((component) =>
      component.type === "application" && component.environment === "PRODUCTION" && component.subprojectIds?.includes("b")
    )!;
    const source = graph.components.find((component) => component.name === "mongo-source")!;
    expect(mongo.subprojectIds).toEqual(["a", "b"]);
    expect(graphForSubproject(graph, "b").components.map((component) => component.id)).toContain(mongo.id);
    const links = mongoEdges(graph);
    expect(links).toHaveLength(2);
    expect(links.find((link) => link.type === "USES_DATABASE")).toMatchObject({
      from: application.id, to: mongo.id, metadata: { association: true, mongoLink: "declared" },
      evidence: [
        expect.objectContaining({ path: "architecture/b/application.yml" }),
        expect.objectContaining({ path: "architecture/infrastructure.json" })
      ]
    });
    expect(links.find((link) => link.type === "READS_FROM")).toMatchObject({ from: mongo.id, to: source.id });
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({ severity: "warning", message: expect.stringContaining("ambiguous") }));
  });

  it("matches only a unique exact Mongo address and keeps same-name collections distinct across hosts", () => {
    const graph = new GraphBuilder().build(config, [
      ...catalog([
        { name: "east", environment: "PRODUCTION", properties: { host: "mongo.east.example", port: 27017 } },
        { name: "west", environment: "PRODUCTION", properties: { host: "mongo.west.example" } }
      ]),
      ...connector("a", "east-sink", "PRODUCTION", "mongodb://user:password@mongo.east.example/orders"),
      ...connector("b", "west-sink", "PRODUCTION", "mongodb://mongo.west.example/orders"),
      ...connector("a", "name-only-sink", "PRODUCTION"),
      ...app("a", "east-api", "PRODUCTION", "mongodb://MONGO.EAST.EXAMPLE:27017/orders"),
      ...app("b", "wrong-environment", "DEV", "mongodb://mongo.east.example/orders")
    ]);
    const collections = graph.components.filter((component) => component.type === "mongodb-collection");
    const east = graph.components.find((component) => component.name === "east")!;
    expect(new Set(collections.map((component) => component.id)).size).toBe(3);
    const links = mongoEdges(graph);
    expect(links.filter((edge) => edge.type === "WRITES_TO")).toHaveLength(2);
    expect(links.filter((edge) => edge.type === "BELONGS_TO")).toHaveLength(2);
    expect(links.filter((edge) => edge.type === "USES_DATABASE")).toHaveLength(1);
    expect(links.find((edge) => edge.type === "USES_DATABASE")?.to).toBe(east.id);
    expect(links.every((edge) => edge.metadata.mongoLink === "matched-host" && edge.metadata.association === true)).toBe(true);
  });

  it("does not auto-link ambiguous instances or a hostname prefix", () => {
    const graph = new GraphBuilder().build(config, [
      ...catalog([
        { name: "first", environment: "DEV", properties: { host: "db.example.test" } },
        { name: "second", environment: "DEV", properties: { host: "db.example.test" } }
      ]),
      ...app("a", "ambiguous", "DEV", "mongodb://db.example.test/orders"),
      ...app("b", "prefix", "DEV", "mongodb://db.example.test.invalid/orders")
    ]);
    expect(mongoEdges(graph)).toHaveLength(0);
  });
});
