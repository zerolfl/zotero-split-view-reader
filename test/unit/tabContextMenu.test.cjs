const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function setup() {
  const listeners = new Map();
  const tabs = new Map();
  const selected = [];
  let active = true;
  const document = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    querySelector: () => popupset,
  };
  const popupset = {};
  const win = { document };
  const { SplitTabContextMenu } = load(
    "src/platform/tabContextMenu.ts",
    {
      Date,
      Zotero: {
        getString: (key) =>
          key === "general.showInLibrary" ? "Show in Library" : "Move Tab",
        debug: () => {},
      },
    },
    {
      "./tabs": {
        tabsForWindow: () => ({ lookup: (id) => ({ tab: tabs.get(id) }) }),
      },
    },
  );
  const commands = [];
  let popup;
  const menu = {
    localName: "menuitem",
    getAttribute: (name) => (name === "label" ? "Show in Library" : null),
    cloneNode: () => ({
      addEventListener: (type, callback) =>
        type === "command" && commands.push(callback),
    }),
    replaceWith: (replacement) => {
      popup.children[popup.children.indexOf(menu)] = replacement;
    },
  };
  const moveMenu = {
    localName: "menu",
    getAttribute: (name) => (name === "label" ? "Move Tab" : null),
  };
  popup = {
    localName: "menupopup",
    parentElement: popupset,
    children: [menu, moveMenu],
  };
  const adapter = new SplitTabContextMenu({
    isActiveSplitView: () => active,
    showInLibrary: (id) => selected.push(id),
  });

  function dispatch(type, event) {
    listeners.get(type)?.(event);
  }
  function openContextMenu(id, children = [menu, moveMenu]) {
    popup.children = children;
    dispatch("contextmenu", {
      target: {
        closest: () => ({ getAttribute: () => id }),
      },
    });
    dispatch("popupshowing", { target: popup });
  }

  return {
    adapter,
    commands,
    dispatch,
    listeners,
    menu,
    openContextMenu,
    popup,
    selected,
    setActive: (value) => (active = value),
    tabs,
    win,
  };
}

test("tab menu only decorates the direct Zotero tab popup for split tabs", () => {
  const harness = setup();
  harness.adapter.register(harness.win);
  harness.tabs.set("split", { data: { isSplitView: true } });
  harness.tabs.set("ordinary", { data: {} });

  harness.openContextMenu("ordinary");
  assert.equal(harness.commands.length, 0);
  harness.popup.parentElement = {};
  harness.openContextMenu("split");
  assert.equal(harness.commands.length, 0);
  harness.popup.parentElement = harness.win.document.querySelector("popupset");
  harness.openContextMenu("split", [harness.menu]);
  assert.equal(harness.commands.length, 0);
  harness.openContextMenu("split");
  assert.equal(harness.commands.length, 1);
  assert.notStrictEqual(harness.popup.children[0], harness.menu);
});

test("tab menu command rechecks split state and invokes the supplied action", () => {
  const harness = setup();
  harness.adapter.register(harness.win);
  harness.tabs.set("split", { data: { isSplitView: true } });
  harness.openContextMenu("split");

  let prevented = 0;
  let stopped = 0;
  harness.commands[0]({
    preventDefault: () => prevented++,
    stopPropagation: () => stopped++,
    stopImmediatePropagation: () => stopped++,
  });
  assert.deepEqual(harness.selected, ["split"]);
  assert.equal(prevented, 1);
  assert.equal(stopped, 2);

  harness.openContextMenu("split");
  harness.setActive(false);
  harness.commands[1]({
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  });
  assert.deepEqual(harness.selected, ["split"]);
});

test("tab menu listeners unregister idempotently and clear popup context", () => {
  const harness = setup();
  harness.adapter.register(harness.win);
  harness.adapter.register(harness.win);
  assert.equal(harness.listeners.size, 3);
  harness.tabs.set("split", { data: { isSplitView: true } });
  harness.openContextMenu("split");
  harness.dispatch("popuphidden", { target: harness.popup });
  harness.openContextMenu("split");
  assert.equal(harness.commands.length, 2);

  harness.adapter.unregister();
  harness.adapter.unregister();
  assert.equal(harness.listeners.size, 0);
});

test("unregistering one window leaves the other window's menu listeners", () => {
  const first = setup();
  const second = setup();
  first.adapter.register(first.win);
  first.adapter.register(second.win);
  assert.equal(first.listeners.size, 3);
  assert.equal(second.listeners.size, 3);
  first.adapter.unregister(first.win);
  assert.equal(first.listeners.size, 0);
  assert.equal(second.listeners.size, 3);
  first.adapter.unregister();
  assert.equal(second.listeners.size, 0);
});
