import { config } from "../../package.json";
import type {
  AttachmentSelectionHandlers,
  AttachmentSelectionRow,
} from "../modules/attachmentSelector/types";

export class PaletteView {
  private root: HTMLDivElement;
  private input: HTMLInputElement;
  private list: HTMLDivElement;
  private handlers: AttachmentSelectionHandlers | null = null;
  private rows: AttachmentSelectionRow[] = [];
  private selected = 0;
  private previousFocus: Element | null = null;

  constructor(
    private readonly win: Window,
    private readonly ui = ztoolkit.UI,
  ) {
    const doc = win.document;
    this.root = this.ui.createElement(doc, "div", {
      namespace: "html",
      classList: ["split-view-palette"],
      attributes: { hidden: "true" },
    });
    const style = this.ui.createElement(doc, "link", {
      namespace: "html",
      attributes: {
        rel: "stylesheet",
        href: `chrome://${config.addonRef}/content/palette.css`,
      },
    });
    const panel = this.ui.createElement(doc, "div", {
      namespace: "html",
      classList: ["split-view-palette-panel"],
      attributes: { role: "dialog", "aria-label": config.addonName },
    });
    this.input = this.ui.createElement(doc, "input", {
      namespace: "html",
      attributes: {
        type: "text",
        role: "combobox",
        "aria-autocomplete": "list",
        "aria-expanded": "true",
        "aria-controls": `${config.addonRef}-choices`,
      },
    });
    this.list = this.ui.createElement(doc, "div", {
      namespace: "html",
      attributes: { id: `${config.addonRef}-choices`, role: "listbox" },
    });
    panel.append(this.input, this.list);
    this.root.append(style, panel);
    doc.documentElement?.appendChild(this.root);
    this.input.addEventListener("input", () =>
      this.handlers?.input(this.input.value),
    );
    this.root.addEventListener("keydown", (event) =>
      this.onKey(event as KeyboardEvent),
    );
    this.root.addEventListener("mousedown", (event) => {
      if (event.target === this.root) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(placeholder: string, handlers: AttachmentSelectionHandlers): void {
    if (!this.isOpen) this.previousFocus = this.win.document.activeElement;
    this.handlers = handlers;
    this.root.hidden = false;
    this.list.replaceChildren();
    this.rows = [];
    this.resetInput(placeholder);
  }

  resetInput(placeholder: string): void {
    this.input.value = "";
    this.input.placeholder = placeholder;
    this.input.setAttribute("aria-label", placeholder);
    this.input.focus();
  }

  render(rows: AttachmentSelectionRow[], emptyMessage: string): void {
    this.rows = rows;
    this.selected = 0;
    this.list.replaceChildren();
    this.input.removeAttribute("aria-activedescendant");
    const doc = this.win.document;
    if (!rows.length) {
      this.list.appendChild(
        this.ui.createElement(doc, "div", {
          namespace: "html",
          classList: ["split-view-palette-empty"],
          properties: { textContent: emptyMessage },
          attributes: { role: "status" },
        }),
      );
    }
    rows.forEach((row, index) => {
      const node = this.ui.createElement(doc, "div", {
        namespace: "html",
        classList: ["split-view-palette-row"],
        attributes: {
          id: `${config.addonRef}-choice-${index}`,
          role: "option",
        },
        children: [
          {
            tag: "strong",
            namespace: "html",
            properties: { textContent: row.title },
          },
          {
            tag: "span",
            namespace: "html",
            properties: { textContent: row.description },
          },
        ],
      });
      node.addEventListener("mousemove", () => this.select(index));
      node.addEventListener("mousedown", (event) => event.preventDefault());
      node.addEventListener("click", () => row.select());
      this.list.appendChild(node);
    });
    this.select(0);
  }

  private select(index: number): void {
    this.selected = index;
    Array.from(this.list.children).forEach((node, i) => {
      node.setAttribute("aria-selected", String(i === index));
      if (i === index && this.rows.length) {
        this.input.setAttribute("aria-activedescendant", node.id);
        node.scrollIntoView({ block: "nearest" });
      }
    });
  }

  private onKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (!["ArrowUp", "ArrowDown", "Enter", "Escape", "Tab"].includes(event.key))
      return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      if (this.input.value) {
        this.input.value = "";
        this.handlers?.input("");
      } else this.handlers?.back();
    } else if (event.key === "Enter") {
      this.rows[this.selected]?.select();
    } else if (event.key === "Tab") {
      this.input.focus();
    } else if (this.rows.length) {
      this.select(
        (this.selected +
          (event.key === "ArrowUp" ? -1 : 1) +
          this.rows.length) %
          this.rows.length,
      );
    }
  }

  close(): void {
    const handlers = this.handlers;
    this.hide();
    handlers?.close();
  }

  hide(): void {
    this.handlers = null;
    this.rows = [];
    this.list.replaceChildren();
    this.root.hidden = true;
    this.input.value = "";
    const focused = this.previousFocus as HTMLElement | null;
    this.previousFocus = null;
    if (focused?.isConnected) focused.focus?.();
  }

  destroy(): void {
    this.close();
    this.root.remove();
  }
}
