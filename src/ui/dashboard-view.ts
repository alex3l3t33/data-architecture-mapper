import { FuzzySuggestModal, ItemView, Notice, TFolder, WorkspaceLeaf, setIcon, type App } from "obsidian";
import cytoscape, { type Core, type NodeSingular } from "cytoscape";
import type { ArchitectureComponent, ArchitectureGraph, ComponentType, PluginSettings, ProjectConfig, SubprojectConfig, ValidationFinding } from "../model/types";
import type { ArchitectureEngine, ProjectAnalysis } from "../services/architecture-engine";
import { EnvironmentComparator } from "../environment/compare";
import { LineageAnalyzer } from "../graph/lineage";
import { MermaidGenerator } from "../output/mermaid";
import { ConnectExportModal } from "./connect-export-modal";
import { MermaidModal } from "./mermaid-modal";
import { normalizeKofiUrl } from "../utils/kofi";
import { fundingUrl } from "../../manifest.json";
import { subprojectForPath } from "../discovery/subprojects";
import { isInside } from "../discovery/glob";
import { graphForSubproject } from "../graph/subproject-scope";
import { INFRASTRUCTURE_TYPES, infrastructureCharacteristics, infrastructureParentPaths, infrastructureTypeLabel } from "../graph/infrastructure";
import { DATABASE_TYPES, databaseWorkloads, type RelatedDatabaseWorkload } from "../graph/database-workloads";

export const DATA_ARCHITECTURE_VIEW = "data-architecture-mapper-view";

type Tab = "Overview" | "Architecture" | "Connectors" | "Topics" | "Applications" | "Databases" | "Infrastructure" | "Data Lineage" | "Impact Analysis" | "Validation" | "Environment Comparison" | "Infrastructure Changes" | "Change History";

const NAVIGATION: Array<{ heading: string; items: Array<[Tab, string]> }> = [
  { heading: "Workspace", items: [["Overview", "layout-dashboard"], ["Architecture", "network"], ["Data Lineage", "git-branch"], ["Impact Analysis", "radar"]] },
  { heading: "Inventory", items: [["Connectors", "plug-zap"], ["Topics", "radio-tower"], ["Applications", "boxes"], ["Databases", "database"], ["Infrastructure", "server"]] },
  { heading: "Review", items: [["Validation", "shield-alert"], ["Environment Comparison", "layers"], ["Infrastructure Changes", "activity"], ["Change History", "history"]] }
];

export interface DashboardHost {
  settings: PluginSettings;
  engine: ArchitectureEngine;
  activeProject(): ProjectConfig | undefined;
  selectProject(projectId: string): Promise<void>;
  refreshActiveProject(force?: boolean): Promise<ProjectAnalysis | undefined>;
  captureSnapshot(): Promise<void>;
  openSource(path: string): Promise<void>;
  saveSettings(): Promise<void>;
}

export class DataArchitectureDashboardView extends ItemView {
  private activeTab: Tab = "Overview";
  private selectedComponentId?: string;
  private search = "";
  private environment = "all";
  private subprojectId?: string;
  private connectorFolder?: string;
  private type = "all";
  private severity = "all";
  private cytoscape?: Core;
  private graphSize?: ResizeObserver;
  private updateInspector?: () => void;
  private graphLayout = "cose";
  private infrastructureVisible = false;
  private currentProjectId?: string;
  private unsubscribe?: () => void;

  constructor(leaf: WorkspaceLeaf, private readonly host: DashboardHost) {
    super(leaf);
  }

  getViewType(): string {
    return DATA_ARCHITECTURE_VIEW;
  }

  getDisplayText(): string {
    return "Data Architecture Mapper";
  }

  getIcon(): string {
    return "network";
  }

  async onOpen(): Promise<void> {
    this.unsubscribe = this.host.engine.onUpdate((projectId) => {
      if (projectId === this.host.activeProject()?.id) this.render();
    });
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.clearGraph();
  }

  refreshView(): void {
    this.render();
  }

  private render(): void {
    this.clearGraph();
    this.updateInspector = undefined;
    const root = this.contentEl;
    root.empty();
    root.addClass("dam-dashboard");
    const project = this.host.activeProject();
    if (!project) {
      root.createEl("h2", { text: "Data Architecture Mapper" });
      root.createEl("p", { text: "Add a project in plugin settings to start discovering architecture." });
      return;
    }
    if (this.currentProjectId !== project.id) {
      this.currentProjectId = project.id;
      this.environment = this.type = this.severity = "all";
      this.subprojectId = undefined;
      this.connectorFolder = undefined;
      this.search = "";
      this.selectedComponentId = undefined;
    }
    const analysis = this.host.engine.current(project.id);
    this.renderHeader(root, project, analysis);
    if (!analysis) {
      const empty = root.createDiv({ cls: "dam-empty" });
      setIcon(empty.createSpan(), "scan-search");
      empty.createEl("h3", { text: "Ready to scan" });
      empty.createEl("p", { text: `Scan ${project.rootFolder || "the vault"} to build the architecture inventory.` });
      const button = empty.createEl("button", { text: "Scan project", cls: "mod-cta" });
      button.onclick = () => void this.scan();
      action(empty, "Scan folder…", "folder-open").onclick = () => this.chooseFolder(project);
      return;
    }
    const subproject = project.subprojects?.find((entry) => entry.id === this.subprojectId);
    this.subprojectId = subproject?.id;
    const view = subproject && this.activeTab !== "Change History" ? this.scopedAnalysis(project, analysis, subproject) : analysis;
    const workspace = root.createDiv({ cls: "dam-workspace" });
    this.renderNavigation(workspace);
    const page = workspace.createDiv({ cls: "dam-page" });
    const heading = page.createDiv({ cls: "dam-page-heading" });
    heading.createEl("h2", { text: this.activeTab === "Overview" ? "Project overview" : this.activeTab });
    if (project.subprojects?.length && this.activeTab !== "Change History") this.renderSubprojectPicker(heading, project.subprojects);
    if (this.activeTab === "Overview" && !subproject) {
      heading.createEl("span", { text: `${analysis.scannedFiles} files scanned · ${analysis.durationMs.toFixed(0)} ms`, cls: "dam-scan-status" });
    }
    const filters = page.createDiv({ cls: "dam-filters" });
    const body = page.createDiv({ cls: "dam-body" });
    const main = body.createDiv({ cls: "dam-main" });
    const detail = body.createEl("aside", { cls: "dam-detail", attr: { "aria-label": "Component inspector" } });
    this.updateInspector = () => {
      detail.empty();
      detail.hidden = this.activeTab === "Overview" || !view.graph.components.some((component) => component.id === this.selectedComponentId);
      body.toggleClass("has-inspector", !detail.hidden);
      if (!detail.hidden) this.renderDetails(detail, view);
    };
    const update = (): void => {
      this.clearGraph();
      main.empty();
      this.updateInspector?.();
      this.renderActiveTab(main, view, project);
    };
    if (!["Overview", "Environment Comparison", "Change History"].includes(this.activeTab)) this.renderFilters(filters, view, project, update);
    update();
  }

  private renderSubprojectPicker(container: HTMLElement, subprojects: readonly SubprojectConfig[]): void {
    const field = container.createEl("label", { cls: "dam-scope-field" });
    field.createSpan({ text: "Subproject" });
    const select = field.createEl("select", { cls: "dam-scope-select" });
    select.createEl("option", { text: "All subprojects", value: "" });
    for (const subproject of subprojects) {
      select.createEl("option", { text: subproject.name, value: subproject.id });
    }
    select.value = this.subprojectId ?? "";
    select.onchange = () => {
      this.changeScope(select.value || undefined);
      this.render();
      this.contentEl.querySelector<HTMLSelectElement>(".dam-scope-select")?.focus({ preventScroll: true });
    };
  }

  private scopedAnalysis(project: ProjectConfig, analysis: ProjectAnalysis, subproject: SubprojectConfig): ProjectAnalysis {
    const graph = graphForSubproject(analysis.graph, subproject.id);
    const ids = new Set(graph.components.map((component) => component.id));
    const ownsPath = (path: string): boolean => subprojectForPath(project, path)?.id === subproject.id;
    return {
      ...analysis,
      graph: { ...graph, diagnostics: graph.diagnostics.filter((entry) => ownsPath(entry.path)) },
      findings: analysis.findings.flatMap((finding) => {
        const affectedComponentIds = finding.affectedComponentIds.filter((id) => ids.has(id));
        return affectedComponentIds.length || (!finding.affectedComponentIds.length && finding.evidence.some((entry) => ownsPath(entry.path)))
          ? [{ ...finding, affectedComponentIds }]
          : [];
      })
    };
  }

  private changeScope(subprojectId: string | undefined): void {
    this.subprojectId = subprojectId;
    this.connectorFolder = undefined;
    this.environment = this.type = "all";
    this.search = "";
    this.selectedComponentId = undefined;
  }

  private renderHeader(root: HTMLElement, project: ProjectConfig, analysis?: ProjectAnalysis): void {
    const header = root.createDiv({ cls: "dam-header" });
    const title = header.createDiv({ cls: "dam-brand" });
    setIcon(title.createSpan({ cls: "dam-brand-icon" }), "network");
    const identity = title.createDiv({ cls: "dam-identity" });
    identity.createEl("h2", { text: "Data Architecture Mapper" });
    const projectSelect = identity.createEl("select", { cls: "dam-project-switch", attr: { "aria-label": "Project" } });
    const actions = header.createDiv({ cls: "dam-actions" });
    for (const candidate of this.host.settings.projects) {
      const option = projectSelect.createEl("option", { text: candidate.name, value: candidate.id });
      option.selected = candidate.id === project.id;
    }
    projectSelect.onchange = () => void this.host.selectProject(projectSelect.value);
    const refresh = action(actions, analysis ? "Refresh" : "Scan", "refresh-cw");
    refresh.onclick = async () => {
      refresh.disabled = true;
      try { await this.scan(); } finally { refresh.disabled = false; }
    };
    const exportConfigs = action(actions, "Export configs", "download", "dam-primary");
    exportConfigs.onclick = () => new ConnectExportModal(
      this.app, project, () => this.host.saveSettings(), () => this.host.refreshActiveProject()
    ).open();
    const docs = action(actions, "Generate docs", "file-text");
    docs.disabled = !analysis;
    docs.onclick = () => void this.generateDocs();
    const snapshot = action(actions, "Snapshot", "camera");
    snapshot.disabled = !analysis;
    snapshot.onclick = () => void this.host.captureSnapshot();
    const supportUrl = normalizeKofiUrl(fundingUrl);
    if (supportUrl) {
      const support = actions.createEl("a", {
        cls: "dam-kofi-link",
        attr: { href: supportUrl, target: "_blank", rel: "noopener noreferrer", "aria-label": "Support on Ko-fi (opens in a new tab)" }
      });
      setIcon(support.createSpan({ cls: "dam-kofi-icon", attr: { "aria-hidden": "true" } }), "coffee");
      support.createSpan({ text: "Support on Ko-fi" });
    }
  }

  private renderNavigation(container: HTMLElement): void {
    const nav = container.createEl("nav", { cls: "dam-nav", attr: { "aria-label": "Architecture views" } });
    const menu = nav.createEl("select", { cls: "dam-view-picker", attr: { "aria-label": "Architecture view" } });
    for (const group of NAVIGATION) {
      const section = nav.createDiv({ cls: "dam-nav-group" });
      section.createDiv({ cls: "dam-nav-heading", text: group.heading });
      for (const [tab, icon] of group.items) {
        menu.createEl("option", { text: tab, value: tab });
        const button = action(section, tab, icon, tab === this.activeTab ? "is-active" : "");
        if (tab === this.activeTab) button.setAttr("aria-current", "page");
        button.onclick = () => this.openTab(tab, true);
      }
    }
    menu.value = this.activeTab;
    menu.onchange = () => {
      this.openTab(menu.value as Tab);
      this.contentEl.querySelector<HTMLSelectElement>(".dam-view-picker")?.focus({ preventScroll: true });
    };
    const current = nav.querySelector<HTMLButtonElement>(".is-active");
    if (current && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = current.offsetLeft - nav.offsetLeft - 8;
  }

  private openTab(tab: Tab, focus = false): void {
    this.activeTab = tab;
    this.type = "all";
    this.search = "";
    this.render();
    if (focus) this.contentEl.querySelector<HTMLButtonElement>(".dam-nav .is-active")?.focus({ preventScroll: true });
  }

  private renderFilters(filters: HTMLElement, analysis: ProjectAnalysis, project: ProjectConfig, update: () => void): void {
    const field = filters.createEl("label", { cls: "dam-search" });
    setIcon(field.createSpan(), "search");
    const search = field.createEl("input", {
      type: "search", placeholder: this.activeTab === "Validation" ? "Search findings…" : this.activeTab === "Infrastructure" ? "Search hosts, clusters, and characteristics…" : "Search components…",
      value: this.search, attr: { "aria-label": "Search" }
    });
    search.oninput = () => {
      this.search = search.value;
      update();
    };
    if (this.activeTab !== "Validation") {
      const historyEnvironments = this.activeTab === "Infrastructure Changes"
        ? this.host.settings.infrastructureHistory?.[project.id]?.changes.map((change) => change.environment) ?? []
        : [];
      const environments = [...new Set(["all", ...environmentNames(project, analysis.graph), ...historyEnvironments])];
      if (!environments.includes(this.environment)) this.environment = "all";
      createFilter(filters, "Environment", this.environment, environments, (value) => {
        this.environment = value;
        this.selectedComponentId = undefined;
        update();
      });
    }
    if (["Architecture", "Data Lineage", "Impact Analysis"].includes(this.activeTab)) {
      createFilter(filters, "Component type", this.type,
        ["all", ...new Set(analysis.graph.components.map((component) => component.type))], (value) => {
          this.type = value;
          update();
        });
    }
    if (this.activeTab === "Validation") {
      createFilter(filters, "Severity", this.severity, ["all", "error", "warning", "info"], (value) => {
        this.severity = value;
        update();
      });
    }
  }

  private renderActiveTab(container: HTMLElement, analysis: ProjectAnalysis, project: ProjectConfig): void {
    switch (this.activeTab) {
      case "Overview": this.renderOverview(container, analysis, project); break;
      case "Architecture": this.renderArchitecture(container, analysis.graph); break;
      case "Connectors": this.renderInventory(container, analysis.graph, ["kafka-connector"]); break;
      case "Topics": this.renderInventory(container, analysis.graph, ["kafka-topic"]); break;
      case "Applications": this.renderInventory(container, analysis.graph, ["application"]); break;
      case "Databases": this.renderInventory(container, analysis.graph, [...DATABASE_TYPES]); break;
      case "Infrastructure": this.renderInfrastructure(container, analysis.graph); break;
      case "Data Lineage": this.renderLineage(container, analysis.graph, false); break;
      case "Impact Analysis": this.renderLineage(container, analysis.graph, true); break;
      case "Validation": this.renderValidation(container, analysis.findings); break;
      case "Environment Comparison": this.renderEnvironmentComparison(container, analysis.graph, project); break;
      case "Infrastructure Changes": this.renderInfrastructureChanges(container, project, analysis.graph); break;
      case "Change History": this.renderHistory(container, project); break;
    }
  }

  private renderOverview(container: HTMLElement, analysis: ProjectAnalysis, project: ProjectConfig): void {
    const graph = analysis.graph;
    const metrics = container.createDiv({ cls: "dam-metrics" });
    metric(metrics, "Components", graph.components.length, "boxes", "violet", () => this.openTab("Architecture"));
    metric(metrics, "Connectors", countType(graph, "kafka-connector"), "plug-zap", "blue", () => this.openTab("Connectors"));
    metric(metrics, "Kafka topics", countType(graph, "kafka-topic"), "radio-tower", "teal", () => this.openTab("Topics"));
    metric(metrics, "Findings", analysis.findings.length, "shield-alert", "amber", () => this.openTab("Validation"));
    const panels = container.createDiv({ cls: "dam-overview-grid" });
    const environments = panels.createDiv({ cls: "dam-panel" });
    const envHeader = environments.createDiv({ cls: "dam-panel-header" });
    envHeader.createEl("h3", { text: "Environment inventory" });
    action(envHeader, "View graph", "arrow-up-right", "dam-text-action").onclick = () => {
      this.environment = "all";
      this.openTab("Architecture");
    };
    const grouped = new Map(environmentNames(project, graph).map((name) => [name, { nodes: 0, connectors: 0, topics: 0 }]));
    for (const item of graph.components) {
      const counts = grouped.get(item.environment) ?? { nodes: 0, connectors: 0, topics: 0 };
      counts.nodes += 1;
      if (item.type === "kafka-connector") counts.connectors += 1;
      if (item.type === "kafka-topic") counts.topics += 1;
      grouped.set(item.environment, counts);
    }
    for (const [environment, counts] of grouped) {
      const row = environments.createEl("button", { cls: "dam-env-row" });
      setIcon(row.createSpan({ cls: `dam-env-icon ${environmentTone(environment)}` }), "layers");
      const text = row.createDiv();
      text.createEl("strong", { text: environment });
      text.createEl("span", { text: counts.nodes ? `${counts.connectors} connectors · ${counts.topics} topics` : "No components discovered" });
      row.createSpan({ text: `${counts.nodes} components`, cls: "dam-env-count" });
      setIcon(row.createSpan(), "chevron-right");
      row.onclick = () => {
        this.environment = environment;
        this.selectedComponentId = undefined;
        this.openTab("Architecture");
      };
    }
    if (grouped.size === 0) environments.createEl("p", { text: "No components were discovered." });
    const footer = environments.createDiv({ cls: "dam-panel-footer" });
    footer.createSpan({ text: this.subprojectId ? `${graph.relationships.length} relationships` : `${graph.relationships.length} relationships · ${analysis.parsedArtifacts} parsed artifacts` });

    const health = panels.createDiv({ cls: "dam-panel dam-health" });
    health.createEl("h3", { text: "Scan health" });
    const unresolved = graph.components.filter((component) => component.unresolved).length;
    const known = graph.components.length - unresolved;
    const progress = health.createDiv({ cls: "dam-health-stat" });
    progress.createSpan({ text: "Resolved components" });
    progress.createEl("strong", { text: `${known} / ${graph.components.length}` });
    const meter = health.createEl("progress", { cls: "dam-progress", attr: { "aria-label": "Resolved components" } });
    meter.max = Math.max(1, graph.components.length);
    meter.value = known;
    for (const severity of ["error", "warning", "info"] as const) {
      const row = health.createDiv({ cls: `dam-severity dam-${severity}` });
      row.createSpan({ text: severity === "info" ? "Informational" : severity === "error" ? "Errors" : "Warnings" });
      row.createEl("strong", { text: String(analysis.findings.filter((finding) => finding.severity === severity).length) });
    }
    if (!this.subprojectId && project.subprojects?.length) {
      const subprojects = container.createDiv({ cls: "dam-panel dam-subprojects-panel" });
      subprojects.createEl("h3", { text: "Subprojects" });
      const applicationCounts = new Map<string, number>();
      for (const component of graph.components) {
        if (component.type !== "application") continue;
        for (const id of component.subprojectIds ?? []) applicationCounts.set(id, (applicationCounts.get(id) ?? 0) + 1);
      }
      for (const subproject of project.subprojects) {
        const row = subprojects.createEl("button", { cls: "dam-env-row" });
        setIcon(row.createSpan({ cls: "dam-env-icon" }), "folder");
        const text = row.createDiv();
        text.createEl("strong", { text: subproject.name });
        const count = applicationCounts.get(subproject.id) ?? 0;
        text.createSpan({ text: `${count} ${count === 1 ? "application" : "applications"}` });
        row.createSpan({ cls: "dam-env-count", text: subproject.folder });
        setIcon(row.createSpan(), "chevron-right");
        row.onclick = () => {
          this.changeScope(subproject.id);
          this.openTab("Applications");
        };
      }
    }
  }

  private renderArchitecture(container: HTMLElement, graph: ArchitectureGraph): void {
    const panel = container.createDiv({ cls: "dam-graph-panel" });
    const toolbar = panel.createDiv({ cls: "dam-graph-toolbar" });
    const layout = toolbar.createEl("select", { attr: { "aria-label": "Graph layout" } });
    layout.createEl("option", { text: "Automatic layout", value: "cose" });
    layout.createEl("option", { text: "Vertical data flow", value: "breadthfirst-tb" });
    layout.createEl("option", { text: "Horizontal data flow", value: "breadthfirst-lr" });
    layout.value = this.graphLayout;
    const infrastructure = toolbar.createEl("label", { cls: "dam-graph-toggle" });
    const infrastructureInput = infrastructure.createEl("input", { type: "checkbox" });
    infrastructureInput.checked = this.infrastructureVisible;
    infrastructure.createSpan({ text: "Infrastructure" });
    infrastructureInput.onchange = () => {
      this.infrastructureVisible = infrastructureInput.checked;
      this.clearGraph();
      container.empty();
      this.renderArchitecture(container, graph);
    };
    const tools = toolbar.createDiv({ cls: "dam-graph-actions" });
    const exportMermaid = action(tools, "Copy Mermaid", "copy");
    const exportSvg = action(tools, "Export SVG", "download");
    const fullscreen = action(tools, "Full screen", "maximize");
    const stage = panel.createDiv({ cls: "dam-graph-stage" });
    const graphContainer = stage.createDiv({ cls: "dam-graph", attr: { "aria-label": "Architecture graph", tabindex: "0" } });
    const filtered = this.filteredGraph(graph);
    const legend = panel.createDiv({ cls: "dam-graph-legend" });
    for (const [label, tone] of [["Connector", "violet"], ["Topic", "amber"], ["Application", "blue"], ["Data store", "teal"]]) {
      legend.createSpan({ cls: `dam-legend-item dam-tone-${tone}`, text: label });
    }
    legend.createSpan({ cls: "dam-graph-count", text: `${filtered.components.length} components · ${filtered.relationships.length} links` });
    if (!filtered.components.length) {
      graphContainer.createEl("p", { cls: "dam-graph-empty", text: "No components match these filters." });
      [exportMermaid, exportSvg, fullscreen, layout].forEach((control) => { control.disabled = true; });
      return;
    }
    const zoom = stage.createDiv({ cls: "dam-graph-zoom" });
    const fit = action(zoom, "Fit graph", "scan", "dam-icon-only");
    const zoomIn = action(zoom, "Zoom in", "plus", "dam-icon-only");
    const zoomOut = action(zoom, "Zoom out", "minus", "dam-icon-only");
    const setFullscreen = (enabled: boolean): void => {
      panel.toggleClass("is-fullscreen", enabled);
      fullscreen.setAttr("aria-pressed", String(enabled));
      this.cytoscape?.resize();
      this.cytoscape?.fit(undefined, 32);
    };
    fullscreen.onclick = () => setFullscreen(!panel.hasClass("is-fullscreen"));
    panel.onkeydown = (event) => { if (event.key === "Escape") setFullscreen(false); };
    exportMermaid.onclick = async () => {
      try {
        await navigator.clipboard.writeText(new MermaidGenerator().generate(filtered, { includeAssociations: this.infrastructureVisible }));
        new Notice("Mermaid copied.");
      } catch {
        new Notice("Clipboard unavailable.");
      }
    };
    const groupElements = cytoscapeGroups(filtered);
    this.cytoscape = cytoscape({
      container: graphContainer,
      elements: [
        ...groupElements,
        ...filtered.components.map((component) => ({ data: {
          id: component.id,
          label: component.label,
          type: component.type,
          unresolved: component.unresolved,
          parent: componentParent(component)
        } })),
        ...filtered.relationships.map((edge) => ({ data: {
          id: edge.id, source: edge.from, target: edge.to, label: edge.type, unresolved: edge.unresolved
        } }))
      ],
      style: [
        { selector: "node", style: { "label": "data(label)", "font-size": "15px", "font-weight": 600, "text-wrap": "wrap", "text-max-width": "165px", "text-margin-y": -5, "background-color": "#8296b5", "color": "#e7efff", "text-outline-color": "#10192b", "text-outline-width": 3, "width": 42, "height": 42, "border-width": 1.5, "border-color": "#c7d5ed" } },
        { selector: "node[type = 'kafka-topic']", style: { "shape": "ellipse", "background-color": "#e9b95f", "border-color": "#ffe1a3" } },
        { selector: "node[type = 'kafka-connector']", style: { "shape": "hexagon", "background-color": "#a38bfa", "border-color": "#d6c6ff", "width": 62 } },
        { selector: "node[type = 'application']", style: { "shape": "round-rectangle", "background-color": "#71a7fa", "border-color": "#b6d4ff", "width": 57 } },
        { selector: "node[type *= 'database'], node[type = 'mongodb-collection']", style: { "shape": "barrel", "background-color": "#5ed2bf", "border-color": "#b3eee2" } },
        { selector: "node:parent", style: { "background-color": "#7083b2", "background-opacity": 0.075, "border-color": "#5b709a", "border-width": 1, "color": "#b4c6e5", "font-size": "15px", "text-valign": "top", "text-halign": "center", "padding": "20px", "shape": "round-rectangle" } },
        { selector: "node[?unresolved]", style: { "border-width": 3, "border-style": "dashed", "border-color": "#fa8caa" } },
        { selector: "edge", style: { "curve-style": "bezier", "target-arrow-shape": "triangle", "line-color": "#7086aa", "target-arrow-color": "#93afd9", "width": 2, "label": "data(label)", "font-size": "10px", "text-rotation": "autorotate", "color": "#c7d6ed", "text-background-color": "#10192b", "text-background-opacity": 0.92, "text-background-padding": "2px", "min-zoomed-font-size": 5 } },
        { selector: "edge[?unresolved]", style: { "line-style": "dashed" } },
        { selector: ".is-selected", style: { "border-width": 5, "border-color": "#ffffff" } },
        { selector: ".faded", style: { "opacity": 0.19 } }
      ],
      layout: { name: "preset" },
      boxSelectionEnabled: false,
      selectionType: "single",
      maxZoom: 3
    });
    const canvas = this.cytoscape;
    const applyLayout = (): void => {
      const horizontal = this.graphLayout === "breadthfirst-lr";
      const name = this.graphLayout === "cose" ? "cose" : "breadthfirst";
      canvas.layout({
        name, directed: true, fit: true, padding: 34, animate: false,
        componentSpacing: 56, nodeRepulsion: () => 5500, idealEdgeLength: () => 88,
        transform: horizontal ? (_node: unknown, position: { x: number; y: number }) => ({ x: position.y, y: position.x }) : undefined
      } as never).run();
    };
    applyLayout();
    this.graphSize = new ResizeObserver(() => canvas.resize());
    this.graphSize.observe(graphContainer);
    const scale = (factor: number): void => {
      canvas.zoom({ level: canvas.zoom() * factor, renderedPosition: { x: canvas.width() / 2, y: canvas.height() / 2 } });
    };
    fit.onclick = () => canvas.fit(undefined, 32);
    zoomIn.onclick = () => scale(1.22);
    zoomOut.onclick = () => scale(1 / 1.22);
    exportSvg.onclick = () => {
      if (this.cytoscape) downloadSvg(this.cytoscape, "data-architecture.svg");
    };
    layout.onchange = () => {
      this.graphLayout = layout.value;
      applyLayout();
    };
    this.cytoscape.on("tap", "node", (event) => {
      const id = event.target.id();
      if (id.startsWith("__group__")) {
        const children = event.target.children();
        const hidden = children.every((child: unknown) => (child as NodeSingular).style("display") === "none");
        children.style("display", hidden ? "element" : "none");
        this.cytoscape?.fit(undefined, 30);
        return;
      }
      this.selectComponent(id);
    });
    canvas.on("tap", (event) => { if (event.target === canvas) this.selectComponent(undefined); });
    this.highlightSelection();
  }

  private renderInventory(container: HTMLElement, graph: ArchitectureGraph, types: string[]): void {
    const connectorView = types.includes("kafka-connector");
    const connectorFolder = this.connectorFolder;
    const inConnectorFolder = (component: ArchitectureComponent): boolean =>
      !connectorFolder || component.evidence.some((entry) => isInside(entry.path, connectorFolder));
    const components = this.filteredComponents(graph).filter((component) =>
      types.includes(component.type) && (!connectorView || inConnectorFolder(component))
    );
    const summary = container.createDiv({ cls: "dam-inventory-summary" });
    const count = summary.createDiv({ cls: "dam-inventory-count" });
    count.createEl("strong", { text: `${components.length} ${components.length === 1 ? "result" : "results"}` });
    const project = this.host.activeProject();
    if (connectorView && project) {
      const subproject = project.subprojects?.find((entry) => entry.id === this.subprojectId);
      const scope = this.connectorFolder ?? (subproject ? scopedFolder(project, subproject) : project.rootFolder || "Entire vault");
      count.createSpan({ text: scope, cls: "dam-folder-path" });
      const tools = summary.createDiv({ cls: "dam-actions" });
      action(tools, "Scan folder…", "folder-open").onclick = () => this.chooseFolder(project);
      const connectorIds = graph.components
        .filter((component) => component.type === "kafka-connector" && inConnectorFolder(component))
        .map((component) => component.id);
      const mermaid = action(tools, "Folder Mermaid", "workflow", "dam-primary");
      mermaid.disabled = connectorIds.length === 0;
      mermaid.onclick = () => this.openConnectorMermaid(
        graph, connectorIds, scope, this.environment === "all" ? undefined : this.environment
      );
    }
    const showSubproject = types.includes("application") && Boolean(project?.subprojects?.length);
    const workloads = this.activeTab === "Databases" ? databaseWorkloads(graph) : undefined;
    const byId = new Map(project?.subprojects?.map((entry) => [entry.id, entry.name]));
    renderTable(container, ["Name", "Type", "Environment", ...(showSubproject ? ["Subproject"] : []), "Technology",
      ...(workloads ? ["Related workloads"] : []), "Sources"], components.map((component) => ({
      id: component.id,
      cells: [
        component.name, INFRASTRUCTURE_TYPES.has(component.type) ? infrastructureTypeLabel(component.type) : readable(component.type), component.environment,
        ...(showSubproject ? [(component.subprojectIds ?? []).map((id) => byId.get(id) ?? id).join(", ") || "Project root"] : []),
        component.technology ?? "—",
        ...(workloads ? [workloads.get(component.id)?.map((workload) => workload.name).join(", ") || "—"] : []),
        String(component.evidence.length)
      ]
    })), (id) => this.selectComponent(id));
  }

  private renderInfrastructure(container: HTMLElement, graph: ArchitectureGraph): void {
    const parents = infrastructureParentPaths(graph);
    const query = this.search.trim().toLowerCase();
    const rows = graph.components.filter((component) =>
      INFRASTRUCTURE_TYPES.has(component.type) && (this.environment === "all" || component.environment === this.environment)
    ).map((component) => {
      const parent = parents.get(component.id) ?? "";
      const properties = infrastructureCharacteristics(component);
      const characteristics = properties.map(([key, value]) => `${key}: ${formatValue(value)}`);
      return { component, parent, characteristics };
    }).filter(({ component, parent, characteristics }) =>
      !query || [component.name, component.technology, infrastructureTypeLabel(component.type), parent, ...characteristics]
        .join(" ").toLowerCase().includes(query)
    );
    const inventory = container.createDiv({ cls: "dam-inventory-summary" });
    inventory.createEl("strong", { text: `${rows.length} infrastructure ${rows.length === 1 ? "component" : "components"}` });
    renderTable(container, ["Name", "Type", "Environment", "Platform", "Cluster / host", "Characteristics"], rows.map((row) => ({
      id: row.component.id,
      cells: [
        row.component.name, infrastructureTypeLabel(row.component.type), row.component.environment,
        row.component.technology ?? "—", row.parent || "—",
        row.characteristics.length ? `${row.characteristics.length} ${row.characteristics.length === 1 ? "field" : "fields"}` : "—"
      ]
    })), (id) => this.selectComponent(id));
  }

  private renderLineage(container: HTMLElement, graph: ArchitectureGraph, impact: boolean): void {
    const components = this.filteredComponents(graph);
    const selected = components.find((component) => component.id === this.selectedComponentId) ?? components[0];
    if (!selected) {
      container.createEl("p", { text: "No component is available for lineage analysis." });
      return;
    }
    const selector = container.createEl("select", { cls: "dam-component-select" });
    for (const component of components) {
      const option = selector.createEl("option", { text: `${component.name} · ${component.type}`, value: component.id });
      option.selected = component.id === selected.id;
    }
    selector.onchange = () => { this.selectedComponentId = selector.value; this.render(); };
    const analyzer = new LineageAnalyzer(graph);
    const upstream = analyzer.upstream(selected.id, impact ? Number.POSITIVE_INFINITY : 5);
    const downstream = analyzer.downstream(selected.id, impact ? Number.POSITIVE_INFINITY : 5);
    const byId = new Map(graph.components.map((component) => [component.id, component]));
    container.createEl("h3", { text: impact ? "Potential blast radius" : "Upstream lineage" });
    if (impact) {
      container.createEl("p", { text: `${downstream.componentIds.length - 1} downstream components are architecturally reachable. This is not proof of runtime impact.` });
      this.renderLineageList(container, downstream.componentIds.slice(1), byId, downstream.depthByComponent);
    } else {
      this.renderLineageList(container, upstream.componentIds.slice(1), byId, upstream.depthByComponent);
      container.createEl("h3", { text: "Downstream lineage" });
      this.renderLineageList(container, downstream.componentIds.slice(1), byId, downstream.depthByComponent);
    }
    if (downstream.cyclesEncountered.length) container.createEl("p", { text: `${downstream.cyclesEncountered.length} potential cycle(s) encountered.`, cls: "dam-warning" });
  }

  private renderLineageList(
    container: HTMLElement,
    ids: string[],
    byId: Map<string, ArchitectureComponent>,
    depths: Record<string, number>
  ): void {
    if (!ids.length) {
      container.createEl("p", { text: "No reachable components discovered." });
      return;
    }
    renderTable(container, ["Depth", "Component", "Type", "Environment"], ids.map((id) => {
      const component = byId.get(id)!;
      return { id, cells: [String(depths[id]), component.name, component.type, component.environment] };
    }), (id) => { this.selectedComponentId = id; this.render(); });
  }

  private renderValidation(container: HTMLElement, findings: ValidationFinding[]): void {
    const query = this.search.toLowerCase();
    const filtered = findings.filter((finding) =>
      (this.severity === "all" || finding.severity === this.severity)
      && (!query || `${finding.ruleId} ${finding.explanation} ${finding.recommendation}`.toLowerCase().includes(query))
    );
    renderTable(container, ["Severity", "Rule", "Confidence", "Explanation", "Recommended action"], filtered.map((finding) => ({
      id: finding.affectedComponentIds[0] ?? finding.id,
      cells: [finding.severity, finding.ruleId, finding.confidence, finding.explanation, finding.recommendation],
      cls: `dam-row-${finding.severity}`
    })), (id) => {
      if (id.includes(":")) this.selectedComponentId = id;
      this.render();
    });
  }

  private renderEnvironmentComparison(container: HTMLElement, graph: ArchitectureGraph, project: ProjectConfig): void {
    const differences = new EnvironmentComparator().compare(graph, project.validation.ignoredEnvironmentProperties ?? [], {}, project.subprojects);
    const environments = environmentNames(project, graph);
    renderTable(container, ["Component", "Property", ...environments, "Status"], differences.map((difference) => ({
      id: `${difference.componentKey}|${difference.property}`,
      cells: [difference.componentKey, difference.property, ...environments.map((environment) =>
        JSON.stringify(difference.values[environment]) ?? "—"
      ), difference.ignored ? "Expected / ignored" : "Review"]
    })));
  }

  private renderInfrastructureChanges(container: HTMLElement, project: ProjectConfig, graph: ArchitectureGraph): void {
    const history = this.host.settings.infrastructureHistory?.[project.id];
    if (!history?.changes.length) {
      container.createEl("p", { text: "The first infrastructure scan records a baseline. Changes appear when a later scan detects different values." });
      return;
    }
    const query = this.search.trim().toLowerCase();
    const componentIds = new Set(graph.components.map((component) => component.id));
    const changes = history.changes.filter((change) =>
      (this.environment === "all" || change.environment === this.environment)
      && (!this.subprojectId || change.subprojectIds?.includes(this.subprojectId))
    ).map((change) => ({
      change,
      workloads: (change.relatedWorkloads ?? []).filter((workload) =>
        !this.subprojectId || workload.subprojectIds?.includes(this.subprojectId))
    })).filter(({ change, workloads }) =>
      !query || [change.componentName, change.parentPath, change.field, formatValue(change.previousValue), formatValue(change.currentValue),
        ...workloads.map((workload) => workload.name)].join(" ").toLowerCase().includes(query)
    ).sort((a, b) => b.change.observedAt.localeCompare(a.change.observedAt));
    const time = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
    const date = (value: string): RichTableCell => {
      const timestamp = new Date(value);
      return {
        text: value,
        render: (cell) => {
          cell.createEl("time", { text: Number.isNaN(timestamp.valueOf()) ? value : time.format(timestamp), attr: { datetime: value, title: value } });
        }
      };
    };
    const historyLayout = container.createDiv({ cls: "dam-history-layout" });
    renderTable(historyLayout, ["Detected on scan", "Environment", "Component", "Characteristic", "Previous value", "New value",
      "Related workloads", "Previous observation"], changes.map(({ change, workloads }) => {
      const name = [change.parentPath, change.componentName].filter(Boolean).join(" / ");
      return {
        id: change.id,
        cells: [
          date(change.observedAt), change.environment,
          componentIds.has(change.componentId) ? {
            text: name,
            render: (cell) => {
              cell.createEl("button", { cls: "dam-table-link", text: name }).onclick = () => this.selectComponent(change.componentId);
            }
          } : name,
          change.field, change.previousValue === undefined ? "—" : formatValue(change.previousValue),
          change.currentValue === undefined ? "—" : formatValue(change.currentValue),
          this.renderWorkloadCell(workloads, componentIds), date(change.previousObservedAt)
        ]
      };
    }));
  }

  private renderWorkloadCell(workloads: RelatedDatabaseWorkload[], componentIds: ReadonlySet<string>): string | RichTableCell {
    if (!workloads.length) return "—";
    return {
      text: workloads.map(({ name }) => name).join(", "),
      render: (cell) => {
        const list = cell.createEl("ul", { cls: "dam-workload-links" });
        for (const workload of workloads) {
          const row = list.createEl("li");
          const title = [readable(workload.type), ...workload.evidencePaths].join(" · ");
          if (componentIds.has(workload.id)) {
            row.createEl("button", { cls: "dam-table-link", text: workload.name, attr: { title } }).onclick = () => this.selectComponent(workload.id);
          } else {
            row.createSpan({ text: workload.name, attr: { title } });
          }
        }
      }
    };
  }

  private renderHistory(container: HTMLElement, project: ProjectConfig): void {
    const snapshots = this.host.settings.snapshots.filter((snapshot) => snapshot.projectId === project.id).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    if (!snapshots.length) {
      container.createEl("p", { text: "No snapshots yet. Capture a snapshot after scanning to establish a comparison baseline." });
      return;
    }
    renderTable(container, ["Name", "Captured", "Components", "Relationships", "Findings"], snapshots.map((snapshot) => ({
      id: snapshot.id,
      cells: [snapshot.name, new Date(snapshot.capturedAt).toLocaleString(), String(snapshot.graph.components.length), String(snapshot.graph.relationships.length), String(snapshot.findings.length)]
    })));
  }

  private renderDetails(container: HTMLElement, analysis: ProjectAnalysis): void {
    const graph = analysis.graph;
    const component = graph.components.find((entry) => entry.id === this.selectedComponentId);
    if (!component) return;
    const header = container.createDiv({ cls: "dam-inspector-header" });
    header.createSpan({ text: "Component inspector" });
    action(header, "Close inspector", "x", "dam-icon-only").onclick = () => this.selectComponent(undefined);
    container.createEl("h3", { text: component.name });
    const infrastructure = INFRASTRUCTURE_TYPES.has(component.type);
    const type = infrastructure ? infrastructureTypeLabel(component.type) : readable(component.type);
    container.createEl("div", { text: `${type} · ${component.environment}`, cls: "dam-badge" });
    if (component.unresolved) container.createEl("div", { text: "Unresolved", cls: "dam-badge dam-error" });
    if (component.type === "kafka-connector") {
      const actions = container.createDiv({ cls: "dam-inspector-actions" });
      action(actions, "Connector Mermaid", "workflow", "dam-outline-accent").onclick = () => this.openConnectorMermaid(
        graph, [component.id], component.name
      );
    }
    const workloads = DATABASE_TYPES.has(component.type) ? databaseWorkloads(graph).get(component.id) ?? [] : [];
    if (workloads.length) {
      container.createEl("h4", { text: "Related workloads" });
      const list = container.createEl("ul", { cls: "dam-dependencies" });
      for (const workload of workloads) {
        const button = list.createEl("li").createEl("button", { attr: { title: workload.evidencePaths.join(", ") } });
        button.createSpan({ text: readable(workload.type) });
        button.createEl("strong", { text: workload.name });
        button.onclick = () => this.selectComponent(workload.id);
      }
    }
    const workloadIds = new Set(workloads.map(({ id }) => id));
    const dependencies = graph.relationships.filter((edge) =>
      (edge.from === component.id && !workloadIds.has(edge.to)) || (edge.to === component.id && !workloadIds.has(edge.from))
    );
    const byId = new Map(graph.components.map((entry) => [entry.id, entry]));
    if (dependencies.length) {
      container.createEl("h4", { text: "Dependencies" });
      const list = container.createEl("ul", { cls: "dam-dependencies" });
      for (const edge of dependencies) {
        const other = byId.get(edge.from === component.id ? edge.to : edge.from);
        if (!other) continue;
        const button = list.createEl("li").createEl("button");
        button.createSpan({ text: readable(edge.type) });
        button.createEl("strong", { text: other.name });
        button.onclick = () => this.selectComponent(other.id);
      }
    }
    container.createEl("h4", { text: "Source files" });
    for (const evidence of component.evidence) {
      const source = action(container, evidence.path, "file-text", "dam-source-link");
      source.setAttr("title", evidence.path);
      source.onclick = () => void this.host.openSource(evidence.path);
    }
    const properties = Object.entries(component.properties).filter(([key]) => key !== "_conflicts");
    if (properties.length) {
      const config = container.createEl("details", { cls: "dam-disclosure" });
      config.open = infrastructure;
      config.createEl("summary", { text: `${infrastructure ? "Characteristics" : "Configuration"} (${properties.length})` });
      const propertyList = config.createEl("dl", { cls: "dam-properties" });
      for (const [key, property] of properties) {
        propertyList.createEl("dt", { text: key });
        propertyList.createEl("dd", { text: formatValue(property.value), attr: { title: property.origin } });
      }
    }
    const findings = analysis.findings.filter((finding) => finding.affectedComponentIds.includes(component.id));
    if (findings.length) {
      const section = container.createEl("details", { cls: "dam-disclosure" });
      section.createEl("summary", { text: `Findings (${findings.length})` });
      for (const finding of findings) section.createEl("p", { cls: `dam-${finding.severity}`, text: finding.explanation });
    }
  }

  private openConnectorMermaid(graph: ArchitectureGraph, ids: string[], title: string, initialEnvironment?: string): void {
    const generator = new MermaidGenerator();
    const selected = new Set(ids);
    const order = this.host.activeProject()?.environments.map((rule) => rule.name);
    new MermaidModal(
      this.app, title, (direction) => generator.generateConnectorDiagrams(graph, selected, direction, order), initialEnvironment
    ).open();
  }

  private chooseFolder(project: ProjectConfig): void {
    const root = project.subprojects?.length ? project.rootFolder : undefined;
    new ConnectorFolderPicker(this.app, (folder) => void this.scanConnectorFolder(project, folder), root).open();
  }

  private async scanConnectorFolder(project: ProjectConfig, folder: TFolder): Promise<void> {
    const previousPath = project.rootFolder;
    const path = folder.path === "/" ? "" : folder.path;
    const subproject = project.subprojects?.find((entry) => scopedFolder(project, entry) === folder.path);
    this.changeScope(subproject?.id);
    if (!project.subprojects?.length) project.rootFolder = path;
    else if (!subproject && path !== project.rootFolder) this.connectorFolder = path;
    try {
      await this.host.engine.scan(project, true);
      await this.host.saveSettings();
    } catch {
      project.rootFolder = previousPath;
      new Notice("The connector folder could not be scanned.");
    }
    this.openTab("Connectors");
  }

  private clearGraph(): void {
    this.graphSize?.disconnect();
    this.graphSize = undefined;
    this.cytoscape?.destroy();
    this.cytoscape = undefined;
  }

  private selectComponent(id: string | undefined): void {
    this.selectedComponentId = id;
    this.updateInspector?.();
    this.highlightSelection();
    for (const row of this.contentEl.querySelectorAll<HTMLElement>("tr[data-component]")) {
      row.toggleClass("is-selected", row.dataset.component === id);
    }
    const inspector = this.contentEl.querySelector<HTMLElement>(".dam-detail");
    if (id && inspector && !inspector.hidden && this.contentEl.clientWidth < 800) inspector.scrollIntoView({ block: "nearest" });
  }

  private highlightSelection(): void {
    const canvas = this.cytoscape;
    if (!canvas) return;
    canvas.elements().removeClass("faded is-selected");
    if (!this.selectedComponentId) return;
    const node = canvas.getElementById(this.selectedComponentId);
    if (node.empty()) return;
    const related = node.closedNeighborhood().union(node.predecessors()).union(node.successors());
    canvas.elements().not(related).not("node:parent").addClass("faded");
    node.addClass("is-selected");
  }

  private filteredComponents(graph: ArchitectureGraph): ArchitectureComponent[] {
    const query = this.search.toLowerCase();
    return graph.components.filter((component) =>
      (this.environment === "all" || component.environment === this.environment)
      && (this.type === "all" || component.type === this.type)
      && (!query || `${component.name} ${component.type} ${component.technology ?? ""} ${Object.keys(component.properties).join(" ")}`.toLowerCase().includes(query))
    );
  }

  private filteredGraph(graph: ArchitectureGraph): ArchitectureGraph {
    const components = this.filteredComponents(graph);
    const associations = new Set<ComponentType>(["kafka-cluster", "connect-worker", "consumer-group", "schema-registry", ...INFRASTRUCTURE_TYPES]);
    const visible = this.infrastructureVisible || this.type !== "all" || this.search
      ? components : components.filter((component) => !associations.has(component.type));
    const ids = new Set(visible.map((component) => component.id));
    return { ...graph, components: visible, relationships: graph.relationships.filter((edge) =>
      ids.has(edge.from) && ids.has(edge.to) && (this.infrastructureVisible || edge.metadata.association !== true)
    ) };
  }

  private async scan(): Promise<void> {
    try {
      await this.host.refreshActiveProject(true);
    } catch (error) {
      new Notice(`Scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async generateDocs(): Promise<void> {
    const project = this.host.activeProject();
    if (!project) return;
    try {
      const result = await this.host.engine.writeDocumentation(project);
      new Notice(`Generated ${result.written.length} files${result.skipped.length ? `; skipped ${result.skipped.length} user-owned files` : ""}.`);
    } catch (error) {
      new Notice(`Documentation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

class ConnectorFolderPicker extends FuzzySuggestModal<TFolder> {
  constructor(app: App, private readonly onPick: (folder: TFolder) => void, private readonly root?: string) {
    super(app);
    this.setPlaceholder(root !== undefined ? "Choose a folder within this project" : "Choose a vault folder containing Kafka Connect configs");
  }

  getItems(): TFolder[] {
    return this.app.vault.getAllLoadedFiles().filter((entry): entry is TFolder =>
      entry instanceof TFolder && (this.root === undefined || isInside(entry.path, this.root))
    );
  }

  getItemText(folder: TFolder): string {
    return folder.path === "/" ? "Entire vault" : folder.path;
  }

  onChooseItem(folder: TFolder): void { this.onPick(folder); }
}

function scopedFolder(project: ProjectConfig, subproject: SubprojectConfig): string {
  return [project.rootFolder.replace(/\/+$/, ""), subproject.folder].filter(Boolean).join("/");
}

function environmentNames(project: ProjectConfig, graph: ArchitectureGraph): string[] {
  return [...new Set([...project.environments.map((rule) => rule.name), ...graph.components.map((component) => component.environment)])];
}

function environmentTone(environment: string): string {
  switch (environment.toLowerCase()) {
    case "dev":
    case "development": return "dam-tone-blue";
    case "stage":
    case "staging": return "dam-tone-amber";
    case "prod":
    case "production": return "dam-tone-teal";
    default: return "";
  }
}

function action(container: HTMLElement, label: string, icon: string, cls = ""): HTMLButtonElement {
  const button = container.createEl("button", { cls: `dam-action ${cls}`, attr: { type: "button", "aria-label": label, title: label } });
  setIcon(button.createSpan({ cls: "dam-button-icon" }), icon);
  button.createSpan({ cls: "dam-button-label", text: label });
  return button;
}

function metric(container: HTMLElement, label: string, value: number, icon: string, tone: string, onClick: () => void): void {
  const card = container.createEl("button", { cls: `dam-metric dam-tone-${tone}` });
  setIcon(card.createSpan({ cls: "dam-metric-icon" }), icon);
  card.createSpan({ cls: "dam-metric-label", text: label });
  card.createEl("strong", { text: value.toLocaleString() });
  setIcon(card.createSpan({ cls: "dam-metric-link" }), "arrow-up-right");
  card.onclick = onClick;
}

function createFilter(container: HTMLElement, label: string, current: string, values: string[], onChange: (value: string) => void): void {
  const select = container.createEl("select", { attr: { "aria-label": label } });
  for (const value of values) {
    const option = select.createEl("option", { text: value === "all" ? (label === "Severity" ? "All severities" : `All ${label.toLowerCase()}s`) : readable(value), value });
    option.selected = value === current;
  }
  select.onchange = () => {
    onChange(select.value);
  };
}

interface RichTableCell {
  text: string;
  render(cell: HTMLTableCellElement): void;
}

function renderTable(
  container: HTMLElement,
  headers: string[],
  rows: Array<{ id: string; cells: Array<string | RichTableCell>; cls?: string }>,
  onClick?: (id: string) => void
): void {
  if (!rows.length) {
    const empty = container.createDiv({ cls: "dam-table-empty" });
    setIcon(empty.createSpan(), "search");
    empty.createEl("p", { text: "No matching records." });
    return;
  }
  const wrapper = container.createDiv({ cls: "dam-table-wrapper" });
  const table = wrapper.createEl("table", { cls: "dam-table" });
  const header = table.createEl("thead").createEl("tr");
  const body = table.createEl("tbody");
  let sorting = { column: -1, asc: true };
  const sortText = (value: string | RichTableCell | undefined): string => typeof value === "string" ? value : value?.text ?? "";
  const draw = (): void => {
    body.empty();
    const sorted = sorting.column < 0 ? rows : [...rows].sort((a, b) =>
      sortText(a.cells[sorting.column]).localeCompare(sortText(b.cells[sorting.column]), undefined, { numeric: true }) * (sorting.asc ? 1 : -1)
    );
    for (const row of sorted) {
      const tr = body.createEl("tr", { cls: row.cls ?? "" });
      if (onClick) {
        tr.addClass("is-clickable");
        tr.dataset.component = row.id;
        tr.onclick = () => onClick(row.id);
      }
      row.cells.forEach((value, index) => {
        const cell = tr.createEl("td", { attr: { "data-label": headers[index] ?? "" } });
        if (typeof value !== "string") value.render(cell);
        else if (onClick && index === 0) cell.createEl("button", { text: value, cls: "dam-table-link" });
        else if (headers[index] === "Environment") cell.createSpan({ text: value, cls: `dam-badge dam-environment-badge ${environmentTone(value)}` });
        else cell.setText(value);
      });
    }
  };
  const headingCells = headers.map((value, column) => {
    const cell = header.createEl("th", { attr: { scope: "col" } });
    const button = action(cell, value, "chevrons-up-down", "dam-sort");
    button.onclick = () => {
      sorting = { column, asc: sorting.column !== column || !sorting.asc };
      headingCells.forEach((other) => other.removeAttribute("aria-sort"));
      cell.setAttr("aria-sort", sorting.asc ? "ascending" : "descending");
      draw();
    };
    return cell;
  });
  draw();
}

function readable(value: string): string {
  return /^[A-Z\d_-]+$/.test(value) && !value.includes("_") ? value
    : value.replace(/[._-]/g, " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase()).replace(/\bkafka\b/ig, "Kafka");
}

function countType(graph: ArchitectureGraph, type: string): number {
  return graph.components.filter((component) => component.type === type).length;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function environmentGroupId(environment: string): string {
  return `__group__env__${encodeURIComponent(environment)}`;
}

function clusterGroupId(environment: string, clusterId: string): string {
  return `__group__cluster__${encodeURIComponent(environment)}__${encodeURIComponent(clusterId)}`;
}

function componentParent(component: ArchitectureComponent): string {
  return component.kafkaClusterId
    ? clusterGroupId(component.environment, component.kafkaClusterId)
    : environmentGroupId(component.environment);
}

function cytoscapeGroups(graph: ArchitectureGraph): Array<{ data: Record<string, unknown> }> {
  const output: Array<{ data: Record<string, unknown> }> = [];
  const environments = [...new Set(graph.components.map((component) => component.environment))].sort();
  for (const environment of environments) {
    output.push({ data: { id: environmentGroupId(environment), label: environment, type: "group" } });
    const clusters = [...new Set(graph.components
      .filter((component) => component.environment === environment)
      .map((component) => component.kafkaClusterId)
      .filter((value): value is string => Boolean(value)))].sort();
    for (const cluster of clusters) {
      const clusterName = graph.components.find((component) => component.id === cluster)?.name ?? cluster.split(":").pop() ?? cluster;
      output.push({ data: {
        id: clusterGroupId(environment, cluster),
        parent: environmentGroupId(environment),
        label: clusterName,
        type: "group"
      } });
    }
  }
  return output;
}

function downloadSvg(graph: Core, filename: string): void {
  const bounds = graph.elements(":visible").boundingBox({ includeLabels: true });
  const padding = 30;
  const width = Math.max(1, bounds.w + padding * 2);
  const height = Math.max(1, bounds.h + padding * 2);
  const offsetX = padding - bounds.x1;
  const offsetY = padding - bounds.y1;
  const edges = graph.edges(":visible").map((edge) => {
    const source = edge.source().position();
    const target = edge.target().position();
    return `<line x1="${source.x + offsetX}" y1="${source.y + offsetY}" x2="${target.x + offsetX}" y2="${target.y + offsetY}" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#arrow)"/>`;
  }).join("");
  const nodes = graph.nodes(":visible").filter((node) => !node.isParent()).map((node) => {
    const current = node as NodeSingular;
    const position = current.position();
    const label = escapeXml(String(current.data("label") ?? ""));
    const color = String(current.style("background-color") || "#64748b");
    return `<g><circle cx="${position.x + offsetX}" cy="${position.y + offsetY}" r="23" fill="${color}"/><text x="${position.x + offsetX}" y="${position.y + offsetY + 36}" text-anchor="middle" fill="#334155" font-family="sans-serif" font-size="10">${label}</text></g>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8"/></marker></defs><rect width="100%" height="100%" fill="#ffffff"/>${edges}${nodes}</svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
