import type { ArchitectureComponent, ArchitectureGraph, ComponentType } from "../model/types";

export const INFRASTRUCTURE_TYPES: ReadonlySet<ComponentType> = new Set<ComponentType>([
  "infrastructure-cluster", "cluster-node", "edge-node", "cft-service", "kubernetes-namespace", "resource-quota", "mongodb-instance"
]);

export function infrastructureTypeLabel(type: ComponentType): string {
  switch (type) {
    case "infrastructure-cluster": return "Cluster";
    case "cluster-node": return "Cluster node";
    case "edge-node": return "Edge node";
    case "cft-service": return "CFT";
    case "kubernetes-namespace": return "Namespace";
    case "resource-quota": return "Resource quota";
    case "mongodb-instance": return "MongoDB instance";
    default: return type;
  }
}

export function infrastructureParentPaths(graph: ArchitectureGraph): Map<string, string> {
  const components = new Map(graph.components
    .filter((component) => INFRASTRUCTURE_TYPES.has(component.type))
    .map((component) => [component.id, component]));
  const parents = new Map<string, ArchitectureComponent>();
  for (const edge of graph.relationships) {
    if (edge.type !== "HOSTED_ON" && edge.type !== "BELONGS_TO") continue;
    const parent = components.get(edge.to);
    if (parent && components.has(edge.from) && !parents.has(edge.from)) parents.set(edge.from, parent);
  }
  const paths = new Map<string, string>();
  for (const childId of parents.keys()) {
    const names: string[] = [];
    const visited = new Set([childId]);
    let parent = parents.get(childId);
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id);
      names.unshift(parent.name);
      parent = parents.get(parent.id);
    }
    if (names.length) paths.set(childId, names.join(" / "));
  }
  return paths;
}

export function infrastructureCharacteristics(component: ArchitectureComponent): Array<[string, unknown]> {
  return Object.entries(component.properties)
    .filter(([key, property]) => key !== "_conflicts" && property.value !== undefined)
    .map(([key, property]) => [key, property.value]);
}
