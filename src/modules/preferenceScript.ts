import { config } from "../../package.json";
import { SplitViewFactory } from "./splitView";
import { getPref, setPref } from "../utils/prefs";
import { getString } from "../utils/locale";
import type { SplitTabsTitleMode } from "../utils/splitTabTitle";

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

  // Initialize color preview with current pref values
  updateColorPreview(doc);
}

function bindPrefEvents() {
  if (!addon.data.prefs?.window) return;
  const doc = addon.data.prefs.window.document;

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
