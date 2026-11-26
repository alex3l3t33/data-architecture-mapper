import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  Adapter: class {
    constructor(private readonly root: string) {}
    getBasePath(): string { return this.root; }
  }
}));
vi.mock("obsidian", () => ({
  FileSystemAdapter: mocks.Adapter,
  Platform: { isDesktopApp: true, isMacOS: true }
}));

import { connectScriptPath } from "../src/integrations/connect-script-path";
import { runConnectScript } from "../src/integrations/connect-script-runner";

it("accepts a named vault-relative shell script and rejects paths that escape the vault", () => {
  expect(connectScriptPath("Scripts/Export staging.sh")).toBe("Scripts/Export staging.sh");
  for (const name of ["../export.sh", "/tmp/export.sh", "Scripts/../export.sh", "C:\\export.sh", "export.py"]) {
    expect(() => connectScriptPath(name)).toThrow(/vault-relative/);
  }
});

it.skipIf(process.platform === "win32")("runs the exact selected script in the vault and blocks symlinks outside it", async () => {
  const vault = await mkdtemp(join(tmpdir(), "dam-vault-test-"));
  const other = await mkdtemp(join(tmpdir(), "dam-outside-test-"));
  try {
    const app = { vault: { adapter: new mocks.Adapter(vault) } } as never;
    const name = "release; export.sh";
    await writeFile(join(vault, name), 'printf "%s" "$DAM_CONNECT_ENVIRONMENT" > result');
    await runConnectScript(app, "STAGING", name);
    expect(await readFile(join(vault, "result"), "utf8")).toBe("STAGING");
    await writeFile(join(other, "outside.sh"), "exit 0");
    await symlink(join(other, "outside.sh"), join(vault, "linked.sh"));
    await expect(runConnectScript(app, "DEV", "linked.sh")).rejects.toThrow(/inside this vault/);
  } finally {
    await Promise.all([vault, other].map((folder) => rm(folder, { recursive: true, force: true })));
  }
});
