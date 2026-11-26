import type { ArchitectureComponent, ArchitectureGraph, PropertyDifference, SubprojectConfig } from "../model/types";

export class EnvironmentComparator {
  compare(
    graph: ArchitectureGraph,
    ignoredProperties: string[] = [],
    explicitMappings: Record<string, string> = {},
    subprojects: readonly SubprojectConfig[] = []
  ): PropertyDifference[] {
    const ignored = new Set(ignoredProperties);
    const names = new Map(subprojects.map(({ id, name }) => [id, name]));
    const groups = new Map<string, { label: string; components: ArchitectureComponent[] }>();
    for (const component of graph.components) {
      const mappedName = explicitMappings[`${component.environment}:${component.id}`]
        ?? explicitMappings[`${component.environment}:${component.name}`]
        ?? component.name;
      const cluster = clusterKey(component);
      const memberships = component.type === "application" ? [...(component.subprojectIds ?? [])].sort() : [];
      const key = JSON.stringify([component.type, mappedName, cluster, memberships]);
      const label = memberships.length
        ? `${mappedName} · ${memberships.map((id) => names.get(id) ?? id).join(", ")}`
        : `${component.type}|${mappedName}|${cluster}`;
      const group = groups.get(key) ?? { label, components: [] };
      group.components.push(component);
      groups.set(key, group);
    }
    const output: PropertyDifference[] = [];
    for (const { label: componentKey, components } of groups.values()) {
      if (new Set(components.map((component) => component.environment)).size < 2) continue;
      const propertyNames = new Set(components.flatMap((component) => Object.keys(component.properties)).filter((key) => key !== "_conflicts"));
      for (const property of propertyNames) {
        const values = Object.fromEntries(components.map((component) => [component.environment, component.properties[property]?.value]));
        const distinct = new Set(Object.values(values).map((value) => JSON.stringify(value)));
        if (distinct.size > 1) output.push({ componentKey, property, values, ignored: ignored.has(property) });
      }
    }
    return output.sort((a, b) => `${a.componentKey}|${a.property}`.localeCompare(`${b.componentKey}|${b.property}`));
  }
}

function clusterKey(component: ArchitectureComponent): string {
  return component.type === "kafka-topic" ? component.kafkaClusterId?.split(":").pop() ?? "unknown" : "";
}
