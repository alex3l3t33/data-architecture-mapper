import { bench, describe } from "vitest";
import { GraphBuilder } from "../src/graph/builder";
import { ValidationEngine } from "../src/validation/engine";
import { MermaidGenerator } from "../src/output/mermaid";
import { project } from "./helpers";
import { stressArtifacts } from "./fixtures/stress";

const artifacts = stressArtifacts();
const configuredProject = project({ id: "stress", name: "Stress fixture" });

describe("1,000-topic architecture", () => {
  bench("graph construction", () => {
    new GraphBuilder().build(configuredProject, artifacts);
  }, { iterations: 5 });

  const graph = new GraphBuilder().build(configuredProject, artifacts);
  bench("validation", () => {
    new ValidationEngine().validate(graph, configuredProject);
  }, { iterations: 5 });

  bench("Mermaid generation", () => {
    new MermaidGenerator().generatePartitions(graph, 200);
  }, { iterations: 5 });
});
