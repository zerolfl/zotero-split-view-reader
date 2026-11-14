import type { PDFSelectionView } from "../modules/pdfSelector/types";
import { LegacyCommands } from "../platform/legacyCommands";
import { getString } from "../utils/locale";
import { PaletteView } from "./paletteView";

class CommandPalette {
  private windows = new Map<
    Window,
    { view: PaletteView; key: (event: KeyboardEvent) => void; run: () => void }
  >();
  private legacy = new LegacyCommands();

  register(win: Window, command: () => Promise<void>): void {
    if (this.windows.has(win)) return;
    const view = new PaletteView(win);
    const run = () => {
      view.hide();
      void command().catch((error) => Zotero.logError(error));
    };
    const registerLegacy = () =>
      this.legacy.register(
        win,
        "split-view-reader",
        getString("splitview-command-label"),
        run,
      );
    const key = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || event.key.toLowerCase() !== "p")
        return;
      const target = (event as any).originalTarget || event.target;
      if (target?.isContentEditable || (target && "value" in target)) return;
      const legacy = registerLegacy();
      if (
        !event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        legacy ||
        event.defaultPrevented
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (view.isOpen) view.close();
      else this.showCommands(win);
    };
    this.windows.set(win, { view, key, run });
    registerLegacy();
    win.addEventListener("keydown", key, { capture: true });
  }

  private showCommands(win: Window): void {
    const entry = this.windows.get(win);
    if (!entry) return;
    const name = getString("splitview-command-label");
    const render = (text: string) =>
      entry.view.render(
        name.toLowerCase().includes(text.trim().toLowerCase())
          ? [
              {
                title: name,
                description: "Split-View Reader",
                select: entry.run,
              },
            ]
          : [],
        getString("splitview-not-found"),
      );
    entry.view.open(name, {
      input: render,
      back: () => entry.view.hide(),
      close: () => {},
    });
    render("");
  }

  createSelectionView(): PDFSelectionView {
    const win = Zotero.getMainWindow();
    const entry = this.windows.get(win);
    if (!entry) throw new Error("Split-view command palette is unavailable");
    return {
      open: (hint, handlers) => entry.view.open(hint, handlers),
      resetInput: (hint) => entry.view.resetInput(hint),
      render: (rows, empty) => entry.view.render(rows, empty),
      dispose: (showCommands) => {
        entry.view.hide();
        if (showCommands) this.showCommands(win);
      },
    };
  }

  unregister(win?: Window): void {
    for (const [owner, entry] of this.windows) {
      if (win && win !== owner) continue;
      owner.removeEventListener("keydown", entry.key, { capture: true });
      entry.view.destroy();
      this.windows.delete(owner);
    }
    this.legacy.unregister(win);
  }
}

export const commandPalette = new CommandPalette();
