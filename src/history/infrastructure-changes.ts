import { databaseWorkloads, type RelatedDatabaseWorkload } from "../graph/database-workloads";
import { INFRASTRUCTURE_TYPES, infrastructureParentPaths } from "../graph/infrastructure";
import { deterministicId } from "../model/ids";
import type { ArchitectureGraph, ComponentType } from "../model/types";
import { redactString, redactValue } from "../security/redaction";
import { stableJson } from "../utils/objects";

interface InfrastructureObservation {
  value: unknown;
  /** The scan that first observed this value in the current run of identical observations. */
  observedAt: string;
  evidencePath?: string;
}

export interface InfrastructureChange {
  id: string;
  componentId: string;
  componentName: string;
  environment: string;
  type: ComponentType;
  subprojectIds: string[];
  field: string;
  previousValue: unknown;
  currentValue: unknown;
  previousObservedAt: string;
  observedAt: string;
  parentPath?: string;
  evidencePath?: string;
  relatedWorkloads?: RelatedDatabaseWorkload[];
}

export interface InfrastructureTimeline {
  observations: Record<string, Record<string, InfrastructureObservation>>;
  changes: InfrastructureChange[];
}

/** Records configuration observations. Missing fields or components leave the last known values in place. */
export function recordInfrastructureChanges(previous: InfrastructureTimeline | undefined, graph: ArchitectureGraph): InfrastructureTimeline | undefined {
  const observedAt = graph.generatedAt;
  const errorPaths = new Set(graph.diagnostics.filter((item) => item.severity === "error").map((item) => item.path));
  const observations: Array<[string, Record<string, InfrastructureObservation>]> = [];
  const changes: InfrastructureChange[] = [];
  let parentPaths: Map<string, string> | undefined;
  let workloads: ReturnType<typeof databaseWorkloads> | undefined;

  for (const component of graph.components) {
    if (!INFRASTRUCTURE_TYPES.has(component.type)) continue;
    const baseline = previous && Object.hasOwn(previous.observations, component.id)
      ? previous.observations[component.id]
      : undefined;
    const changedFields: Array<[string, InfrastructureObservation]> = [];
    const conflicts = component.properties._conflicts?.value;

    for (const [field, property] of Object.entries(component.properties).sort(([left], [right]) => left.localeCompare(right))) {
      if (field === "_conflicts" || property.origin === "unknown" || property.value == null) continue;
      if (typeof property.value === "string" && !property.value.trim()) continue;
      if (conflicts && typeof conflicts === "object" && Object.hasOwn(conflicts, field)) continue;
      const prior = baseline && Object.hasOwn(baseline, field) ? baseline[field] : undefined;
      const evidence = property.evidence.length ? property.evidence : component.evidence;
      if (evidence.some((item) => errorPaths.has(item.path)) || (prior?.evidencePath && errorPaths.has(prior.evidencePath))) continue;

      const value = redactValue(property.value, field);
      const evidencePath = evidence[0]?.path ? redactString(evidence[0].path) : undefined;
      if (prior && stableJson(prior.value, 0) === stableJson(value, 0)) continue;
      changedFields.push([field, { value, observedAt, evidencePath }]);
      if (!prior) continue;

      parentPaths ??= infrastructureParentPaths(graph);
      const parentPath = parentPaths.get(component.id);
      workloads ??= databaseWorkloads(graph);
      const relatedWorkloads = workloads.get(component.id)?.map((workload) => ({
        ...workload,
        name: redactString(workload.name),
        evidencePaths: workload.evidencePaths.map(redactString),
        ...(workload.subprojectIds ? { subprojectIds: [...workload.subprojectIds] } : {})
      }));
      const subprojectIds = new Set(component.subprojectIds);
      for (const workload of relatedWorkloads ?? []) {
        for (const id of workload.subprojectIds ?? []) subprojectIds.add(id);
      }
      const position = (previous?.changes.length ?? 0) + changes.length;
      changes.push({
        id: deterministicId("infrastructure-change", JSON.stringify([component.id, field, observedAt, position])),
        componentId: component.id,
        componentName: redactString(component.name),
        environment: redactString(component.environment),
        type: component.type,
        subprojectIds: [...subprojectIds].sort(),
        field,
        previousValue: prior.value,
        currentValue: value,
        previousObservedAt: prior.observedAt,
        observedAt,
        parentPath: parentPath ? redactString(parentPath) : undefined,
        evidencePath,
        ...(relatedWorkloads?.length ? { relatedWorkloads } : {})
      });
    }

    if (changedFields.length) observations.push([component.id, { ...baseline, ...Object.fromEntries(changedFields) }]);
  }

  if (!observations.length) return previous;
  return {
    observations: { ...previous?.observations, ...Object.fromEntries(observations) },
    changes: changes.length ? [...(previous?.changes ?? []), ...changes] : previous?.changes ?? []
  };
}
