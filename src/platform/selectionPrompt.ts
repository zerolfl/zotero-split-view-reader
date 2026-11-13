import type {
  PDFSelectionHandlers,
  PDFSelectionRow,
  PDFSelectionView,
} from "../modules/pdfSelector/types";

interface LegacyPrompt {
  promptNode: HTMLDivElement;
  inputNode: HTMLInputElement;
  lastInputText: string;
  commands: unknown[];
  showSuggestions: (text: string) => unknown;
  exit: () => unknown;
  showCommands: (commands: unknown[], clear?: boolean) => void;
  createCommandsContainer: () => HTMLDivElement;
  selectItem: (node: HTMLDivElement) => void;
}

export function createSelectionPrompt(): PDFSelectionView {
  return new SelectionPrompt(ztoolkit.Prompt.prompt as unknown as LegacyPrompt);
}

class SelectionPrompt implements PDFSelectionView {
  private handlers: PDFSelectionHandlers | null = null;
  private observer: MutationObserver | null = null;
  private originalSearch: LegacyPrompt["showSuggestions"];
  private originalExit: LegacyPrompt["exit"];

  constructor(private readonly prompt: LegacyPrompt) {
    this.originalSearch = prompt.showSuggestions;
    this.originalExit = prompt.exit;
  }

  private search = (text: string): unknown => {
    if (this.handlers) return this.handlers.input(text);
    return this.originalSearch.call(this.prompt, text);
  };

  private back = (): unknown => {
    if (this.handlers) return this.handlers.back();
    return this.originalExit.call(this.prompt);
  };

  open(placeholder: string, handlers: PDFSelectionHandlers): void {
    const prompt = this.prompt;
    const win = prompt.promptNode.ownerDocument
      ?.defaultView as _ZoteroTypes.MainWindow | null;
    if (!win) throw new Error("Selection prompt window is unavailable");
    this.handlers = handlers;
    prompt.showSuggestions = this.search;
    prompt.exit = this.back;
    const observer = new win.MutationObserver(() => {
      if (prompt.promptNode.style.display === "none") this.handlers?.close();
    });
    observer.observe(prompt.promptNode, {
      attributes: true,
      attributeFilter: ["style"],
    });
    this.observer = observer;
    prompt.promptNode.style.display = "flex";
    this.clearContainers();
    prompt.createCommandsContainer();
    this.resetInput(placeholder);
  }

  resetInput(placeholder: string): void {
    this.prompt.inputNode.value = "";
    this.prompt.lastInputText = "";
    this.prompt.inputNode.placeholder = placeholder;
    this.prompt.inputNode.focus();
  }

  render(rows: PDFSelectionRow[], emptyMessage: string): void {
    if (!this.handlers) return;
    const prompt = this.prompt;
    const containers = prompt.promptNode.querySelectorAll(
      ".commands-container",
    );
    for (let i = containers.length - 1; i >= 1; i--) containers[i].remove();
    const container = prompt.createCommandsContainer();
    container.classList.add("suggestions");
    const doc = prompt.promptNode.ownerDocument;
    if (!doc) throw new Error("Selection prompt document is unavailable");
    if (!rows.length) {
      container.appendChild(
        ztoolkit.UI.createElement(doc, "div", {
          namespace: "html",
          styles: { opacity: "0.5", padding: "8px", textAlign: "center" },
          properties: { textContent: emptyMessage },
        }),
      );
      return;
    }
    for (const row of rows) {
      const node: HTMLDivElement = ztoolkit.UI.createElement(doc, "div", {
        namespace: "html",
        classList: ["command"],
        styles: { display: "flex", flexDirection: "column" },
        listeners: [
          { type: "mousemove", listener: () => prompt.selectItem(node) },
          { type: "click", listener: () => row.select() },
        ],
        children: [
          {
            tag: "span",
            classList: ["name"],
            styles: {
              fontWeight: "bold",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            },
            properties: { textContent: row.title },
          },
          {
            tag: "span",
            styles: {
              opacity: "0.7",
              fontSize: "0.9em",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            },
            properties: { textContent: row.description },
          },
        ],
      });
      container.appendChild(node);
    }
    container.querySelector(".command")?.classList.add("selected");
  }

  dispose(showCommands: boolean): void {
    this.handlers = null;
    this.observer?.disconnect();
    this.observer = null;
    const prompt = this.prompt;
    const ownsSearch = prompt.showSuggestions === this.search;
    const ownsExit = prompt.exit === this.back;
    if (ownsSearch) prompt.showSuggestions = this.originalSearch;
    if (ownsExit) prompt.exit = this.originalExit;
    if (!ownsSearch || !ownsExit) return;
    this.clearContainers();
    prompt.createCommandsContainer();
    this.resetInput("");
    if (showCommands) prompt.showCommands(prompt.commands, true);
    else prompt.promptNode.style.display = "none";
  }

  private clearContainers(): void {
    this.prompt.promptNode
      .querySelectorAll(".commands-container")
      .forEach((node: Element) => node.remove());
  }
}
