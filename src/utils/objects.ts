export function flattenObject(
  value: unknown,
  prefix = "",
  output: Record<string, unknown> = {}
): Record<string, unknown> {
  if (Array.isArray(value)) {
    output[prefix] = value;
    return output;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (child && typeof child === "object" && !Array.isArray(child)) flattenObject(child, path, output);
      else output[path] = child;
    }
  } else if (prefix) output[prefix] = value;
  return output;
}

export function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter((entry): entry is string => Boolean(entry));
  const string = asString(value);
  if (!string) return [];
  return string.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function firstDefined(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  return undefined;
}

export function sortedRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
}

export function stableJson(value: unknown, spacing = 2): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, normalize(child)])
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value), null, spacing);
}
