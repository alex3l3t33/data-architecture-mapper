import { FileSystemAdapter, Platform, type App } from "obsidian";
import type { ConnectExportEnvironment } from "../model/types";
import { connectScriptPath } from "./connect-script-path";

const activeVaults = new Set<string>();

export function supportsConnectScripts(app: App): boolean {
  return Platform.isDesktopApp && (Platform.isMacOS || Platform.isLinux) && app.vault.adapter instanceof FileSystemAdapter;
}

export async function runConnectScript(app: App, environment: ConnectExportEnvironment, value: string): Promise<void> {
  const adapter = app.vault.adapter;
  if (!supportsConnectScripts(app) || !(adapter instanceof FileSystemAdapter)) {
    throw new Error("Script launching requires Obsidian desktop on macOS or Linux.");
  }
  const scriptPath = connectScriptPath(value);
  // Load Node APIs only inside the explicit desktop action.
  const fs = require("fs/promises") as typeof import("node:fs/promises");
  const path = require("path") as typeof import("node:path");
  const { spawn } = require("child_process") as typeof import("node:child_process");

  const vaultRoot = await fs.realpath(adapter.getBasePath());
  if (activeVaults.has(vaultRoot)) throw new Error("A script is already running for this vault.");
  activeVaults.add(vaultRoot);
  try {
    let script: string;
    try {
      script = await fs.realpath(path.resolve(vaultRoot, scriptPath));
      const relative = path.relative(vaultRoot, script);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)
        || path.extname(script) !== ".sh" || !(await fs.stat(script)).isFile()) {
        throw new Error("Invalid script");
      }
    } catch {
      throw new Error("Select an existing .sh file inside this vault.");
    }
    await new Promise<void>((resolve, reject) => {
      const processHandle = spawn("/bin/bash", [script], {
        cwd: vaultRoot,
        env: { ...process.env, DAM_CONNECT_ENVIRONMENT: environment },
        stdio: "ignore",
        shell: false
      });
      processHandle.once("error", () => reject(new Error("Could not start Bash.")));
      processHandle.once("close", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(signal ? `Script stopped with ${signal}.` : `Script exited with status ${String(code)}.`));
      });
    });
  } finally {
    activeVaults.delete(vaultRoot);
  }
}
