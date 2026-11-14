import { assert } from "chai";
import { config } from "../package.json";
import { getPref, setPref } from "../src/utils/prefs";

describe("command palette shortcut integration", function () {
  let win: _ZoteroTypes.MainWindow;
  let root: HTMLElement;
  let input: HTMLInputElement;
  let originalShortcut: string;
  let originalFontSize: number;

  beforeEach(function () {
    win = Zotero.getMainWindow();
    root = win.document.querySelector(".split-view-palette")!;
    assert.ok(root);
    input = root.querySelector("input")!;
    originalShortcut = getPref("commandPaletteShortcut");
    originalFontSize = getPref("commandPaletteFontSize");
  });

  afterEach(function () {
    root.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
    setPref("commandPaletteShortcut", originalShortcut);
    setPref("commandPaletteFontSize", originalFontSize);
  });

  function shortcut(key: string, modifiers: Partial<KeyboardEventInit> = {}) {
    const event = new win.KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    });
    win.document.documentElement.dispatchEvent(event);
    return event;
  }

  function text(id: string) {
    return Zotero[config.addonInstance].data.locale.current.formatMessagesSync([
      { id: `${config.addonRef}-${id}` },
    ])[0].value;
  }

  it("opens the plugin palette with the configured shortcut", function () {
    setPref("commandPaletteShortcut", "Shift+P");
    assert.isTrue(shortcut("P", { shiftKey: true }).defaultPrevented);
    assert.isFalse(root.hidden);
    const options = root.querySelectorAll('[role="option"]');
    assert.lengthOf(options, 2);
    assert.include(
      options[0].textContent,
      text("splitview-command-open-reader"),
    );
    assert.include(
      options[1].textContent,
      text("splitview-command-open-split-view"),
    );
  });

  it("applies a changed shortcut without recreating the window", function () {
    setPref("commandPaletteFontSize", 22);
    setPref("commandPaletteShortcut", "Ctrl+Alt+K");
    assert.isFalse(shortcut("P", { shiftKey: true }).defaultPrevented);
    assert.isTrue(
      shortcut("K", { ctrlKey: true, altKey: true }).defaultPrevented,
    );
    assert.isFalse(root.hidden);
    assert.equal(
      root.style.getPropertyValue("--split-view-palette-font-size"),
      "22px",
    );
  });

  it("records and resets the shortcut from plugin settings", async function () {
    const addon = Zotero[config.addonInstance];
    const previousPrefs = addon.data.prefs;
    const doc = win.document.implementation.createHTMLDocument();
    const value = doc.createElement("input");
    value.id = `zotero-prefpane-${config.addonRef}-command-shortcut-value`;
    const record = doc.createElement("button");
    record.id = `zotero-prefpane-${config.addonRef}-command-shortcut-record`;
    const cancel = doc.createElement("button");
    cancel.id = `zotero-prefpane-${config.addonRef}-command-shortcut-cancel`;
    const reset = doc.createElement("button");
    reset.id = `zotero-prefpane-${config.addonRef}-command-shortcut-reset`;
    const fontSizeMenu = doc.createElement("div") as HTMLDivElement & {
      value: string;
      selectedItem: Element | null;
    };
    fontSizeMenu.id = `zotero-prefpane-${config.addonRef}-command-palette-font-size`;
    for (const size of [14, 16, 18, 20, 22]) {
      const option = doc.createElement("menuitem");
      option.setAttribute("value", String(size));
      option.setAttribute("label", `${size} px`);
      fontSizeMenu.appendChild(option);
    }
    const description = doc.createElement("div");
    description.id = `zotero-prefpane-${config.addonRef}-command-shortcut-desc`;
    doc.body.append(value, record, cancel, reset, fontSizeMenu, description);
    const prefsWindow = { document: doc } as unknown as Window;

    try {
      await addon.hooks.onPrefsEvent("load", { window: prefsWindow });
      assert.equal(fontSizeMenu.value, String(originalFontSize));
      fontSizeMenu.value = "20";
      fontSizeMenu.dispatchEvent(new win.Event("command", { bubbles: true }));
      assert.equal(getPref("commandPaletteFontSize"), 20);
      record.click();
      assert.isTrue(record.hidden);
      assert.isFalse(cancel.hidden);
      assert.isFalse(value.value.includes("zotero-split-view-reader"));
      cancel.click();
      assert.isFalse(record.hidden);
      assert.isTrue(cancel.hidden);
      assert.equal(value.value, originalShortcut.split("+").join(" + "));

      record.click();
      const cancelEvent = new win.KeyboardEvent("keydown", {
        key: "Escape",
        cancelable: true,
      });
      doc.dispatchEvent(cancelEvent);
      assert.isTrue(cancelEvent.defaultPrevented);
      assert.equal(getPref("commandPaletteShortcut"), originalShortcut);

      record.click();
      const outside = doc.createElement("div");
      doc.body.appendChild(outside);
      outside.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
      assert.isFalse(record.hidden);
      assert.isTrue(cancel.hidden);

      record.click();
      const openEvent = new win.KeyboardEvent("keydown", {
        key: "P",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      win.document.documentElement.dispatchEvent(openEvent);
      assert.isFalse(openEvent.defaultPrevented);
      const captureEvent = new win.KeyboardEvent("keydown", {
        key: "K",
        ctrlKey: true,
        altKey: true,
        cancelable: true,
      });
      doc.dispatchEvent(captureEvent);
      assert.isTrue(captureEvent.defaultPrevented);
      assert.equal(getPref("commandPaletteShortcut"), "Ctrl+Alt+K");
      assert.equal(value.value, "Ctrl + Alt + K");
      reset.click();
      assert.equal(getPref("commandPaletteShortcut"), "Shift+P");
      assert.equal(value.value, "Shift + P");
    } finally {
      reset.click();
      addon.data.prefs = previousPrefs;
      setPref("commandPaletteShortcut", originalShortcut);
      setPref("commandPaletteFontSize", originalFontSize);
    }
  });

  it("keeps attachment selection in the plugin palette", function () {
    setPref("commandPaletteShortcut", "Shift+P");
    shortcut("P", { shiftKey: true });
    input.dispatchEvent(
      new win.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
    input.dispatchEvent(
      new win.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.isFalse(root.hidden);
    assert.equal(input.placeholder, text("splitview-select-first-pdf"));
  });
});
