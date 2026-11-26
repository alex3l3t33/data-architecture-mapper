import { describe, expect, it } from "vitest";
import type { ArchitectureGraph, ArchitectureRelationship } from "../src/model/types";
import { LineageAnalyzer } from "../src/graph/lineage";

function graph(edges: Array<[string, string]>): ArchitectureGraph {
  const ids = [...new Set(edges.flat())];
  return {
    projectId: "test",
    generatedAt: "2026-01-01T00:00:00.000Z",
    components: ids.map((id) => ({ id, projectId: "test", environment: "DEV", type: "application", name: id, label: id, properties: {}, evidence: [], tags: [] })),
    relationships: edges.map(([from, to]) => ({ id: `${from}|PRODUCES|${to}`, projectId: "test", environment: "DEV", from, to, type: "PRODUCES", evidence: [], metadata: {} } satisfies ArchitectureRelationship)),
    diagnostics: []
  };
}

describe("lineage and impact algorithms", () => {
  const topology = graph([["a", "b"], ["b", "c"], ["a", "d"], ["d", "c"], ["c", "e"], ["e", "b"]]);

  it("traverses upstream and downstream without infinite loops", () => {
    const analyzer = new LineageAnalyzer(topology);
    expect(analyzer.downstream("a").componentIds).toEqual(["a", "b", "d", "c", "e"]);
    expect(analyzer.upstream("c").componentIds).toEqual(["c", "b", "d", "a", "e"]);
  });

  it("finds shortest and multiple paths", () => {
    const analyzer = new LineageAnalyzer(topology);
    expect(analyzer.shortestPath("a", "c")).toHaveLength(3);
    expect(analyzer.paths("a", "c")).toHaveLength(2);
  });

  it("finds strongly connected components and cycles", () => {
    const analyzer = new LineageAnalyzer(topology);
    expect(analyzer.stronglyConnectedComponents()).toEqual([["b", "c", "e"]]);
    expect(analyzer.downstream("b").cyclesEncountered.length).toBeGreaterThan(0);
  });

  it("honors maximum traversal depth", () => {
    const result = new LineageAnalyzer(topology).downstream("a", 1);
    expect(result.componentIds).toEqual(["a", "b", "d"]);
  });
});
