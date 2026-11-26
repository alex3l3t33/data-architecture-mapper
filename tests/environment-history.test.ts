import { describe, expect, it } from "vitest";
import { GraphBuilder } from "../src/graph/builder";
import { EnvironmentComparator } from "../src/environment/compare";
import { SnapshotService } from "../src/history/snapshots";
import { project } from "./helpers";

const evidence = { path: "topic.yaml", parser: "test" };

describe("environment comparison and history", () => {
  it("compares equivalent components at property level and honors ignored properties", () => {
    const graph = new GraphBuilder().build(project(), [
      { kind: "topic", name: "orders", environment: "DEV", clusterAlias: "primary", technology: "kafka", config: { partitions: 3, "retention.ms": 3600000 }, evidence, diagnostics: [] },
      { kind: "topic", name: "orders", environment: "PRODUCTION", clusterAlias: "primary", technology: "kafka", config: { partitions: 12, "retention.ms": 86400000 }, evidence, diagnostics: [] }
    ]);
    const differences = new EnvironmentComparator().compare(graph, ["retention.ms"]);
    expect(differences.map((entry) => entry.property)).toEqual(["partitions", "retention.ms"]);
    expect(differences.find((entry) => entry.property === "retention.ms")?.ignored).toBe(true);
  });

  it("compares same-named applications independently for each subproject", () => {
    const subprojects = [
      { id: "shop", name: "Shop", folder: "shop" },
      { id: "billing", name: "Billing", folder: "billing" }
    ];
    const graph = new GraphBuilder().build(project({ subprojects }), subprojects.flatMap(({ id, folder }) =>
      ["DEV", "PRODUCTION"].map((environment) => ({
        kind: "application" as const, name: "worker", environment, clusterAlias: "primary", technology: "spring-boot",
        config: { version: `${id}-${environment}` },
        evidence: { ...evidence, path: `architecture/${folder}/${environment}/application.yml` },
        diagnostics: []
      }))
    ));
    const versions = new EnvironmentComparator().compare(graph, [], {}, subprojects).filter(({ property }) => property === "version");
    expect(versions).toEqual([
      { componentKey: "worker · Billing", property: "version", values: { DEV: "billing-DEV", PRODUCTION: "billing-PRODUCTION" }, ignored: false },
      { componentKey: "worker · Shop", property: "version", values: { DEV: "shop-DEV", PRODUCTION: "shop-PRODUCTION" }, ignored: false }
    ]);
  });

  it("captures redacted snapshots and reports deterministic changes", () => {
    const service = new SnapshotService();
    const beforeGraph = new GraphBuilder().build(project(), [
      { kind: "topic", name: "orders", environment: "DEV", clusterAlias: "primary", technology: "kafka", config: { partitions: 3, password: "not-safe" }, evidence, diagnostics: [] }
    ]);
    const afterGraph = new GraphBuilder().build(project(), [
      { kind: "topic", name: "orders", environment: "DEV", clusterAlias: "primary", technology: "kafka", config: { partitions: 6, password: "also-not-safe" }, evidence, diagnostics: [] },
      { kind: "topic", name: "refunds", environment: "DEV", clusterAlias: "primary", technology: "kafka", config: { partitions: 3 }, evidence, diagnostics: [] }
    ]);
    const before = service.capture("before", beforeGraph, [], "2026-01-01T00:00:00Z");
    const after = service.capture("after", afterGraph, [], "2026-01-02T00:00:00Z");
    expect(JSON.stringify(before)).not.toContain("not-safe");
    const diff = service.compare(before, after);
    expect(diff.addedComponents.length).toBe(1);
    expect(diff.changedComponents[0]?.properties).toContain("partitions");
  });
});
