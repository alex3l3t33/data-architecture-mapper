import { TFile, TFolder, type Vault } from "obsidian";
import type { DiscoveredFile, ProjectConfig } from "../model/types";
import { isInside, matchesAnyGlob } from "./glob";

export class FileDiscovery {
  constructor(private readonly vault: Vault) {}

  discover(project: ProjectConfig): DiscoveredFile[] {
    const rootPath = rootFolder(project);
    const root = rootPath ? this.vault.getFolderByPath(rootPath) : this.vault.getRoot();
    if (!root) return [];

    const files: DiscoveredFile[] = [];
    const pending = [root];
    while (pending.length) {
      const folder = pending.pop()!;
      const relative = relativePath(folder.path, rootPath);
      if (this.isExcluded(folder.path, relative, project)) continue;
      if (project.includedFolders.length && !project.includedFolders.some((scope) =>
        isInside(relative, scope) || isInside(scope, relative)
      )) continue;

      for (const child of folder.children) {
        if (child instanceof TFolder) pending.push(child);
        else if (child instanceof TFile && this.isIncluded(child, project)) {
          files.push({ path: child.path, extension: child.extension.toLowerCase(), mtime: child.stat.mtime, size: child.stat.size });
        }
      }
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  isIncluded(file: Pick<TFile, "path">, project: ProjectConfig): boolean {
    const root = rootFolder(project);
    if (!isInside(file.path, root)) return false;
    const relative = relativePath(file.path, root);
    if (this.isExcluded(file.path, relative, project)) return false;
    if (project.includedFolders.length && !project.includedFolders.some((folder) => isInside(relative, folder))) return false;
    return matchesAnyGlob(relative, project.filePatterns);
  }

  private isExcluded(path: string, relative: string, project: ProjectConfig): boolean {
    const configDir = this.vault.configDir;
    return (Boolean(configDir) && isInside(path, configDir))
      || isInside(path, project.documentationFolder)
      || project.excludedFolders.some((folder) => isInside(relative, folder));
  }
}

function rootFolder(project: ProjectConfig): string {
  return project.rootFolder.replace(/^\/+|\/+$/g, "");
}

function relativePath(path: string, root: string): string {
  return root ? path.slice(root.length + 1) : path;
}
