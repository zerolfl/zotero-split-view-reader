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

test("command palette routes split and ordinary reader actions separately", () => {
  const { commandPalette, views, win, shortcut } = runtime();
  const calls = [];
  commandPalette.register(win, [
    {
      id: "split-view-reader",
      name: "Open in Split View",
      description: "Split-View Reader",
      run: async () => calls.push("split"),
    },
    {
      id: "open-attachment-in-reader",
      name: "Open in Reader",
      description: "Zotero Reader",
      run: async () => calls.push("reader"),
    },
  ]);
  shortcut();
  assert.equal(views[0].rows.length, 2);
  views[0].handlers.input("reader");
  assert.deepEqual(
    views[0].rows.map((row) => row.title),
    ["Open in Reader"],
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

function legacyPrompt(win, containers = 0) {
  const prompt = {
    promptNode: {
      ownerDocument: win.document,
      style: {},
      querySelectorAll: () => Array(containers),
    },
    commands: [{ id: "other" }],
    rendered: [],
    showCommands(commands, clear) {
      assert.equal(clear, true);
      this.rendered = [...commands];
      containers = 1;
    },
    exit() {},
  };
  return prompt;
}

test("legacy palette renders a late command without method hooks or duplicate shortcuts", () => {
  const { commandPalette, views, win, Zotero, shortcut } = runtime();
  let runs = 0;
  commandPalette.register(win, [
    {
      id: "split-view-reader",
      name: "Open in Split View",
      description: "Split-View Reader",
      run: async () => {
        runs++;
      },
    },
    {
      id: "open-attachment-in-reader",
      name: "Open in Reader",
      description: "Zotero Reader",
      run: async () => {
        runs += 10;
      },
    },
  ]);
  const prompt = legacyPrompt(win);
  const other = prompt.commands[0];
  const originalExit = prompt.exit;
  const originalShow = prompt.showCommands;
  Zotero._toolkitGlobal = { prompt: { instance: prompt } };
  assert.equal(shortcut().defaultPrevented, false);
  assert.ok(!views[0].isOpen);
  shortcut();
  assert.equal(prompt.commands.length, 3);
  assert.deepEqual(prompt.rendered, prompt.commands);
  prompt.commands[1].callback();
  assert.equal(runs, 1);
  prompt.commands[2].callback();
  assert.equal(runs, 11);
  assert.equal(prompt.promptNode.style.display, "none");
  commandPalette.unregister();
  assert.deepEqual(prompt.commands, [other]);
  assert.equal(prompt.exit, originalExit);
  assert.equal(prompt.showCommands, originalShow);
});

test("a shared palette created later registers before Ctrl+P without consuming it", () => {
  const { commandPalette, views, win, Zotero, shortcut } = runtime();
  commandPalette.register(win, async () => {});
  const prompt = legacyPrompt(win);
  Zotero._toolkitGlobal = { prompt: { instance: prompt } };
  const event = shortcut(win, {}, { ctrlKey: true, shiftKey: false });
  assert.equal(event.defaultPrevented, false);
  assert.ok(!views[0].isOpen);
  assert.equal(prompt.rendered[1].id, "split-view-reader");
  commandPalette.unregister();
});

test("registration refreshes an existing root list but preserves nested workflows", () => {
  for (const containers of [1, 2]) {
    const { commandPalette, win, Zotero } = runtime();
    const prompt = legacyPrompt(win, containers);
    Zotero._toolkitGlobal = { prompt: { instance: prompt } };
    commandPalette.register(win, [
      {
        id: "split-view-reader",
        name: "Open in Split View",
        description: "Split-View Reader",
        run: async () => {},
      },
      {
        id: "open-attachment-in-reader",
        name: "Open in Reader",
        description: "Zotero Reader",
        run: async () => {},
      },
    ]);
    assert.equal(prompt.commands.length, 3);
    assert.equal(prompt.rendered.length, containers === 1 ? 3 : 0);
    commandPalette.unregister();
  }
});

test("an incomplete shared palette keeps the working standalone shortcut", () => {
  const { commandPalette, views, win, Zotero, shortcut } = runtime();
  const prompt = legacyPrompt(win);
  delete prompt.showCommands;
  Zotero._toolkitGlobal = { prompt: { instance: prompt } };
  commandPalette.register(win, async () => {});
  assert.equal(shortcut().defaultPrevented, true);
  assert.equal(views[0].isOpen, true);
  assert.equal(views[0].rows.length, 1);
  commandPalette.unregister();
});
