import type { TFile, Vault } from "obsidian";
import type { DiscoveredFile, ProjectConfig } from "../model/types";
import { isInside, matchesAnyGlob } from "./glob";

export class FileDiscovery {
  constructor(private readonly vault: Vault) {}

  discover(project: ProjectConfig): DiscoveredFile[] {
    return this.vault
      .getFiles()
      .filter((file) => this.isIncluded(file, project))
      .map((file) => ({ path: file.path, extension: file.extension.toLowerCase(), mtime: file.stat.mtime, size: file.stat.size }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  isIncluded(file: Pick<TFile, "path">, project: ProjectConfig): boolean {
    if (!isInside(file.path, project.rootFolder)) return false;
    if (isInside(file.path, project.documentationFolder)) return false;
    const relative = project.rootFolder ? file.path.slice(project.rootFolder.replace(/\/$/, "").length + 1) : file.path;
    if (project.includedFolders.length > 0 && !project.includedFolders.some((folder) => isInside(relative, folder))) return false;
    if (project.excludedFolders.some((folder) => isInside(relative, folder))) return false;
    return matchesAnyGlob(relative, project.filePatterns);
  }
}
