type MongoEndpointSource = "instance" | "connector" | "application";

const URI_KEYS = new Set([
  "mongodb.uri", "mongodb.url", "mongo.uri", "mongo.url", "mongodb.connection.uri", "mongodb.connection.string",
  "spring.data.mongodb.uri", "spring.mongodb.uri"
]);
const HOST_KEYS = new Set(["mongodb.host", "mongodb.hostname", "mongo.host", "spring.data.mongodb.host", "spring.mongodb.host"]);

export function mongoEndpoint(config: Record<string, unknown>, source: MongoEndpointSource): string | undefined {
  const endpoints = new Set<string>();
  const entries = Object.entries(config).map(([key, value]) => [key.toLowerCase().replace(/_/g, "."), value] as const);
  const normalizedValues = new Map(entries);
  for (const [normalized, value] of entries) {
    const genericUri = source === "application" ? ["database.url", "db.url"].includes(normalized)
      : ["connection.uri", "uri", "connectionstring", "connection.string"].includes(normalized);
    const genericHost = source === "instance" && ["host", "hostname", "address"].includes(normalized);
    const endpoint = URI_KEYS.has(normalized) || genericUri
      ? normalizeAddress(value)
      : HOST_KEYS.has(normalized) || genericHost
        ? normalizeAddress(value, normalizedValues.get(normalized.replace(/host(?:name)?$|address$/, "port")) ?? (genericHost ? config.port : undefined), true)
        : undefined;
    if (endpoint) endpoints.add(endpoint);
  }
  return endpoints.size === 1 ? endpoints.values().next().value : undefined;
}

function normalizeAddress(value: unknown, configuredPort?: unknown, allowBareHost = false): string | undefined {
  if (typeof value !== "string") return undefined;
  const uri = /^(mongodb(\+srv)?):\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value.trim());
  const srv = !!uri?.[2];
  const authority = uri?.[3] ?? (allowBareHost ? value.trim() : undefined);
  if (!authority || (!uri && authority.includes("@"))) return undefined;
  const hosts = authority.slice(authority.lastIndexOf("@") + 1).split(",");
  if (srv && hosts.length !== 1) return undefined;
  const normalized = hosts.map((entry) => normalizeHost(entry, srv, uri ? undefined : configuredPort));
  if (normalized.some((entry) => !entry)) return undefined;
  return `${srv ? "srv" : "tcp"}:${[...new Set(normalized)].sort().join(",")}`;
}

function normalizeHost(value: string, srv: boolean, configuredPort: unknown): string | undefined {
  const parts = /^([a-z\d](?:[a-z\d.-]*[a-z\d])?)\.?(?::(\d+))?$/i.exec(value);
  if (!parts?.[1]) return undefined;
  const host = parts[1].toLowerCase();
  // Node-local and short DNS aliases depend on the workload's execution context.
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((label) => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))
      || labels[0] === "localhost" || host.startsWith("127.") || host === "0.0.0.0") return undefined;
  if (srv) return parts[2] === undefined ? host : undefined;
  const port = parts[2] ?? configuredPort ?? 27017;
  if (typeof port !== "number" && !(typeof port === "string" && /^\d+$/.test(port))) return undefined;
  const number = Number(port);
  return Number.isInteger(number) && number >= 1 && number <= 65535 ? `${host}:${number}` : undefined;
}
