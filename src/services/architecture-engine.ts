import { normalizePath, TFile, type Vault } from "obsidian";
import type {
  ArchitectureGraph,
  DiscoveredFile,
  ParsedArtifact,
  ParseDiagnostic,
  ProjectConfig,
  ValidationFinding
} from "../model/types";
import { FileDiscovery } from "../discovery/file-discovery";
import { subprojectForPath } from "../discovery/subprojects";
import { ParserRegistry } from "../parsing/registry";
import { GraphBuilder } from "../graph/builder";
import { ValidationEngine } from "../validation/engine";
import { GENERATED_MARKER, MarkdownGenerator } from "../output/markdown";

interface CachedFile {
  mtime: number;
  size: number;
  environment?: string;
  artifacts: ParsedArtifact[];
  diagnostics: ParseDiagnostic[];
}

export interface ProjectAnalysis {
  graph: ArchitectureGraph;
  findings: ValidationFinding[];
  scannedFiles: number;
  parsedArtifacts: number;
  durationMs: number;
}

export interface DocumentationWriteResult {
  written: string[];
  skipped: string[];
}

export class ArchitectureEngine {
  private readonly discovery: FileDiscovery;
  private readonly registry = new ParserRegistry();
  private readonly builder = new GraphBuilder();
  private readonly validation = new ValidationEngine();
  private readonly markdown = new MarkdownGenerator();
  private readonly cache = new Map<string, Map<string, CachedFile>>();
  private readonly analyses = new Map<string, ProjectAnalysis>();
  private readonly pendingAnalyses = new Map<string, Promise<void>>();
  private listeners = new Set<(projectId: string, analysis: ProjectAnalysis) => void>();

  constructor(private readonly vault: Vault) {
    this.discovery = new FileDiscovery(vault);
  }

  current(projectId: string): ProjectAnalysis | undefined {
    return this.analyses.get(projectId);
  }

  onUpdate(listener: (projectId: string, analysis: ProjectAnalysis) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  scan(project: ProjectConfig, force = false): Promise<ProjectAnalysis> {
    return this.enqueueAnalysis(project.id, () => this.scanProject(project, force));
  }

  private async scanProject(project: ProjectConfig, force: boolean): Promise<ProjectAnalysis> {
    const started = performance.now();
    const files = this.discovery.discover(project);
    const projectCache = this.cache.get(project.id) ?? new Map<string, CachedFile>();
    const currentPaths = new Set(files.map((file) => file.path));
    for (const path of projectCache.keys()) if (!currentPaths.has(path)) projectCache.delete(path);
    for (const file of files) {
      const cached = projectCache.get(file.path);
      const environment = environmentForPath(project, file.path);
      if (!force && cached?.mtime === file.mtime && cached.size === file.size && cached.environment === environment) continue;
      await this.parseFile(file, projectCache, environment);
    }
    this.cache.set(project.id, projectCache);
    return this.buildAnalysis(project, projectCache, files.length, started);
  }

  refreshPath(project: ProjectConfig, path: string): Promise<ProjectAnalysis> {
    return this.refreshPaths(project, [path]);
  }

  refreshPaths(project: ProjectConfig, paths: readonly string[]): Promise<ProjectAnalysis> {
    return this.enqueueAnalysis(project.id, () => this.refreshProjectPaths(project, paths));
  }

  private async refreshProjectPaths(project: ProjectConfig, paths: readonly string[]): Promise<ProjectAnalysis> {
    const started = performance.now();
    const projectCache = this.cache.get(project.id) ?? new Map<string, CachedFile>();
    for (const path of paths) {
      const abstract = this.vault.getAbstractFileByPath(path);
      if (!(abstract instanceof TFile) || !this.discovery.isIncluded(abstract, project)) projectCache.delete(path);
      else await this.parseFile({
        path: abstract.path,
        extension: abstract.extension,
        mtime: abstract.stat.mtime,
        size: abstract.stat.size
      }, projectCache, environmentForPath(project, abstract.path));
    }
    this.cache.set(project.id, projectCache);
    return this.buildAnalysis(project, projectCache, projectCache.size, started);
  }

  private enqueueAnalysis(projectId: string, analyze: () => Promise<ProjectAnalysis>): Promise<ProjectAnalysis> {
    const previous = this.pendingAnalyses.get(projectId) ?? Promise.resolve();
    const result = previous.then(analyze);
    const settled = result.then(() => undefined, () => undefined);
    this.pendingAnalyses.set(projectId, settled);
    void settled.then(() => {
      if (this.pendingAnalyses.get(projectId) === settled) this.pendingAnalyses.delete(projectId);
    });
    return result;
  }

  async writeDocumentation(project: ProjectConfig, analysis = this.current(project.id)): Promise<DocumentationWriteResult> {
    if (!analysis) throw new Error("Scan the project before generating documentation.");
    const folder = normalizePath(project.documentationFolder);
    await this.ensureFolder(folder);
    const output: DocumentationWriteResult = { written: [], skipped: [] };
    const environmentOrder = project.environments.map((rule) => rule.name);
    for (const document of this.markdown.generate(project.name, analysis.graph, analysis.findings, project.subprojects, environmentOrder)) {
      const path = normalizePath(`${folder}/${document.path}`);
      const existing = this.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        const content = await this.vault.cachedRead(existing);
        const isOwned = content.includes(GENERATED_MARKER) || document.path.endsWith(".json");
        if (!isOwned) {
          output.skipped.push(path);
          continue;
        }
        if (content !== document.content) await this.vault.modify(existing, document.content);
      } else await this.vault.create(path, document.content);
      output.written.push(path);
    }
    return output;
  }

  private async parseFile(file: DiscoveredFile, projectCache: Map<string, CachedFile>, environment: string | undefined): Promise<void> {
    const abstract = this.vault.getAbstractFileByPath(file.path);
    if (!(abstract instanceof TFile)) return;
    try {
      const content = await this.vault.cachedRead(abstract);
      const result = this.registry.parse(file.path, content, { environment });
      projectCache.set(file.path, { mtime: file.mtime, size: file.size, environment, ...result });
    } catch (error) {
      projectCache.set(file.path, {
        mtime: file.mtime,
        size: file.size,
        environment,
        artifacts: [],
        diagnostics: [{
          path: file.path,
          parser: "file-reader",
          severity: "error",
          message: error instanceof Error ? error.message : String(error)
        }]
      });
    }
  }

  private buildAnalysis(
    project: ProjectConfig,
    projectCache: Map<string, CachedFile>,
    scannedFiles: number,
    started: number
  ): ProjectAnalysis {
    const artifacts = [...projectCache.values()].flatMap((entry) => entry.artifacts);
    const diagnostics = [...projectCache.values()].flatMap((entry) => entry.diagnostics);
    const graph = this.builder.build(project, artifacts, diagnostics);
    const analysis: ProjectAnalysis = {
      graph,
      findings: this.validation.validate(graph, project),
      scannedFiles,
      parsedArtifacts: artifacts.length,
      durationMs: performance.now() - started
    };
    this.analyses.set(project.id, analysis);
    for (const listener of this.listeners) listener(project.id, analysis);
    return analysis;
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!path) return;
    const segments = path.split("/");
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.vault.getAbstractFileByPath(current)) await this.vault.createFolder(current);
    }
  }
}

function environmentForPath(project: ProjectConfig, path: string): string | undefined {
  const match = (root: string): string | undefined => {
    let environment: string | undefined;
    let longestMatch = -1;
    for (const rule of project.environments) {
      for (const prefix of rule.folderPrefixes) {
        const folder = normalizePath([root, prefix].filter(Boolean).join("/"));
        if (folder.length <= longestMatch || !isPathInside(path, folder)) continue;
        environment = rule.name;
        longestMatch = folder.length;
      }
    }
    return environment;
  };
  const parentEnvironment = match(project.rootFolder);
  if (parentEnvironment !== undefined) return parentEnvironment;
  const subproject = subprojectForPath(project, path);
  return subproject ? match([project.rootFolder, subproject.folder].filter(Boolean).join("/")) : undefined;
}

function isPathInside(path: string, folder: string): boolean {
  const normalized = folder.replace(/\/$/, "");
  return path === normalized || path.startsWith(`${normalized}/`);
}
