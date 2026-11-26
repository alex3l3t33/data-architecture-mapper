import type { ArchitectureGraph, ArchitectureSnapshot, SnapshotDiff, ValidationFinding } from "../model/types";
import { deterministicId } from "../model/ids";
import { LineageAnalyzer } from "../graph/lineage";
import { redactValue } from "../security/redaction";

export class SnapshotService {
  capture(name: string, graph: ArchitectureGraph, findings: ValidationFinding[], capturedAt = new Date().toISOString()): ArchitectureSnapshot {
    const safeGraph = redactValue(graph) as ArchitectureGraph;
    const safeFindings = redactValue(findings) as ValidationFinding[];
    return {
      id: deterministicId("snapshot", `${graph.projectId}|${capturedAt}|${name}`),
      projectId: graph.projectId,
      name,
      capturedAt,
      graph: safeGraph,
      findings: safeFindings
    };
  }

  compare(before: ArchitectureSnapshot, after: ArchitectureSnapshot): SnapshotDiff {
    const beforeComponents = new Map(before.graph.components.map((component) => [component.id, component]));
    const afterComponents = new Map(after.graph.components.map((component) => [component.id, component]));
    const beforeEdges = new Set(before.graph.relationships.map((edge) => edge.id));
    const afterEdges = new Set(after.graph.relationships.map((edge) => edge.id));
    const changedComponents: SnapshotDiff["changedComponents"] = [];
    for (const [id, current] of afterComponents) {
      const previous = beforeComponents.get(id);
      if (!previous) continue;
      const keys = new Set([...Object.keys(previous.properties), ...Object.keys(current.properties)]);
      const changed = [...keys].filter((key) => JSON.stringify(previous.properties[key]?.value) !== JSON.stringify(current.properties[key]?.value)).sort();
      if (changed.length) changedComponents.push({ id, properties: changed });
    }
    const previousCycles = new Set(new LineageAnalyzer(before.graph).stronglyConnectedComponents().map((cycle) => cycle.join("|")));
    const introducedCycles = new LineageAnalyzer(after.graph).stronglyConnectedComponents().filter((cycle) => !previousCycles.has(cycle.join("|")));
    const oldFindings = new Set(before.findings.map((finding) => finding.id));
    return {
      addedComponents: [...afterComponents.keys()].filter((id) => !beforeComponents.has(id)).sort(),
      removedComponents: [...beforeComponents.keys()].filter((id) => !afterComponents.has(id)).sort(),
      addedRelationships: [...afterEdges].filter((id) => !beforeEdges.has(id)).sort(),
      removedRelationships: [...beforeEdges].filter((id) => !afterEdges.has(id)).sort(),
      changedComponents: changedComponents.sort((a, b) => a.id.localeCompare(b.id)),
      introducedCycles,
      newFindingIds: after.findings.map((finding) => finding.id).filter((id) => !oldFindings.has(id)).sort()
    };
  }
}
