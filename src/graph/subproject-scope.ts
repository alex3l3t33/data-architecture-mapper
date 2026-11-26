import type { ArchitectureGraph } from "../model/types";

export function graphForSubproject(graph: ArchitectureGraph, id: string): ArchitectureGraph {
  const components = graph.components.filter((component) => component.subprojectIds?.includes(id));
  const componentIds = new Set(components.map((component) => component.id));
  const relationships = graph.relationships.filter((edge) => componentIds.has(edge.from) && componentIds.has(edge.to));
  return { ...graph, components, relationships };
}
