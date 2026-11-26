import type { ParsedArtifact } from "../model/types";
import { asString, firstDefined, flattenObject } from "../utils/objects";
import { redactedRecord } from "../security/redaction";
import type { ArtifactParser, ParseContext } from "./parser";
import { collectObjects, record } from "./parser";
import { parseProperties } from "./properties";

export class KafkaConnectParser implements ArtifactParser {
  readonly id = "kafka-connect";

  parse(documents: unknown[], context: ParseContext): ParsedArtifact[] {
    const artifacts: ParsedArtifact[] = [];
    for (const document of documents) {
      for (const object of collectObjects(document)) {
        artifacts.push(...this.fromObject(object, context));
      }
    }
    return uniqueArtifacts(artifacts);
  }

  private fromObject(object: Record<string, unknown>, context: ParseContext): ParsedArtifact[] {
    const kind = asString(object.kind);
    const metadata = record(object.metadata) ?? {};
    const spec = record(object.spec) ?? {};
    const output: ParsedArtifact[] = [];

    if (kind === "KafkaConnector") {
      const specConfig = record(spec.config) ?? {};
      const config = redactedRecord({
        ...specConfig,
        "connector.class": firstDefined(spec, ["class", "connectorClass"]),
        "tasks.max": firstDefined(spec, ["tasksMax", "tasks.max"])
      });
      output.push(this.artifact(asString(metadata.name) ?? asString(specConfig.name) ?? fileStem(context.path), config, context, "strimzi"));
    }

    if (kind === "KafkaConnect" || kind === "KafkaConnectS2I") {
      const config = redactedRecord({ ...flattenObject(spec), ...flattenObject(record(spec.config) ?? {}) });
      output.push({
        kind: "connect-worker",
        name: asString(metadata.name) ?? fileStem(context.path),
        environment: context.environment,
        clusterAlias: context.clusterAlias,
        technology: "strimzi",
        config,
        evidence: { path: context.path, parser: this.id, keys: Object.keys(config) },
        diagnostics: []
      });
    }

    const { config: nestedConfig, ...envelope } = object;
    const configObject = record(nestedConfig);
    const merged = configObject ? { ...envelope, ...configObject } : object;
    const flat = flattenObject(merged);
    const connectorClass = firstDefined(flat, ["connector.class", "connectorClass", "class"]);
    if (connectorClass) {
      const name = asString(firstDefined(object, ["name", "connector.name"]))
        ?? asString(firstDefined(flat, ["name", "connector.name"]))
        ?? fileStem(context.path);
      const config = redactedRecord(flat);
      const artifact = this.artifact(name, config, context, connectorTechnology(asString(connectorClass) ?? ""));
      if (configObject) {
        const safeEnvelope = redactedRecord(envelope);
        artifact.environment = asString(safeEnvelope.environment) ?? artifact.environment;
        artifact.clusterAlias = asString(safeEnvelope["kafka.cluster"]) ?? artifact.clusterAlias;
      }
      output.push(artifact);
    }

    if (kind === "ConfigMap") {
      const data = record(object.data) ?? {};
      for (const [key, value] of Object.entries(data)) {
        if (typeof value !== "string") continue;
        const nested = parseEmbedded(value);
        const nestedFlat = flattenObject(nested);
        if (firstDefined(nestedFlat, ["connector.class", "connectorClass"])) {
          output.push(this.artifact(asString(nestedFlat.name) ?? key.replace(/\.(json|properties|ya?ml)$/i, ""), redactedRecord(nestedFlat), context, "configmap"));
        }
      }
    }
    return output;
  }

  private artifact(name: string, config: Record<string, unknown>, context: ParseContext, technology: string): ParsedArtifact {
    return {
      kind: "connector",
      name,
      environment: asString(firstDefined(config, ["environment", "env"])) ?? context.environment,
      clusterAlias: asString(firstDefined(config, ["kafka.cluster", "cluster", "cluster.alias"])) ?? context.clusterAlias,
      technology,
      config,
      evidence: { path: context.path, parser: this.id, keys: Object.keys(config).sort() },
      diagnostics: []
    };
  }
}

function parseEmbedded(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    return record(parsed) ?? {};
  } catch {
    return parseProperties(content);
  }
}

function connectorTechnology(connectorClass: string): string {
  const value = connectorClass.toLowerCase();
  if (value.includes("debezium")) return "debezium";
  if (value.includes("mongodb") || value.includes("mongo")) return "mongodb-kafka";
  if (value.includes("jdbc")) return "jdbc";
  if (value.includes("hdfs")) return "hdfs";
  if (value.includes("elastic")) return "elasticsearch";
  if (value.includes("s3") || value.includes("gcs") || value.includes("azure")) return "object-storage";
  return "kafka-connect";
}

function fileStem(path: string): string {
  return path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "unnamed-connector";
}

function uniqueArtifacts(artifacts: ParsedArtifact[]): ParsedArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const connectorClass = String(artifact.config["connector.class"] ?? artifact.config.connectorClass ?? "");
    const key = `${artifact.kind}|${artifact.name}|${connectorClass}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
