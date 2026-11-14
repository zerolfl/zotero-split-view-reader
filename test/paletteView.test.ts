import { assert } from "chai";
import { config } from "../package.json";
import { PaletteView } from "../src/ui/paletteView";
import { getPref, setPref } from "../src/utils/prefs";

describe("palette view", function () {
  let view: PaletteView;
  let win: _ZoteroTypes.MainWindow;
  let root: HTMLElement;
  let input: HTMLInputElement;
  let selected: string[];
  let queries: string[];
  let backs: number;
  let closes: number;
  let originalFontSize: number;

  beforeEach(function () {
    win = Zotero.getMainWindow();
    const toolkit = Zotero[config.addonInstance].data.ztoolkit;
    view = new PaletteView(win, toolkit.UI);
    root = win.document.querySelector(".split-view-palette:last-child")!;
    input = root.querySelector("input")!;
    selected = [];
    queries = [];
    backs = 0;
    closes = 0;
    originalFontSize = getPref("commandPaletteFontSize");
    view.open("PDF", {
      input: (text) => queries.push(text),
      back: () => backs++,
      close: () => closes++,
    });
    view.render(
      ["first", "second"].map((title) => ({
        title,
        description: title,
        select: () => selected.push(title),
      })),
      "Empty",
    );
  });

  afterEach(function () {
    view.destroy();
    setPref("commandPaletteFontSize", originalFontSize);
  });

  function key(value: string, isComposing = false) {
    input.dispatchEvent(
      new win.KeyboardEvent("keydown", {
        key: value,
        isComposing,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  it("supports arrow selection, Enter and mouse selection", function () {
    assert.isTrue(view.isOpen);
    key("ArrowUp");
    key("Enter");
    assert.deepEqual(selected, ["second"]);
    const first = root.querySelector('[role="option"]') as HTMLElement;
    first.click();
    assert.deepEqual(selected, ["second", "first"]);
    assert.equal(
      input.getAttribute("aria-activedescendant"),
      first.nextElementSibling!.id,
    );
  });

  it("applies the configured font size", function () {
    setPref("commandPaletteFontSize", 22);
    view.refreshFontSize();
    assert.equal(
      root.style.getPropertyValue("--split-view-palette-font-size"),
      "22px",
    );
  });

  it("clears a query before navigating back and ignores IME Enter", function () {
    key("Enter", true);
    assert.deepEqual(selected, []);
    input.value = "query";
    key("Escape");
    assert.equal(input.value, "");
    assert.deepEqual(queries, [""]);
    assert.equal(backs, 0);
    key("Escape");
    assert.equal(backs, 1);
  });

  it("does not activate an empty result and closes on the backdrop", function () {
    view.render([], "Empty");
    key("ArrowDown");
    key("Enter");
    assert.deepEqual(selected, []);
    assert.isNull(input.getAttribute("aria-activedescendant"));
    root.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
    assert.isFalse(view.isOpen);
    assert.equal(closes, 1);
    view.destroy();
    assert.equal(closes, 1);
  });
});
