import { Modal, Notice, setIcon, type App } from "obsidian";
import type { ConnectExportEnvironment, ConnectExportTarget, ProjectConfig } from "../model/types";
import { CONNECT_EXPORT_ENVIRONMENTS, createConnectExportCommands, defaultConnectExportTarget } from "../integrations/connect-export";
import { connectScriptPath } from "../integrations/connect-script-path";
import { runConnectScript, supportsConnectScripts } from "../integrations/connect-script-runner";

export class ConnectExportModal extends Modal {
  private environment: ConnectExportEnvironment = "DEV";
  private target: ConnectExportTarget;

  constructor(
    app: App,
    private readonly project: ProjectConfig,
    private readonly saveSettings: () => Promise<void>,
    private readonly refresh: () => Promise<unknown>
  ) {
    super(app);
    this.target = this.loadTarget();
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const root = this.contentEl;
    this.modalEl.addClass("dam-wide-modal");
    root.empty();
    root.addClass("dam-export-modal");
    const heading = root.createDiv({ cls: "dam-modal-heading" });
    setIcon(heading.createSpan({ cls: "dam-modal-icon" }), "terminal");
    const text = heading.createDiv();
    text.createEl("h2", { text: "Export connector configs" });
    text.createEl("p", { text: this.project.name });
    const layout = root.createDiv({ cls: "dam-export-controls" });
    const scope = layout.createDiv({ cls: "dam-export-fields" });
    const env = this.select(scope, "Environment", this.environment, CONNECT_EXPORT_ENVIRONMENTS.map((value) => [value, value]));
    const mode = this.select(scope, "Connection", this.target.mode, [["direct", "Direct REST URL"], ["kubernetes", "Kubernetes port-forward"]]);
    const controls = layout.createDiv({ cls: "dam-export-fields" });
    const commands = root.createDiv({ cls: "dam-export-commands" });
    const update = (): void => this.renderCommands(commands);

    env.onchange = () => {
      this.environment = env.value as ConnectExportEnvironment;
      this.target = this.loadTarget();
      this.render();
    };
    mode.onchange = () => {
      const next = mode.value as ConnectExportTarget["mode"];
      const saved = this.project.connectExportTargets?.[this.environment];
      this.target = saved?.mode === next ? { ...saved } : defaultConnectExportTarget(this.environment, next);
      this.render();
    };

    const target = this.target;
    if (target.mode === "direct") {
      this.field(controls, "Connect REST base URL", target.url, "https://connect.example.com", (value) => { target.url = value; update(); });
    } else {
      this.field(controls, "Kubeconfig context", target.context, "dev-cluster", (value) => { target.context = value; update(); });
      this.field(controls, "Namespace", target.namespace, "kafka", (value) => { target.namespace = value; update(); });
      this.field(controls, "Connect Service", target.service, "my-connect-connect-api", (value) => { target.service = value; update(); });
      this.field(controls, "Local port", target.localPort, "", (value) => { target.localPort = value; update(); });
      this.field(controls, "Service port", target.servicePort, "", (value) => { target.servicePort = value; update(); });
    }
    this.field(controls, "Kafka cluster alias (optional)", target.clusterAlias ?? "", "primary", (value) => { target.clusterAlias = value; update(); });
    update();
    this.renderScript(root);
  }

  private loadTarget(): ConnectExportTarget {
    const saved = this.project.connectExportTargets?.[this.environment];
    return saved ? { ...saved } : defaultConnectExportTarget(this.environment, "kubernetes");
  }

  private renderCommands(container: HTMLElement): void {
    container.empty();
    let commands;
    try {
      commands = createConnectExportCommands(this.project, this.environment, this.target);
    } catch (error) {
      container.createEl("p", { text: error instanceof Error ? error.message : String(error), attr: { role: "status" } });
      return;
    }

    this.commandBlock(container, "Run in a terminal from your vault root", commands.combined ?? commands.curl);
    if (commands.portForward) {
      const separate = container.createEl("details", { cls: "dam-disclosure" });
      separate.createEl("summary", { text: "Use separate terminals" });
      this.commandBlock(separate, "Terminal 1 · Start port-forward", commands.portForward);
      this.commandBlock(separate, "Terminal 2 · Run the export from your vault root", commands.curl);
    }
    const meta = container.createDiv({ cls: "dam-export-meta" });
    const destination = meta.createDiv({ cls: "dam-export-output" });
    destination.createSpan({ text: "Output in the vault" });
    destination.createEl("code", { text: commands.outputPath });
    const button = meta.createEl("button", { text: "Save target" });
    button.onclick = async () => {
      this.project.connectExportTargets ??= {};
      this.project.connectExportTargets[this.environment] = { ...this.target };
      await this.saveSettings();
      new Notice(`${this.environment} target saved.`);
    };
  }

  private commandBlock(container: HTMLElement, label: string, command: string): void {
    const section = container.createDiv({ cls: "dam-export-command" });
    const header = section.createDiv({ cls: "dam-export-command-title" });
    header.createEl("h3", { text: label });
    const copy = header.createEl("button", { text: "Copy command", cls: "mod-cta", attr: { "aria-label": `Copy command: ${label}` } });
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(command);
        copy.setText("Copied");
        window.setTimeout(() => copy.setText("Copy command"), 1500);
      } catch {
        new Notice("Select the command text and copy it.");
      }
    };
    section.createEl("pre").createEl("code", { text: command });
  }

  private renderScript(root: HTMLElement): void {
    const section = root.createEl("details", { cls: "dam-export-script dam-disclosure" });
    section.createEl("summary", { text: "Launch a script" });
    const environment = this.environment;
    let value = this.project.connectScriptPaths?.[environment] ?? "";
    const fields = section.createDiv({ cls: "dam-export-fields" });
    const actions = section.createDiv({ cls: "dam-export-script-actions" });
    const status = section.createEl("p", { attr: { role: "status" } });
    const confirm = section.createDiv();
    const save = actions.createEl("button", { text: "Save script path" });
    const run = actions.createEl("button", { text: "Run script" });
    const supported = supportsConnectScripts(this.app);
    const reset = (): void => {
      confirm.empty();
      run.disabled = !supported || !value.trim();
      status.setText(supported ? "" : "Script launching is available in Obsidian desktop on macOS or Linux.");
    };
    this.field(fields, "Vault-relative script path", value, "Scripts/export-connect.sh", (next) => { value = next; reset(); });
    reset();
    save.onclick = async () => {
      try {
        this.project.connectScriptPaths ??= {};
        if (value.trim()) this.project.connectScriptPaths[environment] = connectScriptPath(value);
        else delete this.project.connectScriptPaths[environment];
        await this.saveSettings();
        status.setText(`${environment} script path saved.`);
      } catch (error) {
        status.setText(error instanceof Error ? error.message : String(error));
      }
    };
    run.onclick = () => {
      confirm.empty();
      let script: string;
      try {
        script = connectScriptPath(value);
      } catch (error) {
        status.setText(error instanceof Error ? error.message : String(error));
        return;
      }
      confirm.createEl("p", { text: `Run ${script} for ${environment} with your desktop account’s permissions?` });
      const start = confirm.createEl("button", { text: "Run this script", cls: "mod-warning" });
      confirm.createEl("button", { text: "Cancel" }).onclick = () => confirm.empty();
      start.onclick = async () => {
        confirm.empty();
        run.disabled = true;
        status.setText(`Running ${script}…`);
        try {
          await runConnectScript(this.app, environment, script);
          status.setText("Script finished successfully.");
          await this.refresh();
        } catch (error) {
          status.setText(error instanceof Error ? error.message : String(error));
        } finally {
          run.disabled = !value.trim();
        }
      };
    };
  }

  private select(container: HTMLElement, label: string, current: string, values: ReadonlyArray<readonly [string, string]>): HTMLSelectElement {
    const field = container.createEl("label");
    field.createSpan({ text: label });
    const select = field.createEl("select");
    for (const [value, text] of values) select.createEl("option", { value, text });
    select.value = current;
    return select;
  }

  private field(container: HTMLElement, label: string, value: string, placeholder: string, change: (value: string) => void): void {
    const field = container.createEl("label");
    field.createSpan({ text: label });
    const input = field.createEl("input", { type: "text", value, placeholder });
    input.oninput = () => change(input.value);
  }
}
