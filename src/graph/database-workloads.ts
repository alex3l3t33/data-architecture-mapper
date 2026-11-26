import type { ArchitectureComponent, ArchitectureGraph, ComponentType, SourceEvidence } from "../model/types";

export const DATABASE_TYPES: ReadonlySet<ComponentType> = new Set<ComponentType>([
  "database", "database-server", "database-table", "mongodb-collection", "mongodb-instance"
]);

export interface RelatedDatabaseWorkload {
  id: string;
  name: string;
  type: "kafka-connector" | "application";
  evidencePaths: string[];
  subprojectIds?: string[];
}

const workloadRelations = new Set(["READS_FROM", "WRITES_TO", "USES_DATABASE"]);

/** Collect workload evidence within one database hierarchy, without traversing Kafka topics. */
export function databaseWorkloads(graph: ArchitectureGraph): Map<string, RelatedDatabaseWorkload[]> {
  const components = new Map(graph.components.map((component) => [component.id, component]));
  const parents = new Map<string, Array<{ id: string; evidence: SourceEvidence[] }>>();
  const direct: Array<{ database: ArchitectureComponent; workload: RelatedDatabaseWorkload; evidence: SourceEvidence[] }> = [];
  for (const edge of graph.relationships) {
    const from = components.get(edge.from);
    const to = components.get(edge.to);
    if (!from || !to || from.unresolved || to.unresolved || edge.unresolved
      || from.environment !== to.environment || from.environment !== edge.environment) continue;

    if (DATABASE_TYPES.has(from.type) && DATABASE_TYPES.has(to.type) && (edge.type === "BELONGS_TO" || edge.type === "HOSTED_ON")) {
      const existing = parents.get(from.id) ?? [];
      existing.push({ id: to.id, evidence: edge.evidence });
      parents.set(from.id, existing);
    }
    if (!workloadRelations.has(edge.type)) continue;
    const database = DATABASE_TYPES.has(from.type) ? from : to;
    const workload = database === from ? to : from;
    if (!DATABASE_TYPES.has(database.type) || (workload.type !== "kafka-connector" && workload.type !== "application")) continue;
    const { id, name, type, subprojectIds } = workload;
    direct.push({ database, workload: { id, name, type, evidencePaths: [], subprojectIds }, evidence: edge.evidence });
  }

  const byDatabase = new Map<string, Map<string, RelatedDatabaseWorkload>>();
  for (const { database, workload, evidence } of direct) {
    const pending = [{ id: database.id, evidence }];
    const visited = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      const workloads = byDatabase.get(current.id) ?? new Map<string, RelatedDatabaseWorkload>();
      const existing = workloads.get(workload.id);
      const evidencePaths = [...new Set([...(existing?.evidencePaths ?? []), ...current.evidence.map(({ path }) => path)])].sort();
      workloads.set(workload.id, { ...workload, evidencePaths });
      byDatabase.set(current.id, workloads);
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      for (const parent of parents.get(current.id) ?? []) {
        pending.push({ id: parent.id, evidence: [...current.evidence, ...parent.evidence] });
      }
    }
  }

  return new Map([...byDatabase].map(([id, workloads]) => [
    id, [...workloads.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  ]));
}
