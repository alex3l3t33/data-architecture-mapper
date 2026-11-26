import type { ParsedArtifact } from "../model/types";
import { redactedRecord } from "../security/redaction";
import { asString, firstDefined, flattenObject } from "../utils/objects";
import type { ArtifactParser, ParseContext } from "./parser";
import { collectObjects, record } from "./parser";

export class ApplicationParser implements ArtifactParser {
  readonly id = "application-config";

  parse(documents: unknown[], context: ParseContext): ParsedArtifact[] {
    const output: ParsedArtifact[] = [];
    for (const document of documents) {
      for (const object of collectObjects(document)) {
        const kind = asString(object.kind);
        const metadata = record(object.metadata) ?? {};
        const spec = record(object.spec) ?? {};
        if (kind === "Deployment" || kind === "StatefulSet") {
          const config = flattenObject(spec);
          const environment = extractContainerEnvironment(spec);
          output.push(this.artifact(asString(metadata.name) ?? fileStem(context.path), { ...config, ...environment }, context, "kubernetes"));
          continue;
        }

        const services = record(object.services);
        if (services) {
          for (const [name, serviceValue] of Object.entries(services)) {
            const service = record(serviceValue);
            if (service) output.push(this.artifact(name, flattenObject(service), context, "docker-compose"));
          }
          continue;
        }

        const flat = flattenObject(object);
        if (isApplicationConfig(flat, context.path)) {
          const name = asString(firstDefined(flat, ["spring.application.name", "application.name", "app.name", "name"])) ?? fileStem(context.path);
          output.push(this.artifact(name, flat, context, context.path.includes("application.") ? "spring-boot" : "application"));
        }
      }
    }
    return deduplicate(output);
  }

  private artifact(name: string, config: Record<string, unknown>, context: ParseContext, technology: string): ParsedArtifact {
    const redacted = redactedRecord(config);
    return {
      kind: "application",
      name,
      environment: asString(firstDefined(config, ["environment", "env", "spring.profiles.active"])) ?? context.environment,
      clusterAlias: asString(firstDefined(config, ["kafka.cluster", "cluster.alias"])) ?? context.clusterAlias,
      technology,
      config: redacted,
      evidence: { path: context.path, parser: this.id, keys: Object.keys(redacted).sort() },
      diagnostics: []
    };
  }
}

function isApplicationConfig(config: Record<string, unknown>, path: string): boolean {
  if (/application\.(ya?ml|properties)$/i.test(path)) return true;
  return Object.keys(config).some((key) =>
    /^(spring\.kafka|spring\.cloud\.stream|kafka\.(bootstrap|consumer|producer)|mp\.messaging|quarkus\.kafka)/i.test(key)
  );
}

function extractContainerEnvironment(spec: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const containers = findArraysByKey(spec, "containers");
  for (const container of containers.flat()) {
    const containerRecord = record(container);
    if (!containerRecord || !Array.isArray(containerRecord.env)) continue;
    for (const variable of containerRecord.env) {
      const entry = record(variable);
      const name = asString(entry?.name);
      if (name && entry?.value !== undefined) output[name] = entry.value;
    }
  }
  return output;
}

function findArraysByKey(value: unknown, key: string): unknown[][] {
  const object = record(value);
  if (!object) return [];
  const own = Array.isArray(object[key]) ? [object[key] as unknown[]] : [];
  return [...own, ...Object.values(object).flatMap((child) => findArraysByKey(child, key))];
}

function fileStem(path: string): string {
  return path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "unnamed-application";
}

function deduplicate(artifacts: ParsedArtifact[]): ParsedArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = `${artifact.name}|${artifact.technology}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
