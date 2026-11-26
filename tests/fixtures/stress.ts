import type { ParsedArtifact } from "../../src/model/types";

/** Deterministic 1,000-topic / 3,000+-relationship stress fixture. */
export function stressArtifacts(topicCount = 1_000): ParsedArtifact[] {
  const evidence = { path: "stress/generated.yaml", parser: "stress-fixture" };
  const artifacts: ParsedArtifact[] = [];
  for (let index = 0; index < topicCount; index += 1) {
    artifacts.push({
      kind: "topic",
      name: `topic-${String(index).padStart(4, "0")}`,
      environment: "PERF",
      clusterAlias: index % 2 ? "secondary" : "primary",
      technology: "kafka",
      config: { partitions: 12, replicas: 3 },
      evidence,
      diagnostics: []
    });
  }
  // Each application consumes two topics and produces two, yielding 4,000 data-flow edges.
  for (let index = 0; index < topicCount; index += 1) {
    artifacts.push({
      kind: "application",
      name: `processor-${String(index).padStart(4, "0")}`,
      environment: "PERF",
      clusterAlias: index % 2 ? "secondary" : "primary",
      technology: "synthetic",
      config: {
        "kafka.input.topics": `topic-${String(index).padStart(4, "0")},topic-${String((index + 1) % topicCount).padStart(4, "0")}`,
        "kafka.output.topics": `topic-${String((index + 2) % topicCount).padStart(4, "0")},topic-${String((index + 3) % topicCount).padStart(4, "0")}`
      },
      evidence,
      diagnostics: []
    });
  }
  return artifacts;
}
