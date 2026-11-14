const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Event, EventTarget } = globalThis;
const { load } = require("./helpers.cjs");

function runtime() {
  const views = [];
  const win = Object.assign(new EventTarget(), { document: {} });
  const Zotero = {
    getMainWindow: () => win,
    logError(error) {
      throw error;
    },
  };
  const shortcutModule = load("src/ui/commandShortcut.ts", {});
  let configuredShortcut = "Shift+P";
  class PaletteView {
    constructor() {
      views.push(this);
    }
    open(hint, handlers) {
      this.hint = hint;
      this.handlers = handlers;
      this.isOpen = true;
    }
    hide() {
      this.handlers = null;
      this.isOpen = false;
    }
    close() {
      const handlers = this.handlers;
      this.hide();
      handlers?.close();
    }
    resetInput(hint) {
      this.hint = hint;
    }
    render(rows) {
      this.rows = rows;
    }
    destroy() {
      this.close();
      this.destroyed = true;
    }
  }
  const { commandPalette } = load(
    "src/ui/commandPalette.ts",
    { Zotero },
    {
      "../utils/locale": { getString: (key) => key },
      "../utils/prefs": {
        getPref: () => configuredShortcut,
      },
      "./commandShortcut": shortcutModule,
      "./paletteView": { PaletteView },
    },
  );
  const shortcut = (owner = win, target = {}, extra = {}) => {
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, {
      key: "P",
      shiftKey: true,
      originalTarget: target,
      ...extra,
    });
    owner.dispatchEvent(event);
    return event;
  };
  return {
    commandPalette,
    views,
    win,
    shortcut,
    setShortcut: (value) => {
      configuredShortcut = value;
    },
  };
}

test("the configured shortcut opens commands and runs the selected command", async () => {
  const { commandPalette, views, win, shortcut } = runtime();
  let runs = 0;
  commandPalette.register(win, async () => {
    runs++;
  });
  commandPalette.register(win, async () => {
    runs += 10;
  });
  assert.equal(views.length, 1);
  assert.equal(shortcut().defaultPrevented, true);
  const view = views[0];
  assert.equal(view.isOpen, true);
  view.handlers.input("missing");
  assert.equal(view.rows.length, 0);
  view.handlers.input("splitview");
  view.rows[0].select();
  assert.equal(view.isOpen, false);
  assert.equal(runs, 1);
  commandPalette.unregister(win);
  assert.equal(view.destroyed, true);
  assert.equal(shortcut().defaultPrevented, false);
});

test("command palette routes commands separately and reads a changed shortcut", () => {
  const { commandPalette, views, win, shortcut, setShortcut } = runtime();
  const calls = [];
  commandPalette.register(win, [
    {
      id: "open-attachment-in-reader",
      name: "Open in Zotero Reader",
      description: "Split-View Reader",
      run: async () => calls.push("reader"),
    },
    {
      id: "split-view-reader",
      name: "Open in Split View",
      description: "Split-View Reader",
      run: async () => calls.push("split"),
    },
  ]);
  setShortcut("Ctrl+Alt+K");
  assert.equal(shortcut().defaultPrevented, false);
  assert.equal(
    shortcut(
      win,
      {},
      { key: "K", shiftKey: false, ctrlKey: true, altKey: true },
    ).defaultPrevented,
    true,
  );
  assert.equal(views[0].rows.length, 2);
  views[0].handlers.input("reader");
  assert.deepEqual(
    views[0].rows.map((row) => row.title),
    ["Open in Zotero Reader"],
  );
  views[0].rows[0].select();
  assert.deepEqual(calls, ["reader"]);
});

test("editable targets and modified shortcuts stay with the host", () => {
  const { commandPalette, views, win, shortcut } = runtime();
  commandPalette.register(win, async () => {});
  for (const [target, extra] of [
    [{ value: "" }, {}],
    [{ isContentEditable: true }, {}],
    [{}, { ctrlKey: true }],
    [{}, { repeat: true }],
  ]) {
    assert.equal(shortcut(win, target, extra).defaultPrevented, false);
    assert.ok(!views[0].isOpen);
  }
});

test("selection returns to commands and window unload settles external close", () => {
  const { commandPalette, views, win } = runtime();
  commandPalette.register(win, async () => {});
  const selection = commandPalette.createSelectionView();
  let closes = 0;
  const handlers = { input() {}, back() {}, close: () => closes++ };
  selection.open("PDF", handlers);
  selection.dispose(true);
  assert.equal(views[0].isOpen, true);
  assert.equal(closes, 0);
  selection.open("PDF", handlers);
  commandPalette.unregister(win);
  assert.equal(closes, 1);
});
