import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type { EnvironmentRule, PluginSettings, ProjectConfig, SubprojectConfig } from "./model/types";
import { deterministicId, slug } from "./model/ids";

export const DEFAULT_SETTINGS: PluginSettings = {
  projects: [],
  snapshots: []
};

export function createDefaultProject(index: number): ProjectConfig {
  const name = `Data project ${index}`;
  return {
    id: deterministicId("project", `${name}|${Date.now()}`),
    name,
    rootFolder: "",
    documentationFolder: `Data Architecture/${name}`,
    includedFolders: [],
    excludedFolders: ["node_modules", ".git"],
    environments: [
      { name: "DEV", folderPrefixes: ["dev", "development"] },
      { name: "STAGING", folderPrefixes: ["staging", "stage"] },
      { name: "PRODUCTION", folderPrefixes: ["prod", "production"] }
    ],
    kafkaClusterAliases: {},
    filePatterns: ["**/*.{json,yaml,yml,properties,conf,cfg,md}"],
    validation: {},
    automaticRefresh: true,
    refreshDebounceMs: 750
  };
}

export interface SettingsHost {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
  refreshProjectSubprojects(project: ProjectConfig): Promise<void>;
}

export class DataArchitectureSettingTab extends PluginSettingTab {
  private savingScopeRules = false;

  constructor(app: App, private readonly host: SettingsHost) {
    super(app, host as never);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("p", { text: "Projects are scanned locally. Configuration never leaves the vault." });

    for (const [index, project] of this.host.settings.projects.entries()) {
      const section = containerEl.createDiv({ cls: "dam-settings-project" });
      new Setting(section).setName(project.name || `Project ${index + 1}`).setHeading();
      textSetting(section, "Project name", "A readable project name", project.name, async (value) => {
        project.name = value;
        await this.host.saveSettings();
      });
      textSetting(section, "Root vault folder", "Folder containing connector and application configuration", project.rootFolder, async (value) => {
        project.rootFolder = normalizeFolder(value);
        await this.host.saveSettings();
      });
      this.renderEnvironments(section, project);
      this.renderSubprojects(section, project);
      textSetting(section, "Generated documentation folder", "Only plugin-owned generated files are overwritten", project.documentationFolder, async (value) => {
        project.documentationFolder = normalizeFolder(value);
        await this.host.saveSettings();
      });
      textSetting(section, "Include folders", "Comma-separated; empty includes all folders under the root", project.includedFolders.join(", "), async (value) => {
        project.includedFolders = csv(value);
        await this.host.saveSettings();
      });
      textSetting(section, "Exclude folders", "Comma-separated paths relative to the root", project.excludedFolders.join(", "), async (value) => {
        project.excludedFolders = csv(value);
        await this.host.saveSettings();
      });
      textSetting(section, "File patterns", "Comma-separated glob patterns", project.filePatterns.join(", "), async (value) => {
        project.filePatterns = csv(value);
        await this.host.saveSettings();
      });
      textSetting(section, "Kafka cluster aliases", "One alias=value mapping per line", aliasesToText(project.kafkaClusterAliases), async (value) => {
        project.kafkaClusterAliases = parseAliases(value);
        await this.host.saveSettings();
      }, true);
      new Setting(section)
        .setName("Automatic incremental refresh")
        .setDesc("Re-parse only changed configuration files after vault events")
        .addToggle((toggle) => toggle.setValue(project.automaticRefresh).onChange(async (value) => {
          project.automaticRefresh = value;
          await this.host.saveSettings();
        }));
      new Setting(section)
        .setName("Validation policies")
        .setDesc("Minimum replication factor and DLQ policy")
        .addText((text) => text.setPlaceholder("Minimum RF").setValue(String(project.validation.minimumReplicationFactor ?? "")).onChange(async (value) => {
          const parsed = Number(value);
          project.validation.minimumReplicationFactor = value.trim() && Number.isFinite(parsed) ? parsed : undefined;
          await this.host.saveSettings();
        }))
        .addToggle((toggle) => toggle.setTooltip("Require DLQ for sink connectors").setValue(project.validation.requireDlqForSinks ?? false).onChange(async (value) => {
          project.validation.requireDlqForSinks = value;
          await this.host.saveSettings();
        }));
      new Setting(section)
        .setName("Project actions")
        .addButton((button) => button.setButtonText("Make active").onClick(async () => {
          this.host.settings.activeProjectId = project.id;
          await this.host.saveSettings();
          new Notice(`${project.name} is now active.`);
        }))
        .addButton((button) => button.setClass("mod-warning").setButtonText("Remove").onClick(async () => {
          this.host.settings.projects.splice(index, 1);
          if (this.host.settings.activeProjectId === project.id) this.host.settings.activeProjectId = this.host.settings.projects[0]?.id;
          await this.host.saveSettings();
          this.display();
        }));
    }

    new Setting(containerEl)
      .setName("Add project")
      .setDesc("Register another independently scoped architecture project")
      .addButton((button) => button.setCta().setButtonText("Add project").onClick(async () => {
        const project = createDefaultProject(this.host.settings.projects.length + 1);
        this.host.settings.projects.push(project);
        this.host.settings.activeProjectId ??= project.id;
        await this.host.saveSettings();
        this.display();
      }));
  }

  private renderEnvironments(container: HTMLElement, project: ProjectConfig): void {
    new Setting(container).setName("Environments").setHeading();
    for (const environment of project.environments) {
      new Setting(container)
        .setName(environment.name)
        .setDesc(environment.folderPrefixes.join(", "))
        .addButton((button) => button.setButtonText("Edit").setTooltip(`Edit ${environment.name}`).onClick(() => {
          this.editEnvironment(project, environment);
        }))
        .addButton((button) => button.setButtonText("Remove").setTooltip(`Remove the ${environment.name} mapping`).setClass("mod-warning").onClick(async () => {
          try {
            const next = project.environments.filter((rule) => rule !== environment);
            await this.saveScopeRules(project, "environments", next, "Environment");
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Could not remove the environment mapping.");
          }
        }));
    }
    new Setting(container)
      .setName("Add an environment")
      .setDesc("Map folders in this project or its subprojects to a named environment.")
      .addButton((button) => button.setButtonText("Add environment").onClick(() => this.editEnvironment(project)));
  }

  private editEnvironment(project: ProjectConfig, existing?: EnvironmentRule): void {
    new ProjectScopeEditor(this.app, project, {
      kind: "environment",
      existing: existing && { name: existing.name, folder: existing.folderPrefixes.join(", ") },
      save: async (name, path) => {
        const cleanName = name.trim();
        if (!cleanName) throw new Error("Enter an environment name.");
        const id = slug(cleanName);
        if (id === "all" || id === "unknown") throw new Error("Use a name other than All or Unknown.");
        const otherRules = project.environments.filter((rule) => rule !== existing);
        if (otherRules.some((rule) => slug(rule.name) === id)) {
          throw new Error("This environment name is already used.");
        }

        const folderPrefixes = path.split(",").filter((entry) => entry.trim())
          .map((entry) => relativeRuleFolder(entry, "Enter a folder prefix."));
        if (!folderPrefixes.length) throw new Error("Enter at least one folder prefix.");
        if (new Set(folderPrefixes).size !== folderPrefixes.length) throw new Error("List each folder prefix only once.");
        const occupied = new Set(otherRules.flatMap((rule) => rule.folderPrefixes.map(canonicalRuleFolder)));
        const conflict = folderPrefixes.find((prefix) => occupied.has(prefix));
        if (conflict) throw new Error(`The folder prefix ${conflict} already belongs to another environment.`);

        const rule: EnvironmentRule = { ...existing, name: cleanName, folderPrefixes };
        const next = existing ? project.environments.map((entry) => entry === existing ? rule : entry) : [...project.environments, rule];
        await this.saveScopeRules(project, "environments", next, "Environment");
      }
    }).open();
  }

  private renderSubprojects(container: HTMLElement, project: ProjectConfig): void {
    new Setting(container).setName("Subprojects").setHeading();
    for (const subproject of project.subprojects ?? []) {
      new Setting(container)
        .setName(subproject.name)
        .setDesc(subproject.folder)
        .addButton((button) => button.setButtonText("Edit").setTooltip(`Edit ${subproject.name}`).onClick(() => {
          this.editSubproject(project, subproject);
        }))
        .addButton((button) => button.setButtonText("Remove").setTooltip(`Remove ${subproject.name} from this project`).setClass("mod-warning").onClick(async () => {
          try {
            await this.saveSubprojects(project, (current) => current.filter((entry) => entry.id !== subproject.id));
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Could not remove the subproject.");
          }
        }));
    }
    new Setting(container)
      .setName("Add a subproject")
      .setDesc("Assign applications to a named folder under this project's root.")
      .addButton((button) => button.setButtonText("Add subproject").onClick(() => this.editSubproject(project)));
  }

  private editSubproject(project: ProjectConfig, existing?: SubprojectConfig): void {
    new ProjectScopeEditor(this.app, project, {
      kind: "subproject",
      existing,
      save: async (name, path) => {
        await this.saveSubprojects(project, (current) => {
          const cleanName = name.trim();
          if (!cleanName) throw new Error("Enter a subproject name.");
          const folder = relativeRuleFolder(path, "Enter the subproject folder.");
          if (current.some((entry) => entry.id !== existing?.id && entry.folder === folder)) {
            throw new Error("This folder already belongs to a subproject.");
          }
          if (existing) {
            return current.map((entry) => entry.id === existing.id ? { ...entry, name: cleanName, folder } : entry);
          }
          const id = deterministicId("subproject", `${project.id}|${folder}|${Date.now()}`);
          return [...current, { id, name: cleanName, folder }];
        });
      }
    }).open();
  }

  private saveSubprojects(project: ProjectConfig, edit: (current: SubprojectConfig[]) => SubprojectConfig[]): Promise<void> {
    return this.saveScopeRules(project, "subprojects", edit(project.subprojects ?? []), "Subproject");
  }

  private async saveScopeRules<K extends "environments" | "subprojects">(
    project: ProjectConfig,
    key: K,
    next: ProjectConfig[K],
    label: "Environment" | "Subproject"
  ): Promise<void> {
    if (this.savingScopeRules) throw new Error("Wait for the current project settings change to save.");
    const previous = project[key];
    this.savingScopeRules = true;
    try {
      project[key] = next;
      try {
        await this.host.saveSettings();
      } catch {
        project[key] = previous;
        throw new Error(`Could not save the ${label.toLowerCase()} settings.`);
      }
      try {
        await this.host.refreshProjectSubprojects(project);
      } catch {
        new Notice(`${label} settings saved. Refresh the project to update its architecture.`);
      }
      this.display();
    } finally {
      this.savingScopeRules = false;
    }
  }
}

interface ProjectScopeEditorOptions {
  kind: "environment" | "subproject";
  existing?: { name: string; folder: string };
  save(name: string, folder: string): Promise<void>;
}

class ProjectScopeEditor extends Modal {
  constructor(
    app: App,
    private readonly project: ProjectConfig,
    private readonly options: ProjectScopeEditorOptions
  ) {
    super(app);
  }

  onOpen(): void {
    const { kind, existing } = this.options;
    const environment = kind === "environment";
    const label = environment ? "Environment" : "Subproject";
    this.setTitle(`${existing ? "Edit" : "Add"} ${kind}`);
    let name = existing?.name ?? "";
    let folder = existing?.folder ?? "";
    new Setting(this.contentEl)
      .setName("Name")
      .addText((input) => {
        input.inputEl.setAttribute("aria-label", `${label} name`);
        input.setValue(name).setPlaceholder(environment ? "QA" : "Checkout").onChange((value) => { name = value; });
      });
    const root = this.project.rootFolder || "the vault root";
    new Setting(this.contentEl)
      .setName(environment ? "Folder prefixes" : "Folder")
      .setDesc(environment ? "Comma-separated folders relative to the project or subproject root. Use forward slashes." : `Relative to ${root}, for example apps/checkout. Use forward slashes.`)
      .addText((input) => {
        input.inputEl.setAttribute("aria-label", environment ? "Environment folder prefixes" : "Subproject folder");
        input.setValue(folder).setPlaceholder(environment ? "qa, quality-assurance" : "apps/checkout").onChange((value) => { folder = value; });
      });
    const status = this.contentEl.createDiv({ attr: { role: "status" } });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText(`Save ${kind}`).setCta().onClick(async () => {
        status.empty();
        button.setDisabled(true);
        try {
          await this.options.save(name, folder);
          this.close();
        } catch (error) {
          status.setText(error instanceof Error ? error.message : `Could not save the ${kind}.`);
          button.setDisabled(false);
        }
      }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function relativeRuleFolder(path: string, emptyMessage: string): string {
  const value = path.trim();
  if (!value) throw new Error(emptyMessage);
  if (/^(?:\/|~\/|[a-z][a-z0-9+.-]*:)/i.test(value) || value.includes("\\")) {
    throw new Error("Use a folder path relative to the project root.");
  }
  const parts = value.split("/").filter(Boolean);
  if (parts.some((part) => [".", "..", ""].includes(part.trim()))) {
    throw new Error("Use a folder path without . or .. segments.");
  }
  return parts.join("/");
}

function canonicalRuleFolder(path: string): string {
  return path.trim().split("/").filter(Boolean).join("/");
}

function textSetting(
  container: HTMLElement,
  name: string,
  description: string,
  value: string,
  onChange: (value: string) => Promise<void>,
  multiline = false
): void {
  const setting = new Setting(container).setName(name).setDesc(description);
  if (multiline) setting.addTextArea((input) => input.setValue(value).onChange(onChange));
  else setting.addText((input) => input.setValue(value).onChange(onChange));
}

function csv(value: string): string[] {
  return value.split(",").map((entry) => normalizeFolder(entry)).filter(Boolean);
}

function normalizeFolder(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function aliasesToText(aliases: Record<string, string>): string {
  return Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b)).map(([alias, value]) => `${alias}=${value}`).join("\n");
}

function parseAliases(value: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const line of value.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) output[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return output;
}
