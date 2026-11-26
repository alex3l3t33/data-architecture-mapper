import { isInside, matchesAnyGlob } from "../discovery/glob";
import type { ConnectExportEnvironment, ConnectExportTarget, ProjectConfig } from "../model/types";

export const CONNECT_EXPORT_ENVIRONMENTS = ["DEV", "STAGING"] as const;

export interface ConnectExportCommands {
  outputPath: string;
  portForward?: string;
  curl: string;
  combined?: string;
}

const EXPORT_NAME = "kafka-connect-rest-export.json";

// Keep only connector names and configs. Mask common secret keys and inline credentials.
const EXPORT_FILTER = String.raw`
def secret_key:
  test("(^|[._-])(password|passwd|secret|token|credential[s]?|authorization|username)([._-]|$)|api[._-]?key|private[._-]?key|sasl[._-]?jaas|keystore[._-]key"; "i");
def sanitize:
  walk(if type == "object" then
    with_entries(if .key | secret_key then .value = "[REDACTED]" else . end)
  elif type == "string" then
    gsub("://[^/@[:space:]]+@"; "://[REDACTED]@")
    | gsub("(?<prefix>[?&;](?:user(?:name)?|password|passwd|secret|token|credential|api[._-]?key)=)[^&#;]*"; "\(.prefix)[REDACTED]"; "i")
  else . end);
if length == 1 and (.[0] | type) == "object" then .[0]
else error("Expected one expanded Kafka Connect object") end
| to_entries
| map(
    if (.value.info.config | type) != "object" or (.value.info.config["connector.class"] | type) != "string"
    then error("Expanded connector info is missing a valid config") end
    | {name: .key, environment: $environment, config: (.value.info.config | sanitize)}
    + if $cluster == "" then {} else {"kafka.cluster": $cluster} end
  )
| {dataArchitectureMapperExport: 1, items: .}`;

export function defaultConnectExportTarget(environment: ConnectExportEnvironment, mode: ConnectExportTarget["mode"]): ConnectExportTarget {
  if (mode === "direct") return { mode, url: "" };
  return { mode, context: "", namespace: "", service: "", localPort: environment === "DEV" ? "18083" : "28083", servicePort: "8083" };
}

export function createConnectExportCommands(
  project: ProjectConfig,
  environment: ConnectExportEnvironment,
  target: ConnectExportTarget
): ConnectExportCommands {
  const outputPath = exportPath(project, environment);
  const request = target.mode === "direct" ? { url: directUrl(target.url), portForward: undefined } : kubernetesRequest(target);
  const clusterAlias = target.clusterAlias?.trim() ?? "";
  const curlArgs = [
    'curl -q "$@" --fail --silent --show-error --globoff --connect-timeout 10 --max-time 60',
    "--proto '=http,https'",
    ...(target.mode === "kubernetes" ? ["--noproxy 127.0.0.1"] : []),
    "--header 'Accept: application/json'",
    `--url ${quote(request.url)}`
  ].join(" ");
  const curl = [
    "(",
    "  set -eu",
    "  set -o pipefail",
    "  umask 077",
    `  output=${quote(`./${outputPath}`)}`,
    "  command -v jq >/dev/null || { echo 'Install jq to export connector configs.' >&2; exit 1; }",
    '  mkdir -p "$(dirname "$output")"',
    '  if [ -L "$output" ] || { [ -e "$output" ] && ! jq -e \'.dataArchitectureMapperExport == 1\' "$output" >/dev/null 2>&1; }; then',
    "    echo 'The output path is already used by a different file.' >&2",
    "    exit 1",
    "  fi",
    '  temp=$(mktemp "${output}.tmp.XXXXXX")',
    "  trap 'rm -f -- \"$temp\"' EXIT",
    '  if [ -n "${DAM_CONNECT_CURL_CONFIG:-}" ]; then set -- --config "$DAM_CONNECT_CURL_CONFIG"; else set --; fi',
    `  ${curlArgs} |`,
    `    jq -e -s --arg environment ${quote(environment)} --arg cluster ${quote(clusterAlias)} ${quote(EXPORT_FILTER)} > "$temp"`,
    '  mv -f -- "$temp" "$output"',
    '  printf "Saved %s\\n" "$output"',
    ")"
  ].join("\n");
  const combined = target.mode === "kubernetes" && request.portForward
    ? withPortForward(request.portForward, Number(target.localPort), curl)
    : undefined;
  return { outputPath, portForward: request.portForward, curl, combined };
}

function withPortForward(portForward: string, localPort: number, curl: string): string {
  return [
    "(",
    "  set -eu",
    "  umask 077",
    "  command -v kubectl >/dev/null || { echo 'Install kubectl to use port-forward.' >&2; exit 1; }",
    '  tunnel_log=$(mktemp "${TMPDIR:-/tmp}/dam-connect.XXXXXX")',
    "  tunnel_pid=",
    "  cleanup() {",
    '    if [ -n "$tunnel_pid" ]; then',
    '      kill "$tunnel_pid" 2>/dev/null || true',
    '      wait "$tunnel_pid" 2>/dev/null || true',
    "    fi",
    '    rm -f -- "$tunnel_log"',
    "  }",
    "  trap cleanup EXIT",
    "  trap 'exit 130' INT",
    "  trap 'exit 143' TERM",
    `  LC_ALL=C ${portForward} > "$tunnel_log" 2>&1 &`,
    "  tunnel_pid=$!",
    "  attempt=0",
    `  until grep -qF 'Forwarding from 127.0.0.1:${localPort} ->' "$tunnel_log"; do`,
    '    if ! kill -0 "$tunnel_pid" 2>/dev/null || [ "$attempt" -ge 50 ]; then',
    "      echo 'Kubernetes port-forward failed to become ready.' >&2",
    '      tail -n 5 "$tunnel_log" >&2',
    "      exit 1",
    "    fi",
    "    attempt=$((attempt + 1))",
    "    sleep 0.2",
    "  done",
    ...curl.split("\n").map((line) => `  ${line}`),
    ")"
  ].join("\n");
}

function exportPath(project: ProjectConfig, environment: ConnectExportEnvironment): string {
  const folders = project.environments.find((rule) => rule.name.toUpperCase() === environment)?.folderPrefixes ?? [];
  for (const candidate of (folders.length ? folders : [environment.toLowerCase()])) {
    const relative = vaultPath(candidate, EXPORT_NAME);
    const path = vaultPath(project.rootFolder, relative);
    if (project.documentationFolder && isInside(path, project.documentationFolder)) continue;
    if (project.includedFolders.length && !project.includedFolders.some((folder) => isInside(relative, folder))) continue;
    if (project.excludedFolders.some((folder) => isInside(relative, folder))) continue;
    if (matchesAnyGlob(relative, project.filePatterns)) return path;
  }
  throw new Error(`The project’s folder and file filters exclude the ${environment} JSON export. Include the environment folder and JSON files first.`);
}

function vaultPath(...parts: string[]): string {
  const segments = parts.join("/").split("/").filter(Boolean);
  if (segments.some((part) => part === "." || part === ".." || /[\x00-\x1f]/.test(part))) {
    throw new Error("Use a vault-relative folder without dot segments.");
  }
  return segments.join("/");
}

function directUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter the Connect REST base URL, such as https://connect.example.com.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP(S) base URL without embedded credentials, query parameters, or fragments.");
  }
  const base = url.href.replace(/\/+$/, "").replace(/\/connectors$/, "");
  return `${base}/connectors?expand=info`;
}

function kubernetesRequest(target: Extract<ConnectExportTarget, { mode: "kubernetes" }>): { url: string; portForward: string } {
  const context = target.context.trim();
  const namespace = target.namespace.trim();
  const service = target.service.trim();
  const localPort = target.localPort.trim();
  const servicePort = target.servicePort.trim();
  if (!context || !namespace || !service) throw new Error("Enter the kubeconfig context, namespace, and Connect Service name.");
  const label = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  if (!label.test(namespace) || !label.test(service)) throw new Error("Use Kubernetes namespace and Service names.");
  if (!validPort(localPort) || (!validPort(servicePort) && !/^[a-z][a-z0-9-]{0,14}$/.test(servicePort))) {
    throw new Error("Enter a local port (1–65535) and a numeric or named Service port.");
  }
  return {
    url: `http://127.0.0.1:${Number(localPort)}/connectors?expand=info`,
    portForward: `kubectl --context ${quote(context)} --namespace ${quote(namespace)} port-forward --address 127.0.0.1 ${quote(`service/${service}`)} ${quote(`${Number(localPort)}:${servicePort}`)}`
  };
}

function validPort(value: string): boolean {
  return /^\d{1,5}$/.test(value) && Number(value) > 0 && Number(value) <= 65_535;
}

function quote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}
