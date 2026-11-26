import type { ParsedArtifact } from "../model/types";
import { redactedRecord, redactString } from "../security/redaction";
import { asString, firstDefined, flattenObject } from "../utils/objects";
import type { ArtifactParser, ParseContext } from "./parser";
import { collectObjects, record } from "./parser";

const TOPIC_KEYS = ["partitions", "replication.factor", "replicas", "retention.ms", "cleanup.policy", "min.insync.replicas"];
const TOPIC_NAME_KEYS = ["topic.name", "topic", "topicName", "name"];

export class TopicParser implements ArtifactParser {
  readonly id = "kafka-topic";

  parse(documents: unknown[], context: ParseContext): ParsedArtifact[] {
    const output: ParsedArtifact[] = [];
    for (const document of documents) {
      for (const object of collectObjects(document)) {
        const kind = asString(object.kind);
        const metadata = record(object.metadata) ?? {};
        const spec = record(object.spec) ?? {};
        if (kind === "KafkaTopic") {
          const config = redactedRecord({ ...flattenObject(spec), ...flattenObject(record(spec.config) ?? {}) });
          output.push(this.artifact(
            asString(firstDefined(spec, ["topicName"])) ?? asString(metadata.name) ?? "unnamed-topic",
            config,
            context,
            "strimzi"
          ));
          continue;
        }
        const config = topicConfig(object);
        if (Array.isArray(object.topics)) {
          if (isConnectDefinition(config)) continue;
          const batchContext = { ...context, ...topicScope(config, context) };
          for (const entry of object.topics) {
            const definition = record(entry);
            if (definition) this.addDefinition(output, topicConfig(definition), batchContext, true);
          }
        } else {
          this.addDefinition(output, config, context);
        }
      }
    }
    return deduplicate(output);
  }

  private addDefinition(
    output: ParsedArtifact[],
    config: Record<string, unknown>,
    context: ParseContext,
    inCatalog = false
  ): void {
    if (config.topics !== undefined || isConnectDefinition(config)) return;
    const explicitKind = asString(firstDefined(config, ["type", "component.type", "architecture.type"]));
    const isTopic = explicitKind?.toLowerCase().replace(/[_ ]/g, "-") === "kafka-topic";
    if (!inCatalog && !isTopic && !TOPIC_KEYS.some((key) => config[key] !== undefined)) return;
    const name = asString(firstDefined(config, TOPIC_NAME_KEYS));
    if (name) output.push(this.artifact(name, redactedRecord(config), context, "kafka"));
  }

  private artifact(name: string, config: Record<string, unknown>, context: ParseContext, technology: string): ParsedArtifact {
    return {
      kind: "topic",
      name,
      ...topicScope(config, context),
      technology,
      config,
      evidence: { path: context.path, parser: this.id, keys: Object.keys(config).sort() },
      diagnostics: []
    };
  }
}

function topicConfig(object: Record<string, unknown>): Record<string, unknown> {
  const config = {
    ...flattenObject(record(object.configs) ?? {}),
    ...flattenObject(record(object.config) ?? {}),
    ...flattenObject(object)
  };
  if (config["replication.factor"] === undefined && config.replicationFactor !== undefined) {
    config["replication.factor"] = config.replicationFactor;
  }
  return config;
}

function topicScope(config: Record<string, unknown>, context: ParseContext): Pick<ParseContext, "environment" | "clusterAlias"> {
  const environment = asString(firstDefined(config, ["environment", "env"]));
  const clusterAlias = asString(firstDefined(config, ["cluster", "kafka.cluster", "cluster.alias", "clusterAlias"]));
  return {
    environment: environment ? redactString(environment) : context.environment,
    clusterAlias: clusterAlias ? redactString(clusterAlias) : context.clusterAlias
  };
}

function isConnectDefinition(config: Record<string, unknown>): boolean {
  const kind = asString(config.kind);
  return kind === "KafkaConnector" || kind === "KafkaConnect" || kind === "KafkaConnectS2I"
    || firstDefined(config, ["connector.class", "connectorClass", "class", "tasks.max", "tasksMax", "topics.regex"]) !== undefined;
}

function deduplicate(artifacts: ParsedArtifact[]): ParsedArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = JSON.stringify([artifact.name, artifact.environment, artifact.clusterAlias]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
