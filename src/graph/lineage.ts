import type { ArchitectureGraph, ArchitectureRelationship } from "../model/types";

export interface TraversalResult {
  componentIds: string[];
  relationshipIds: string[];
  depthByComponent: Record<string, number>;
  cyclesEncountered: string[][];
}

export class LineageAnalyzer {
  constructor(private readonly graph: ArchitectureGraph) {}

  downstream(startId: string, maxDepth = Number.POSITIVE_INFINITY): TraversalResult {
    return this.traverse(startId, "downstream", maxDepth);
  }

  upstream(startId: string, maxDepth = Number.POSITIVE_INFINITY): TraversalResult {
    return this.traverse(startId, "upstream", maxDepth);
  }

  shortestPath(from: string, to: string): string[] | undefined {
    const queue: string[][] = [[from]];
    const seen = new Set([from]);
    const adjacency = this.adjacency("downstream");
    while (queue.length) {
      const path = queue.shift()!;
      const last = path[path.length - 1]!;
      if (last === to) return path;
      for (const edge of adjacency.get(last) ?? []) {
        if (!seen.has(edge.to)) {
          seen.add(edge.to);
          queue.push([...path, edge.to]);
        }
      }
    }
    return undefined;
  }

  paths(from: string, to: string, maxDepth = 20, maxPaths = 100): string[][] {
    const output: string[][] = [];
    const adjacency = this.adjacency("downstream");
    const visit = (current: string, path: string[]): void => {
      if (output.length >= maxPaths || path.length - 1 > maxDepth) return;
      if (current === to) {
        output.push(path);
        return;
      }
      for (const edge of adjacency.get(current) ?? []) {
        if (!path.includes(edge.to)) visit(edge.to, [...path, edge.to]);
      }
    };
    visit(from, [from]);
    return output;
  }

  stronglyConnectedComponents(): string[][] {
    const adjacency = this.adjacency("downstream");
    let index = 0;
    const indexes = new Map<string, number>();
    const lowLinks = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const output: string[][] = [];

    const connect = (node: string): void => {
      indexes.set(node, index);
      lowLinks.set(node, index);
      index += 1;
      stack.push(node);
      onStack.add(node);
      for (const edge of adjacency.get(node) ?? []) {
        const target = edge.to;
        if (!indexes.has(target)) {
          connect(target);
          lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(target)!));
        } else if (onStack.has(target)) lowLinks.set(node, Math.min(lowLinks.get(node)!, indexes.get(target)!));
      }
      if (lowLinks.get(node) === indexes.get(node)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== node);
        const selfLoop = component.length === 1 && (adjacency.get(component[0]!) ?? []).some((edge) => edge.to === component[0]);
        if (component.length > 1 || selfLoop) output.push(component.sort());
      }
    };
    for (const component of this.graph.components) if (!indexes.has(component.id)) connect(component.id);
    return output.sort((a, b) => a.join("|").localeCompare(b.join("|")));
  }

  private traverse(startId: string, direction: "upstream" | "downstream", maxDepth: number): TraversalResult {
    const adjacency = this.adjacency(direction);
    const queue: Array<{ id: string; depth: number; path: string[] }> = [{ id: startId, depth: 0, path: [startId] }];
    const depthByComponent: Record<string, number> = { [startId]: 0 };
    const relationshipIds = new Set<string>();
    const cycles: string[][] = [];
    while (queue.length) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;
      for (const edge of adjacency.get(current.id) ?? []) {
        relationshipIds.add(edge.id);
        const cycleAt = current.path.indexOf(edge.to);
        if (cycleAt >= 0) {
          cycles.push([...current.path.slice(cycleAt), edge.to]);
          continue;
        }
        const nextDepth = current.depth + 1;
        if (depthByComponent[edge.to] === undefined || nextDepth < depthByComponent[edge.to]!) {
          depthByComponent[edge.to] = nextDepth;
          queue.push({ id: edge.to, depth: nextDepth, path: [...current.path, edge.to] });
        }
      }
    }
    return {
      componentIds: Object.keys(depthByComponent).sort((a, b) => depthByComponent[a]! - depthByComponent[b]! || a.localeCompare(b)),
      relationshipIds: [...relationshipIds].sort(),
      depthByComponent,
      cyclesEncountered: uniqueCycles(cycles)
    };
  }

  private adjacency(direction: "upstream" | "downstream"): Map<string, Array<ArchitectureRelationship & { to: string }>> {
    const output = new Map<string, Array<ArchitectureRelationship & { to: string }>>();
    for (const edge of this.graph.relationships) {
      if (edge.metadata.association === true) continue;
      const from = direction === "downstream" ? edge.from : edge.to;
      const to = direction === "downstream" ? edge.to : edge.from;
      const list = output.get(from) ?? [];
      list.push({ ...edge, to });
      output.set(from, list);
    }
    for (const list of output.values()) list.sort((a, b) => a.id.localeCompare(b.id));
    return output;
  }
}

function uniqueCycles(cycles: string[][]): string[][] {
  const output = new Map<string, string[]>();
  for (const cycle of cycles) {
    const body = cycle.slice(0, -1);
    if (!body.length) continue;
    const rotations = body.map((_, index) => [...body.slice(index), ...body.slice(0, index)]);
    const canonical = rotations.map((entry) => entry.join("|")).sort()[0]!;
    output.set(canonical, [...canonical.split("|"), canonical.split("|")[0]!]);
  }
  return [...output.values()].sort((a, b) => a.join("|").localeCompare(b.join("|")));
}
