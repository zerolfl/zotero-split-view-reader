const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { SplitTabNotifier } = load("src/modules/splitView/tabNotifier.ts");

function setup({
  states = new Map(),
  capture = (browser) => browser.view,
} = {}) {
  const events = [];
  let callback;
  let unregisterError = false;
  const notifier = new SplitTabNotifier({
    getState: (tabID) => states.get(tabID) || null,
    getActiveParentItemID: (state) => state.activeParentItemID,
    showForSplitView: (win) => events.push(["show", win]),
    updateContextPane: (...args) => events.push(["context", ...args]),
    captureViewState: capture,
    saveViewState: async (itemID, viewState) =>
      events.push(["save", itemID, viewState]),
    cleanupResources: (tabID) => events.push(["cleanup", tabID]),
    registerNotifier: (value) => {
      callback = value;
      events.push(["register"]);
      return "observer-id";
    },
    unregisterNotifier: (id) => {
      events.push(["unregister", id]);
      if (unregisterError) throw new Error("unregister failed");
    },
    debug: (message) => events.push(["debug", message]),
  });
  const win = {
    document: {
      documentElement: {
        classList: {
          add: (name) => events.push(["class-add", name]),
          remove: (name) => events.push(["class-remove", name]),
        },
      },
    },
  };
  return {
    callback: () => callback,
    events,
    notifier,
    setUnregisterError: (value) => (unregisterError = value),
    win,
  };
}

function state(overrides = {}) {
  return {
    leftBrowser: { view: { pageIndex: 1 } },
    rightBrowser: { view: { pageIndex: 2 } },
    leftItemID: 10,
    rightItemID: 20,
    leftViewState: { pageIndex: 3 },
    rightViewState: { pageIndex: 4 },
    activeParentItemID: 110,
    isCleaningUp: false,
    ...overrides,
  };
}

test("registers once and updates split tab chrome on selection", () => {
  const active = state();
  const fixture = setup({ states: new Map([["split", active]]) });
  fixture.notifier.ensureRegistered(fixture.win);
  fixture.notifier.ensureRegistered(fixture.win);

  fixture.callback().notify("select", "tab", ["split"], {});
  fixture.callback().notify("select", "tab", ["ordinary"], {});
  fixture.callback().notify("select", "item", ["split"], {});

  assert.equal(
    fixture.events.filter(([name]) => name === "register").length,
    1,
  );
  assert.ok(fixture.events.some(([name]) => name === "class-add"));
  assert.ok(fixture.events.some(([name]) => name === "show"));
  assert.ok(
    fixture.events.some(
      ([name, tabID, , itemID]) =>
        name === "context" && tabID === "split" && itemID === 110,
    ),
  );
  assert.ok(fixture.events.some(([name]) => name === "class-remove"));
});

test("saves live positions and releases resources when a split tab closes", async () => {
  const fixture = setup({ states: new Map([["split", state()]]) });
  fixture.notifier.ensureRegistered(fixture.win);

  fixture.callback().notify("close", "tab", ["split"], {});
  await Promise.resolve();

  assert.ok(
    fixture.events.some(
      ([name, id, view]) =>
        name === "save" && id === 10 && view.pageIndex === 1,
    ),
  );
  assert.ok(
    fixture.events.some(
      ([name, id, view]) =>
        name === "save" && id === 20 && view.pageIndex === 2,
    ),
  );
  assert.ok(
    fixture.events.some(
      ([name, tabID]) => name === "cleanup" && tabID === "split",
    ),
  );
});

test("saves fallback positions and skips tabs already being cleaned up", async () => {
  const active = state({
    leftBrowser: {},
    rightBrowser: {},
  });
  const cleaning = state({
    isCleaningUp: true,
    leftItemID: 30,
    rightItemID: 40,
  });
  const fixture = setup({
    states: new Map([
      ["active", active],
      ["cleaning", cleaning],
    ]),
    capture: () => {
      throw new Error("browser unloaded");
    },
  });

  fixture.notifier.saveAll([active, cleaning]);
  await Promise.resolve();

  assert.deepEqual(
    fixture.events.filter(([name]) => name === "save"),
    [
      ["save", 10, active.leftViewState],
      ["save", 20, active.rightViewState],
    ],
  );
});

test("unregister is idempotent and clears its ID after an API failure", () => {
  const fixture = setup();
  fixture.notifier.ensureRegistered(fixture.win);
  fixture.setUnregisterError(true);
  fixture.notifier.unregister();
  fixture.notifier.unregister();
  fixture.notifier.ensureRegistered(fixture.win);

  assert.equal(
    fixture.events.filter(([name]) => name === "unregister").length,
    1,
  );
  assert.ok(fixture.events.some(([name]) => name === "debug"));
  assert.equal(
    fixture.events.filter(([name]) => name === "register").length,
    2,
  );
});
