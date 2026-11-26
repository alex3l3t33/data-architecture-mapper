import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

const mocks = vi.hoisted(() => {
  class TFileMock {
    path: string;
    extension: string;
    stat: { mtime: number; size: number };
    content: string;

    constructor(path: string, content: string, mtime = 1) {
      this.path = path;
      this.extension = path.split(".").pop() ?? "";
      this.stat = { mtime, size: content.length };
      this.content = content;
    }
  }
  class TFolderMock {
    children: Array<TFileMock | TFolderMock> = [];
    constructor(readonly path: string) {}
  }
  return { TFileMock, TFolderMock };
});

vi.mock("obsidian", () => ({
  TFile: mocks.TFileMock,
  TFolder: mocks.TFolderMock,
  normalizePath: (value: string) => value.replace(/\/{2,}/g, "/")
}));

import { ArchitectureEngine } from "../src/services/architecture-engine";
import { project } from "./helpers";

class VaultMock {
  files = new Map<string, InstanceType<typeof mocks.TFileMock>>();

  configDir = "vault-config";
  getRoot() { return this.folderTree().get("/")!; }
  getFolderByPath(path: string) { return this.folderTree().get(path) ?? null; }

  private folderTree() {
    const root = new mocks.TFolderMock("/");
    const folders = new Map([["/", root]]);
    for (const file of this.files.values()) {
      let parent = root;
      let path = "";
      for (const segment of file.path.split("/").slice(0, -1)) {
        path = path ? `${path}/${segment}` : segment;
        let folder = folders.get(path);
        if (!folder) {
          folder = new mocks.TFolderMock(path);
          folders.set(path, folder);
          parent.children.push(folder);
        }
        parent = folder;
      }
      parent.children.push(file);
    }
    return folders;
  }
  getAbstractFileByPath(path: string) { return this.files.get(path) ?? null; }
  async cachedRead(file: InstanceType<typeof mocks.TFileMock>) { return file.content; }
  async createFolder() { return undefined; }
  async create(path: string, content: string) { this.files.set(path, new mocks.TFileMock(path, content)); }
  async modify(file: InstanceType<typeof mocks.TFileMock>, content: string) { file.content = content; }
}

describe("incremental refresh", () => {
  let vault: VaultMock;

  beforeEach(() => {
    vault = new VaultMock();
  });

  it("re-parses only a changed file and removes deleted artifacts", async () => {
    const path = "architecture/dev/orders-sink.json";
    const initial = JSON.stringify({ name: "orders-sink", config: {
      "connector.class": "io.confluent.connect.jdbc.JdbcSinkConnector",
      topics: "orders",
      "connection.url": "jdbc:postgresql://db/orders",
      "kafka.cluster": "primary"
    } });
    const file = new mocks.TFileMock(path, initial, 1);
    vault.files.set(path, file);
    const engine = new ArchitectureEngine(vault as never);
    const configuredProject = project();
    const first = await engine.scan(configuredProject);
    expect(first.graph.components.some((component) => component.type === "kafka-topic" && component.name === "orders")).toBe(true);

    file.content = initial.replace("orders\"", "payments\"");
    file.stat = { mtime: 2, size: file.content.length };
    const changed = await engine.refreshPath(configuredProject, path);
    expect(changed.graph.components.some((component) => component.type === "kafka-topic" && component.name === "payments")).toBe(true);
    expect(changed.graph.components.some((component) => component.type === "kafka-topic" && component.name === "orders")).toBe(false);

    vault.files.delete(path);
    const deleted = await engine.refreshPath(configuredProject, path);
    expect(deleted.graph.components).toHaveLength(0);
  });

  it("scans only project folders and skips the configured Obsidian settings directory", async () => {
    vault.configDir = "architecture/custom-config";
    const paths = new Map([
      ["architecture/apps/chosen/application.properties", "chosen"],
      ["architecture/apps/excluded/application.properties", "excluded"],
      ["architecture/custom-config/application.properties", "config"],
      ["architecture/generated/application.properties", "generated"],
      ["architecture/sibling/application.properties", "sibling"],
      ["outside/application.properties", "outside"]
    ]);
    for (const [path, name] of paths) {
      vault.files.set(path, new mocks.TFileMock(path, `spring.application.name=${name}\nkafka.cluster=primary`));
    }

    const engine = new ArchitectureEngine(vault as never);
    const scoped = project({
      includedFolders: ["apps", "custom-config", "generated"],
      excludedFolders: ["apps/excluded"]
    });
    const scan = await engine.scan(scoped);
    expect(scan.scannedFiles).toBe(1);
    expect(scan.graph.components.filter((component) => component.type === "application").map((app) => app.name)).toEqual(["chosen"]);
    const refreshed = await engine.refreshPath(scoped, "architecture/custom-config/application.properties");
    expect(refreshed.scannedFiles).toBe(1);
    expect((await engine.scan(project({ rootFolder: "missing-folder" }))).scannedFiles).toBe(0);
  });

  it("uses subproject-local environment folders and keeps explicit parent prefixes first", async () => {
    const inputs = [
      ["architecture/checkout/dev/application.properties", "checkout"],
      ["architecture/checkout/audit/prod/application.properties", "audit"],
      ["architecture/prod/checkout/dev/application.properties", "parent-production"]
    ] as const;
    for (const [path, name] of inputs) {
      vault.files.set(path, new mocks.TFileMock(path, `spring.application.name=${name}\nkafka.cluster=primary`));
    }
    const engine = new ArchitectureEngine(vault as never);
    const configuredProject = project();
    const before = await engine.scan(configuredProject);
    expect(before.graph.components.find((component) => component.name === "checkout")?.environment).toBe("unknown");

    configuredProject.subprojects = [
      { id: "checkout", name: "Checkout", folder: "checkout" },
      { id: "audit", name: "Audit", folder: "checkout/audit" },
      { id: "parent-production", name: "Parent production", folder: "prod/checkout" }
    ];
    const next = await engine.scan(configuredProject);
    const apps = new Map(next.graph.components.filter((component) => component.type === "application").map((component) => [component.name, component.environment]));
    expect(Object.fromEntries(apps)).toEqual({ checkout: "DEV", audit: "PRODUCTION", "parent-production": "PRODUCTION" });
  });

  it("publishes batched inventory changes together before a queued scan", async () => {
    const from = "architecture/dev/old-infrastructure.yml";
    const to = "architecture/dev/new-infrastructure.yml";
    const inventory = "infrastructure:\n  mongoInstances:\n    - name: orders-db\n      properties: { cpu: 8 }";
    vault.files.set(from, new mocks.TFileMock(from, inventory));
    const engine = new ArchitectureEngine(vault as never);
    const configuredProject = project();
    await engine.scan(configuredProject);
    const updates: string[][] = [];
    engine.onUpdate((_id, { graph }) => updates.push(graph.components.flatMap((component) =>
      component.type === "mongodb-instance" ? component.evidence.map(({ path }) => path) : []
    )));

    vault.files.delete(from);
    vault.files.set(to, new mocks.TFileMock(to, inventory));
    await Promise.all([engine.refreshPaths(configuredProject, [from, to]), engine.scan(configuredProject)]);
    expect(updates).toEqual([[to], [to]]);
  });

  it("uses the most specific environment folder when prefixes overlap", async () => {
    const path = "architecture/configs/staging/application.properties";
    vault.files.set(path, new mocks.TFileMock(path, "spring.application.name=worker\nkafka.cluster=primary"));
    const configuredProject = project({ environments: [
      { name: "DEV", folderPrefixes: ["configs"] },
      { name: "STAGING", folderPrefixes: ["configs/staging"] }
    ] });
    const result = await new ArchitectureEngine(vault as never).scan(configuredProject);
    expect(result.graph.components.find((component) => component.type === "application")?.environment).toBe("STAGING");
  });

  it("maps the demo applications, shared topics, and connectors independently in all three environments", async () => {
    const rootFolder = "connector-pipeline";
    const folders = ["dev", "staging", "prod"];
    const environments = ["DEV", "STAGING", "PRODUCTION"];
    const applications = ["order-intake", "order-review"];
    const paths = folders.flatMap((folder) => [
      ...applications.map((app) => `apps/${app}/${folder}/application.yml`),
      `${folder}/topics/orders.yaml`,
      `${folder}/connectors/orders-mongodb-sink.json`
    ]);
    for (const path of paths) {
      const file = `${rootFolder}/${path}`;
      const content = await readFile(new URL(`../examples/${file}`, import.meta.url), "utf8");
      vault.files.set(file, new mocks.TFileMock(file, content));
    }
    const configuredProject = project({
      rootFolder,
      environments: folders.map((folder, index) => ({ name: environments[index]!, folderPrefixes: [folder] })),
      subprojects: applications.map((name) => ({ id: name, name, folder: `apps/${name}` }))
    });
    const { graph } = await new ArchitectureEngine(vault as never).scan(configuredProject);
    const appNodes = graph.components.filter((component) => component.type === "application");
    const orders = graph.components.filter((component) => component.type === "kafka-topic" && component.name === "orders");
    expect(appNodes).toHaveLength(6);
    expect(orders).toHaveLength(3);
    const byId = new Map(graph.components.map((component) => [component.id, component]));
    for (const topic of orders) {
      expect(appNodes.filter((component) => component.environment === topic.environment).map((component) => component.subprojectIds?.[0]).sort()).toEqual(applications);
      const producers = graph.relationships.filter((edge) => edge.to === topic.id && edge.type === "PRODUCES").map((edge) => byId.get(edge.from));
      const consumers = graph.relationships.filter((edge) => edge.from === topic.id && edge.type === "CONSUMES").map((edge) => byId.get(edge.to));
      expect(producers.map((component) => component?.name)).toEqual(["order-intake"]);
      expect(consumers.map((component) => component?.name).sort()).toEqual(["order-review", "orders-mongodb-sink"]);
      expect([...producers, ...consumers].every((component) => component?.environment === topic.environment)).toBe(true);
    }
  });
});
