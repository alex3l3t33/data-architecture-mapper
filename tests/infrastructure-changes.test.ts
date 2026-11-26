import { describe, expect, it } from "vitest";
import { recordInfrastructureChanges } from "../src/history/infrastructure-changes";
import type { ArchitectureComponent, ArchitectureGraph, ArchitectureRelationship, ComponentType, ParseDiagnostic } from "../src/model/types";

const day1 = "2026-06-01T10:00:00.000Z";
const day2 = "2026-06-02T10:00:00.000Z";
const day3 = "2026-06-03T10:00:00.000Z";
const day4 = "2026-06-04T10:00:00.000Z";

function component(type: ComponentType, name: string, environment: string, values: Record<string, unknown>): ArchitectureComponent {
  const id = `orders:${environment}:${type}:${name}`;
  const evidence = [{ path: `${environment}/${name}.yml`, parser: "infrastructure" }];
  return {
    id, projectId: "orders", environment, type, name, label: name, tags: [], evidence,
    properties: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, evidence, origin: "explicit" }]))
  };
}

function graph(generatedAt: string, components: ArchitectureComponent[], diagnostics: ParseDiagnostic[] = [], relationships: ArchitectureRelationship[] = []): ArchitectureGraph {
  return { projectId: "orders", generatedAt, components, relationships, diagnostics };
}

describe("infrastructure configuration history", () => {
  it("baselines each field, then records previous and current values from later dated scans", () => {
    const before = component("infrastructure-cluster", "warehouse", "DEV", { version: "1.29.0" });
    const after = component("infrastructure-cluster", "warehouse", "DEV", { version: "1.30.0", distribution: "Kubernetes" });
    const baseline = recordInfrastructureChanges(undefined, graph(day1, [before]));
    expect(baseline?.changes).toEqual([]);
    expect(baseline?.observations[before.id]?.version).toEqual({
      value: "1.29.0", observedAt: day1, evidencePath: "DEV/warehouse.yml"
    });

    const updated = recordInfrastructureChanges(baseline, graph(day2, [after]));
    expect(updated?.changes).toEqual([expect.objectContaining({
      componentId: before.id,
      componentName: "warehouse",
      environment: "DEV",
      type: "infrastructure-cluster",
      field: "version",
      previousValue: "1.29.0",
      currentValue: "1.30.0",
      previousObservedAt: day1,
      observedAt: day2,
      evidencePath: "DEV/warehouse.yml"
    })]);
    expect(updated?.observations[before.id]?.distribution?.observedAt).toBe(day2);
    expect(baseline?.observations[before.id]?.version?.value).toBe("1.29.0");

    const persisted = JSON.parse(JSON.stringify(updated)) as NonNullable<typeof updated>;
    expect(recordInfrastructureChanges(persisted, graph(day3, [after]))).toBe(persisted);
  });

  it("uses stable component IDs to isolate same-name infrastructure in different environments", () => {
    const dev = component("cluster-node", "worker-01", "DEV", { memoryGiB: 32 });
    const prod = component("cluster-node", "worker-01", "PRODUCTION", { memoryGiB: 64 });
    prod.subprojectIds = ["review"];
    const baseline = recordInfrastructureChanges(undefined, graph(day1, [dev, prod]));
    const parent = component("infrastructure-cluster", "prod-cluster", "PRODUCTION", {});
    const after = component("cluster-node", "worker-01", "PRODUCTION", { memoryGiB: 128 });
    after.subprojectIds = ["review"];
    const edge: ArchitectureRelationship = {
      id: "worker-to-cluster", from: after.id, to: parent.id, projectId: "orders", environment: "PRODUCTION",
      type: "HOSTED_ON", evidence: [], metadata: {}
    };

    const updated = recordInfrastructureChanges(baseline, graph(day2, [dev, parent, after], [], [edge]));
    expect(updated?.changes).toEqual([expect.objectContaining({
      componentId: prod.id, componentName: "worker-01", parentPath: "prod-cluster", environment: "PRODUCTION",
      field: "memoryGiB", previousValue: 64, currentValue: 128, subprojectIds: ["review"]
    })]);
    expect(updated?.observations[dev.id]?.memoryGiB?.observedAt).toBe(day1);
  });

  it("retains the database workloads known when a change was observed", () => {
    const before = component("mongodb-instance", "orders-db", "PRODUCTION", { version: "7.0" });
    const after = component("mongodb-instance", "orders-db", "PRODUCTION", { version: "8.0" });
    const connector = component("kafka-connector", "orders-sink", "PRODUCTION", {});
    const application = component("application", "order-review", "PRODUCTION", {});
    after.subprojectIds = ["database-ops"];
    application.subprojectIds = ["order-review"];
    const relationships: ArchitectureRelationship[] = [connector, application].map((workload) => ({
      id: `${workload.id}-to-db`, projectId: "orders", environment: "PRODUCTION", from: workload.id, to: after.id,
      type: "WRITES_TO", evidence: workload.evidence, metadata: {}
    }));

    const baseline = recordInfrastructureChanges(undefined, graph(day1, [before]));
    const updated = recordInfrastructureChanges(baseline, graph(day2, [after, connector, application], [], relationships));
    expect(updated?.changes[0]).toMatchObject({
      subprojectIds: ["database-ops", "order-review"],
      relatedWorkloads: expect.arrayContaining([
        expect.objectContaining({ id: connector.id, name: "orders-sink", type: "kafka-connector", evidencePaths: ["PRODUCTION/orders-sink.yml"] }),
        expect.objectContaining({ id: application.id, name: "order-review", type: "application", evidencePaths: ["PRODUCTION/order-review.yml"], subprojectIds: ["order-review"] })
      ])
    });
    expect(recordInfrastructureChanges(updated, graph(day3, [after]))).toBe(updated);
  });

  it("redacts sensitive fields before persisting and ignores differences only in object key order or secret values", () => {
    const before = component("cluster-node", "worker", "DEV", {
      capacity: { cpu: 8, memory: "32Gi", token: "secret-before" },
      endpoint: "https://username:password-before@sample.invalid/api"
    });
    const after = component("cluster-node", "worker", "DEV", {
      capacity: { token: "secret-after", memory: "32Gi", cpu: 8 },
      endpoint: "https://username:password-after@sample.invalid/api"
    });
    const baseline = recordInfrastructureChanges(undefined, graph(day1, [before]));
    expect(JSON.stringify(baseline)).not.toMatch(/secret-before|username|password-before/);
    expect(recordInfrastructureChanges(baseline, graph(day2, [after]))).toBe(baseline);

    const expanded = component("cluster-node", "worker", "DEV", { capacity: { cpu: 16, memory: "32Gi", token: "secret-after" } });
    const updated = recordInfrastructureChanges(baseline, graph(day3, [expanded]));
    expect(updated?.changes[0]).toMatchObject({
      previousValue: { cpu: 8, memory: "32Gi", token: "[REDACTED]" },
      currentValue: { cpu: 16, memory: "32Gi", token: "[REDACTED]" }
    });
    expect(JSON.stringify(updated)).not.toContain("secret-after");
  });

  it("keeps last known values when fields or components disappear or a source is malformed", () => {
    const before = component("edge-node", "transfer", "DEV", { osImage: "RHEL 8", memoryGiB: 32 });
    const nonInfrastructure = component("kafka-topic", "orders", "DEV", { partitions: 6 });
    expect(recordInfrastructureChanges(undefined, graph(day1, [nonInfrastructure]))).toBeUndefined();

    const baseline = recordInfrastructureChanges(undefined, graph(day1, [before, nonInfrastructure]));
    expect(recordInfrastructureChanges(baseline, graph(day2, []))).toBe(baseline);

    const partial = component("edge-node", "transfer", "DEV", { osImage: null });
    expect(recordInfrastructureChanges(baseline, graph(day2, [partial]))).toBe(baseline);
    const malformed = component("edge-node", "transfer", "DEV", { osImage: "RHEL 0" });
    const diagnostics: ParseDiagnostic[] = [{ path: "DEV/transfer.yml", parser: "yaml", severity: "error", message: "Invalid syntax" }];
    expect(recordInfrastructureChanges(baseline, graph(day3, [malformed], diagnostics))).toBe(baseline);

    const after = component("edge-node", "transfer", "DEV", { osImage: "RHEL 9" });
    const updated = recordInfrastructureChanges(baseline, graph(day4, [after]));
    expect(updated?.changes).toEqual([expect.objectContaining({
      field: "osImage", previousValue: "RHEL 8", previousObservedAt: day1, currentValue: "RHEL 9", observedAt: day4
    })]);
    expect(updated?.observations[before.id]?.memoryGiB?.value).toBe(32);
  });
});
