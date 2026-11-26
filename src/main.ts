import { Notice, Plugin, TFile, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import type { ArchitectureSnapshot, PluginSettings, ProjectConfig } from "./model/types";
import { ArchitectureEngine, type ProjectAnalysis } from "./services/architecture-engine";
import { createDefaultProject, DataArchitectureSettingTab, DEFAULT_SETTINGS } from "./settings";
import { DATA_ARCHITECTURE_VIEW, DataArchitectureDashboardView } from "./ui/dashboard-view";
import { SnapshotService } from "./history/snapshots";
import { recordInfrastructureChanges } from "./history/infrastructure-changes";

export default class DataArchitectureMapperPlugin extends Plugin {
  settings: PluginSettings = structuredClone(DEFAULT_SETTINGS);
  engine!: ArchitectureEngine;
  private readonly snapshotService = new SnapshotService();
  private pendingPaths = new Map<string, Set<string>>();
  private refreshTimers = new Map<string, number>();
  private settingsWrites = Promise.resolve();
  private infrastructureNeedsSave = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.engine = new ArchitectureEngine(this.app.vault);
    this.register(this.engine.onUpdate((projectId, analysis) => this.recordInfrastructure(projectId, analysis)));
    this.registerView(DATA_ARCHITECTURE_VIEW, (leaf) => new DataArchitectureDashboardView(leaf, this));
    this.addSettingTab(new DataArchitectureSettingTab(this.app, this));
    this.addRibbonIcon("network", "Open Data Architecture Mapper", () => void this.openDashboard());

    this.addCommand({ id: "open-dashboard", name: "Open architecture dashboard", callback: () => void this.openDashboard() });
    this.addCommand({ id: "refresh-active-project", name: "Refresh active project", callback: () => void this.refreshWithNotice(true) });
    this.addCommand({ id: "generate-documentation", name: "Generate active project documentation", callback: () => void this.generateDocumentation() });
    this.addCommand({ id: "capture-snapshot", name: "Capture active architecture snapshot", callback: () => void this.captureSnapshot() });

    this.registerEvent(this.app.vault.on("create", (file) => this.handleVaultChange(file)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.handleVaultChange(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.handleVaultChange(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.handleVaultChange({ path: oldPath } as TAbstractFile);
      this.handleVaultChange(file);
    }));
  }

  onunload(): void {
    for (const timer of this.refreshTimers.values()) window.clearTimeout(timer);
  }

  activeProject(): ProjectConfig | undefined {
    return this.settings.projects.find((project) => project.id === this.settings.activeProjectId) ?? this.settings.projects[0];
  }

  async selectProject(projectId: string): Promise<void> {
    this.settings.activeProjectId = projectId;
    await this.saveSettings();
    const project = this.activeProject();
    if (project && !this.engine.current(project.id)) await this.engine.scan(project);
    this.rerenderDashboard();
  }

  async refreshActiveProject(force = false): Promise<ProjectAnalysis | undefined> {
    const project = this.activeProject();
    if (!project) {
      new Notice("Add a Data Architecture Mapper project in settings first.");
      return undefined;
    }
    return this.engine.scan(project, force);
  }

  async captureSnapshot(): Promise<void> {
    const project = this.activeProject();
    const analysis = project ? this.engine.current(project.id) : undefined;
    if (!project || !analysis) {
      new Notice("Scan the active project before capturing a snapshot.");
      return;
    }
    const timestamp = new Date();
    const snapshot = this.snapshotService.capture(
      `${project.name} ${timestamp.toLocaleString()}`,
      analysis.graph,
      analysis.findings,
      timestamp.toISOString()
    );
    this.settings.snapshots.push(snapshot);
    this.settings.snapshots = limitSnapshots(this.settings.snapshots, 50);
    await this.saveSettings();
    this.rerenderDashboard();
    new Notice("Architecture snapshot captured locally.");
  }

  async openSource(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
    else new Notice(`Source file no longer exists: ${path}`);
  }

  async saveSettings(): Promise<void> {
    const data = structuredClone(this.settings);
    const next = this.settingsWrites.then(() => this.saveData(data));
    this.settingsWrites = next.catch(() => undefined);
    await next;
  }

  private recordInfrastructure(projectId: string, analysis: ProjectAnalysis): void {
    const previous = this.settings.infrastructureHistory?.[projectId];
    const current = recordInfrastructureChanges(previous, analysis.graph);
    if (current && current !== previous) {
      this.settings.infrastructureHistory ??= {};
      this.settings.infrastructureHistory[projectId] = current;
      this.infrastructureNeedsSave = true;
    }
    if (!this.infrastructureNeedsSave) return;
    this.infrastructureNeedsSave = false;
    void this.saveSettings().catch(() => {
      this.infrastructureNeedsSave = true;
      new Notice("Could not save infrastructure history. The next scan will try again.");
    });
  }

  async refreshProjectSubprojects(project: ProjectConfig): Promise<void> {
    if (this.engine.current(project.id)) await this.engine.scan(project);
  }

  private async loadSettings(): Promise<void> {
    const loaded = await this.loadData() as Partial<PluginSettings> | null;
    this.settings = {
      projects: loaded?.projects ?? [],
      snapshots: loaded?.snapshots ?? [],
      infrastructureHistory: loaded?.infrastructureHistory,
      activeProjectId: loaded?.activeProjectId
    };
    if (this.settings.projects.length === 0) {
      const project = createDefaultProject(1);
      this.settings.projects = [project];
      this.settings.activeProjectId = project.id;
      await this.saveSettings();
    }
  }

  private async openDashboard(): Promise<void> {
    const project = this.activeProject();
    if (project && !this.engine.current(project.id)) {
      try {
        await this.engine.scan(project);
      } catch (error) {
        new Notice(`Initial scan failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const existing = this.app.workspace.getLeavesOfType(DATA_ARCHITECTURE_VIEW)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing) await leaf.setViewState({ type: DATA_ARCHITECTURE_VIEW, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private async refreshWithNotice(force: boolean): Promise<void> {
    try {
      const analysis = await this.refreshActiveProject(force);
      if (analysis) new Notice(`Architecture refreshed: ${analysis.graph.components.length} components, ${analysis.findings.length} findings.`);
    } catch (error) {
      new Notice(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async generateDocumentation(): Promise<void> {
    const project = this.activeProject();
    if (!project) return;
    try {
      const analysis = await this.refreshActiveProject();
      if (!analysis) return;
      const result = await this.engine.writeDocumentation(project, analysis);
      new Notice(`Generated ${result.written.length} documentation files${result.skipped.length ? `; skipped ${result.skipped.length} user-owned files` : ""}.`);
    } catch (error) {
      new Notice(`Documentation generation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private handleVaultChange(file: TAbstractFile): void {
    for (const project of this.settings.projects) {
      if (!project.automaticRefresh || !this.engine.current(project.id) || !pathIsInRoot(file.path, project.rootFolder)) continue;
      const paths = this.pendingPaths.get(project.id) ?? new Set<string>();
      paths.add(file.path);
      this.pendingPaths.set(project.id, paths);
      const existing = this.refreshTimers.get(project.id);
      if (existing !== undefined) window.clearTimeout(existing);
      const timer = window.setTimeout(() => void this.flushProjectChanges(project), project.refreshDebounceMs);
      this.refreshTimers.set(project.id, timer);
    }
  }

  private async flushProjectChanges(project: ProjectConfig): Promise<void> {
    this.refreshTimers.delete(project.id);
    const paths = [...(this.pendingPaths.get(project.id) ?? [])].sort();
    this.pendingPaths.delete(project.id);
    try {
      if (paths.length) await this.engine.refreshPaths(project, paths);
    } catch (error) {
      console.error("Data Architecture Mapper incremental refresh failed", error);
    }
  }

  private rerenderDashboard(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(DATA_ARCHITECTURE_VIEW)) {
      const view = leaf.view;
      if (view instanceof DataArchitectureDashboardView) view.refreshView();
    }
  }
}

function pathIsInRoot(path: string, root: string): boolean {
  const normalized = root.replace(/^\/+|\/+$/g, "");
  return !normalized || path === normalized || path.startsWith(`${normalized}/`);
}

function limitSnapshots(snapshots: ArchitectureSnapshot[], perProject: number): ArchitectureSnapshot[] {
  const counts = new Map<string, number>();
  return [...snapshots].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)).filter((snapshot) => {
    const count = counts.get(snapshot.projectId) ?? 0;
    counts.set(snapshot.projectId, count + 1);
    return count < perProject;
  }).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}
