import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createConnectExportCommands } from "../src/integrations/connect-export";
import { ParserRegistry } from "../src/parsing/registry";
import { project } from "./helpers";

const kubernetes = {
  mode: "kubernetes" as const, context: "dev'context", namespace: "kafka",
  service: "workers-connect-api", localPort: "18083", servicePort: "rest", clusterAlias: "primary"
};

it("generates environment-specific commands and quotes any kubeconfig context safely", () => {
  const config = project();
  const dev = createConnectExportCommands(config, "DEV", kubernetes);
  expect(dev.outputPath).toBe("architecture/dev/kafka-connect-rest-export.json");
  expect(dev.portForward).toBe(`kubectl --context 'dev'"'"'context' --namespace 'kafka' port-forward --address 127.0.0.1 'service/workers-connect-api' '18083:rest'`);
  expect(dev.combined).toContain("http://127.0.0.1:18083/connectors?expand=info");
  const staging = createConnectExportCommands(config, "STAGING", { mode: "direct", url: "https://example.com/kafka/connectors" });
  expect(staging.outputPath).toBe("architecture/staging/kafka-connect-rest-export.json");
  expect(staging.curl).toContain("https://example.com/kafka/connectors?expand=info");
  expect(staging.portForward).toBeUndefined();
});

it("rejects embedded URL credentials, unsafe paths, and excluded formats", () => {
  expect(() => createConnectExportCommands(project(), "DEV", { mode: "direct", url: "https://user:secret@example.com" })).toThrow(/embedded credentials/);
  expect(() => createConnectExportCommands(project({ rootFolder: "../outside" }), "DEV", kubernetes)).toThrow(/vault-relative/);
  expect(() => createConnectExportCommands(project({ filePatterns: ["**/*.yaml"] }), "DEV", kubernetes)).toThrow(/exclude/);
});

const shellAvailable = ["bash", "jq"].every((command) => spawnSync(command, ["--version"]).status === 0);
it.skipIf(!shellAvailable)("runs the generated K8s command and saves a redacted, importable snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "dam-export-test-"));
  try {
    writeFileSync(join(directory, "curl"), '#!/bin/sh\nprintf "%s" "$DAM_TEST_RESPONSE"\n', { mode: 0o700 });
    writeFileSync(join(directory, "kubectl"), '#!/usr/bin/env node\nconsole.log("Forwarding from 127.0.0.1:18083 -> 8083");\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
    const commands = createConnectExportCommands(project(), "DEV", kubernetes);
    const payload = { "orders-sink": { info: { config: {
      "connector.class": "example.JdbcSinkConnector", topics: "orders", environment: "wrong-env",
      "connection.password": "fixture-password", "connection.url": "jdbc:postgresql://user:fixture-secret@db/data?token=fixture-token"
    } } } };
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, DAM_CONNECT_CURL_CONFIG: "", DAM_TEST_RESPONSE: JSON.stringify(payload) };
    execFileSync("bash", ["-c", commands.combined!], { cwd: directory, env, timeout: 5000 });
    const output = join(directory, commands.outputPath);
    const contents = readFileSync(output, "utf8");
    expect(contents).not.toMatch(/fixture-(password|secret|token)/);
    const artifact = new ParserRegistry().parse(commands.outputPath, contents).artifacts[0];
    expect(artifact).toMatchObject({ kind: "connector", name: "orders-sink", environment: "DEV", clusterAlias: "primary" });
    expect(artifact?.config.topics).toBe("orders");
    const invalid = spawnSync("bash", ["-c", commands.curl], { cwd: directory, env: { ...env, DAM_TEST_RESPONSE: "[]" }, timeout: 5000 });
    expect(invalid.status).not.toBe(0);
    expect(readFileSync(output, "utf8")).toBe(contents);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
