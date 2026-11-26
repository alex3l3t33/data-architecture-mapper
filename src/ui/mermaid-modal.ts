import { Component, MarkdownRenderer, Modal, Notice, setIcon, type App } from "obsidian";
import type { EnvironmentMermaidDiagram } from "../output/mermaid";

type Direction = "LR" | "TB";

export class MermaidModal extends Modal {
  private renderer?: Component;

  constructor(
    app: App,
    private readonly title: string,
    private readonly generate: (direction: Direction) => EnvironmentMermaidDiagram[],
    private readonly initialEnvironment?: string
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("dam-wide-modal");
    this.modalEl.addClass("dam-diagram-modal");
    this.contentEl.addClass("dam-mermaid-modal");
    const header = this.contentEl.createDiv({ cls: "dam-modal-heading" });
    setIcon(header.createSpan({ cls: "dam-modal-icon" }), "workflow");
    const text = header.createDiv();
    text.createEl("h2", { text: "Connector Mermaid" });
    text.createEl("p", { text: this.title });

    const horizontal = this.generate("LR");
    const first = horizontal.find(({ environment }) => environment === this.initialEnvironment) ?? horizontal[0];
    if (!first) {
      this.contentEl.createEl("p", { text: "No connectors were found for this scope." });
      return;
    }
    let environment = first.environment;
    const environmentButtons = new Map<string, HTMLButtonElement>();
    if (horizontal.length > 1) {
      const chooser = this.contentEl.createDiv({ cls: "dam-mermaid-environments", attr: { role: "group", "aria-label": "Diagram environment" } });
      for (const diagram of horizontal) {
        const button = chooser.createEl("button", { text: diagram.environment, attr: { type: "button" } });
        environmentButtons.set(diagram.environment, button);
      }
    }

    const toolbar = this.contentEl.createDiv({ cls: "dam-mermaid-toolbar" });
    const summary = toolbar.createSpan({ cls: "dam-mermaid-summary", attr: { role: "status" } });
    const direction = toolbar.createEl("select", { attr: { "aria-label": "Diagram direction" } });
    direction.createEl("option", { value: "LR", text: "Left to right" });
    direction.createEl("option", { value: "TB", text: "Top to bottom" });
    if (this.modalEl.ownerDocument.defaultView?.matchMedia("(max-width: 620px)").matches) direction.value = "TB";
    const fullSize = toolbar.createEl("button", { text: "Full size", attr: { type: "button", "aria-pressed": "false" } });
    const copy = toolbar.createEl("button", { text: "Copy Mermaid", cls: "mod-cta" });
    const preview = this.contentEl.createDiv({
      cls: "dam-mermaid-preview", attr: { role: "region", "aria-label": "Mermaid diagram", tabindex: "0" }
    });
    const source = this.contentEl.createEl("details", { cls: "dam-disclosure" });
    source.createEl("summary", { text: "Mermaid source" });
    const code = source.createEl("pre").createEl("code");
    let vertical: EnvironmentMermaidDiagram[] | undefined;
    let mermaid = "";

    const refresh = async (): Promise<void> => {
      const diagrams = direction.value === "TB" ? (vertical ??= this.generate("TB")) : horizontal;
      const active = diagrams.find((diagram) => diagram.environment === environment);
      if (!active) return;
      for (const [name, button] of environmentButtons) button.setAttr("aria-pressed", String(name === active.environment));
      summary.setText(`${active.environment} · ${active.connectorCount} ${active.connectorCount === 1 ? "connector" : "connectors"}`);
      preview.setAttr("aria-label", `${active.environment} Mermaid diagram`);
      copy.setText("Copy Mermaid");
      mermaid = active.mermaid;
      code.setText(mermaid);
      this.renderer?.unload();
      const renderer = new Component();
      this.renderer = renderer;
      renderer.load();
      fullSize.disabled = true;
      preview.empty();
      const frame = preview.createDiv();
      try {
        await MarkdownRenderer.render(this.app, "```mermaid\n" + mermaid + "\n```", frame, "", renderer);
        if (this.renderer !== renderer) return;
        const width = frame.querySelector("svg")?.viewBox.baseVal.width;
        if (width && Number.isFinite(width)) {
          frame.style.setProperty("--dam-mermaid-width", `${Math.ceil(width)}px`);
          fullSize.disabled = false;
        }
        preview.scrollTo(0, 0);
      } catch {
        if (this.renderer !== renderer) return;
        frame.setText("The diagram could not be rendered. The Mermaid source is available below.");
        source.open = true;
      }
    };
    for (const [name, button] of environmentButtons) {
      button.onclick = () => {
        if (name === environment) return;
        environment = name;
        void refresh();
      };
    }
    direction.onchange = () => void refresh();
    fullSize.onclick = () => {
      const expanded = fullSize.getAttribute("aria-pressed") !== "true";
      fullSize.setAttr("aria-pressed", String(expanded));
      preview.toggleClass("is-full-size", expanded);
      preview.scrollTo(0, 0);
    };
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(mermaid);
        copy.setText("Copied");
        window.setTimeout(() => copy.setText("Copy Mermaid"), 1500);
      } catch {
        source.open = true;
        new Notice("Select and copy the Mermaid source below.");
      }
    };
    void refresh();
  }

  onClose(): void {
    this.renderer?.unload();
    this.renderer = undefined;
    this.contentEl.empty();
  }
}
