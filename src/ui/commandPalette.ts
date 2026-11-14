import type { AttachmentSelectionView } from "../modules/attachmentSelector/types";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import {
  DEFAULT_COMMAND_SHORTCUT,
  isShortcutCaptureActive,
  matchesShortcut,
} from "./commandShortcut";
import { PaletteView } from "./paletteView";

interface PaletteCommandRegistration {
  id: string;
  name: string;
  description: string;
  run: () => Promise<void>;
}

class CommandPalette {
  private windows = new Map<
    Window,
    {
      view: PaletteView;
      key: (event: KeyboardEvent) => void;
      commands: PaletteCommandRegistration[];
    }
  >();

  register(
    win: Window,
    commands: PaletteCommandRegistration[] | (() => Promise<void>),
  ): void {
    if (this.windows.has(win)) return;
    const view = new PaletteView(win);
    const entries =
      typeof commands === "function"
        ? [
            {
              id: "split-view-reader",
              name: getString("splitview-command-label"),
              description: getString("splitview-command-label"),
              run: commands,
            },
          ]
        : commands;
    const key = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || isShortcutCaptureActive())
        return;
      const target = (event as any).originalTarget || event.target;
      if (target?.isContentEditable || (target && "value" in target)) return;
      if (event.defaultPrevented) return;
      const shortcut =
        getPref("commandPaletteShortcut") || DEFAULT_COMMAND_SHORTCUT;
      if (!matchesShortcut(event, shortcut)) return;
      event.preventDefault();
      event.stopPropagation();
      if (view.isOpen) view.close();
      else this.showCommands(win);
    };
    this.windows.set(win, { view, key, commands: entries });
    win.addEventListener("keydown", key, { capture: true });
  }

  private showCommands(win: Window): void {
    const entry = this.windows.get(win);
    if (!entry) return;
    const render = (text: string) =>
      entry.view.render(
        entry.commands
          .filter(({ name }) =>
            name.toLowerCase().includes(text.trim().toLowerCase()),
          )
          .map(({ name, description, run }) => ({
            title: name,
            description,
            select: () => {
              entry.view.hide();
              void run().catch((error) => Zotero.logError(error));
            },
          })),
        getString("splitview-not-found"),
      );
    entry.view.open(getString("splitview-command-placeholder"), {
      input: render,
      back: () => entry.view.hide(),
      close: () => {},
    });
    render("");
  }

  createSelectionView(): AttachmentSelectionView {
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
  }
}

export const commandPalette = new CommandPalette();
