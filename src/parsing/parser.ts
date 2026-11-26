import type { ParsedArtifact, ParseDiagnostic } from "../model/types";

export interface ParseContext {
  path: string;
  environment?: string;
  clusterAlias?: string;
}

export interface ArtifactParser {
  readonly id: string;
  parse(documents: unknown[], context: ParseContext): ParsedArtifact[];
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function diagnostic(path: string, parser: string, message: string): ParseDiagnostic {
  return { path, parser, severity: "warning", message };
}

export function collectObjects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(collectObjects);
  const object = record(value);
  if (!object) return [];
  const items = Array.isArray(object.items) ? object.items.flatMap(collectObjects) : [];
  return [object, ...items];
}
