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
  const legacy = load("src/platform/legacyCommands.ts", { Zotero });
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
      "../platform/legacyCommands": legacy,
      "../utils/locale": { getString: (key) => key },
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
  return { commandPalette, views, win, Zotero, shortcut };
}

test("Shift+P opens commands, filters, starts once and releases the window", async () => {
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

test("legacy palette shares the command without method hooks or duplicate shortcuts", () => {
  const { commandPalette, views, win, Zotero, shortcut } = runtime();
  let runs = 0;
  commandPalette.register(win, async () => {
    runs++;
  });
  const other = { id: "other" };
  const prompt = {
    promptNode: { ownerDocument: win.document, style: {} },
    commands: [other],
    exit() {},
  };
  const originalExit = prompt.exit;
  Zotero._toolkitGlobal = { prompt: { instance: prompt } };
  assert.equal(shortcut().defaultPrevented, false);
  assert.ok(!views[0].isOpen);
  shortcut();
  assert.equal(prompt.commands.length, 2);
  prompt.commands[1].callback();
  assert.equal(runs, 1);
  assert.equal(prompt.promptNode.style.display, "none");
  commandPalette.unregister();
  assert.deepEqual(prompt.commands, [other]);
  assert.equal(prompt.exit, originalExit);
});
