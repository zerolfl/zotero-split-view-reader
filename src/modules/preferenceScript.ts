import { config } from "../../package.json";
import { SplitViewFactory } from "./splitView";
import { getPref, setPref } from "../utils/prefs";
import { getString } from "../utils/locale";
import { commandPalette } from "../ui/commandPalette";
import type { SplitTabsTitleMode } from "../utils/splitTabTitle";
import {
  DEFAULT_COMMAND_SHORTCUT,
  formatShortcut,
  setShortcutCaptureActive,
} from "../ui/commandShortcut";
import {
  DEFAULT_COMMAND_PALETTE_FONT_SIZE,
  normalizeCommandPaletteFontSize,
} from "../ui/paletteFontSize";

let cancelCommandShortcutCapture: (() => void) | null = null;

export function registerPreferencePane(): void {
  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${config.addonRef}/content/icons/svreader.svg`,
  });
}

function isSplitTabsTitleMode(value: string): value is SplitTabsTitleMode {
  return (
    value === "titleCreatorYear" ||
    value === "creatorYearTitle" ||
    value === "attachmentTitle" ||
    value === "filename"
  );
}

function syncSplitTabsTitleMenulist(doc: Document, mode: SplitTabsTitleMode) {
  const menulist = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-split-tabs-title`,
  ) as
    | (Element & {
        value: string;
        selectedItem?: Element | null;
        setAttribute(name: string, value: string): void;
      })
    | null;
  if (!menulist) return;

  menulist.value = mode;
  const selectedItem = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-split-tabs-title menuitem[value="${mode}"]`,
  ) as Element | null;
  if (selectedItem) {
    menulist.selectedItem = selectedItem;
    const label = selectedItem.getAttribute("label");
    if (label) {
      menulist.setAttribute("label", label);
    }
  }
}

export async function registerPrefsScripts(_window: Window) {
  // This function is called when the prefs window is opened
  // See addon/content/preferences.xhtml onpaneload
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
    };
  } else {
    addon.data.prefs.window = _window;
  }
  updatePrefsUI();
  bindPrefEvents();
}

function updatePrefsUI() {
  if (!addon.data.prefs?.window) return;
  const doc = addon.data.prefs.window.document;

  const mode = getPref("splitTabsTitle");
  syncSplitTabsTitleMenulist(
    doc,
    isSplitTabsTitleMode(mode) ? mode : "filename",
  );
  syncCommandShortcut(doc);
  syncCommandPaletteFontSize(doc);

  // Initialize color preview with current pref values
  updateColorPreview(doc);
}

function bindPrefEvents() {
  if (!addon.data.prefs?.window) return;
  const doc = addon.data.prefs.window.document;

  bindCommandShortcutEvents(doc);

  // Checkbox: Follow mouse focus to switch primary window
  const followFocusCheckbox = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-follow-focus`,
  ) as HTMLInputElement | null;
  followFocusCheckbox?.addEventListener("command", (e: Event) => {
    const target = e.target as HTMLInputElement;
    setPref("followFocusPrimary", target.checked);
  });

  const splitTabsTitleMenulist = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-split-tabs-title`,
  ) as (Element & { value: SplitTabsTitleMode }) | null;
  splitTabsTitleMenulist?.addEventListener("command", (e: Event) => {
    const target = e.target as Element & { value: string };
    const mode = isSplitTabsTitleMode(target.value) ? target.value : "filename";
    setPref("splitTabsTitle", mode);
    syncSplitTabsTitleMenulist(doc, mode);
    SplitViewFactory.refreshOpenSplitViewTabTitles();
  });

  const commandPaletteFontSizeMenulist = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-command-palette-font-size`,
  ) as (Element & { value: string }) | null;
  commandPaletteFontSizeMenulist?.addEventListener(
    "command",
    (event: Event) => {
      const target = event.target as Element & { value: string };
      const fontSize = normalizeCommandPaletteFontSize(Number(target.value));
      setPref("commandPaletteFontSize", fontSize);
      syncCommandPaletteFontSize(doc);
      commandPalette.refreshFontSize();
    },
  );

  // RGB inputs: Primary scrollbar color
  const rInput = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-scrollbar-r`,
  ) as HTMLInputElement | null;
  const gInput = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-scrollbar-g`,
  ) as HTMLInputElement | null;
  const bInput = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-scrollbar-b`,
  ) as HTMLInputElement | null;

  const handleColorChange = (
    input: HTMLInputElement | null,
    prefKey: "primaryScrollbarR" | "primaryScrollbarG" | "primaryScrollbarB",
  ) => {
    if (!input) return;
    input.addEventListener("change", () => {
      let val = parseInt(input.value, 10);
      if (isNaN(val)) val = 0;
      // Clamp to 0-255
      val = Math.max(0, Math.min(255, val));
      input.value = String(val);
      setPref(prefKey, val);
      updateColorPreview(doc);
    });
  };

  handleColorChange(rInput, "primaryScrollbarR");
  handleColorChange(gInput, "primaryScrollbarG");
  handleColorChange(bInput, "primaryScrollbarB");
}

function syncCommandShortcut(doc: Document) {
  const value = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-command-shortcut-value`,
  );
  if (!value) return;
  const shortcut =
    getPref("commandPaletteShortcut") || DEFAULT_COMMAND_SHORTCUT;
  const displayShortcut = shortcut.split("+").join(" + ");
  if ("value" in value) (value as HTMLInputElement).value = displayShortcut;
  else value.textContent = displayShortcut;
}

function syncCommandPaletteFontSize(doc: Document) {
  const menulist = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-command-palette-font-size`,
  ) as
    | (Element & {
        value: string;
        selectedItem?: Element | null;
        setAttribute(name: string, value: string): void;
      })
    | null;
  if (!menulist) return;

  const fontSize = normalizeCommandPaletteFontSize(
    getPref("commandPaletteFontSize") ?? DEFAULT_COMMAND_PALETTE_FONT_SIZE,
  );
  menulist.value = String(fontSize);
  const selectedItem = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-command-palette-font-size menuitem[value="${fontSize}"]`,
  ) as Element | null;
  if (selectedItem) {
    menulist.selectedItem = selectedItem;
    const label = selectedItem.getAttribute("label");
    if (label) menulist.setAttribute("label", label);
  }
}

function bindCommandShortcutEvents(doc: Document) {
  const recordButton = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-command-shortcut-record`,
  ) as HTMLButtonElement | null;
  const resetButton = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-command-shortcut-reset`,
  ) as HTMLButtonElement | null;
  const cancelButton = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-command-shortcut-cancel`,
  ) as HTMLButtonElement | null;
  if (!recordButton || !resetButton || !cancelButton) return;

  const value = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-command-shortcut-value`,
  ) as HTMLInputElement | null;

  const stopCapture = () => {
    cancelCommandShortcutCapture?.();
    cancelCommandShortcutCapture = null;
  };

  recordButton.addEventListener("click", () => {
    stopCapture();
    recordButton.hidden = true;
    cancelButton.hidden = false;
    if (value) {
      value.value = "…";
      value.dataset.recording = "true";
      value.focus();
    }
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.isComposing || event.repeat) return;
      if (event.key === "Escape") {
        stopCapture();
        return;
      }
      if (["Control", "Alt", "Shift", "Meta", "OS"].includes(event.key)) return;

      const shortcut = formatShortcut(event);
      if (!shortcut) return;

      setPref("commandPaletteShortcut", shortcut);
      syncCommandShortcut(doc);
      stopCapture();
    };

    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (recordButton.contains(target) ||
          cancelButton.contains(target) ||
          resetButton.contains(target))
      )
        return;
      stopCapture();
    };

    const cancel = () => {
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("mousedown", onMouseDown, true);
      doc.defaultView?.removeEventListener("pagehide", cancel);
      setShortcutCaptureActive(false);
      recordButton.hidden = false;
      cancelButton.hidden = true;
      if (value) {
        value.dataset.recording = "false";
        syncCommandShortcut(doc);
      }
      if (cancelCommandShortcutCapture === cancel)
        cancelCommandShortcutCapture = null;
    };
    cancelCommandShortcutCapture = cancel;
    setShortcutCaptureActive(true);
    doc.addEventListener("keydown", onKeyDown, true);
    doc.addEventListener("mousedown", onMouseDown, true);
    doc.defaultView?.addEventListener("pagehide", cancel, { once: true });
  });

  cancelButton.addEventListener("click", stopCapture);

  resetButton.addEventListener("click", () => {
    stopCapture();
    setPref("commandPaletteShortcut", DEFAULT_COMMAND_SHORTCUT);
    syncCommandShortcut(doc);
  });
}

function updateColorPreview(doc: Document) {
  const r = getPref("primaryScrollbarR") ?? 255;
  const g = getPref("primaryScrollbarG") ?? 0;
  const b = getPref("primaryScrollbarB") ?? 0;

  const preview = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-color-preview`,
  ) as HTMLElement | null;
  if (preview) {
    preview.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
  }
}
