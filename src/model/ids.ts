import type { ComponentType, RelationshipType } from "./types";

export function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "unknown";
}

export function componentId(
  projectId: string,
  environment: string,
  type: ComponentType,
  name: string,
  scope?: string
): string {
  return [projectId, environment, type, scope, name].filter(Boolean).map((v) => slug(String(v))).join(":");
}

export function relationshipId(from: string, type: RelationshipType, to: string): string {
  return `${from}|${type}|${to}`;
}

export function deterministicId(prefix: string, value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}
