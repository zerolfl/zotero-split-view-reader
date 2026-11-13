const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { SplitScrollbar } = load("src/modules/splitView/scrollbar.ts");

function setup({ failUnregister = false, failColor = false } = {}) {
  const calls = [];
  const observers = [];
  const states = new Map([
    [
      "tab",
      {
        leftBrowser: { side: "left" },
        rightBrowser: { side: "right" },
        primarySide: "left",
        isCleaningUp: false,
      },
    ],
    [
      "closing",
      {
        leftBrowser: { side: "closing-left" },
        rightBrowser: { side: "closing-right" },
        primarySide: "right",
        isCleaningUp: true,
      },
    ],
  ]);
  const service = new SplitScrollbar({
    getState: (id) => states.get(id) || null,
    getTabIDs: () => states.keys(),
    getEffectivePrimarySide: (state) => state.primarySide,
    getColor: () => {
      if (failColor) throw new Error("color failed");
      return { red: 12, green: 34, blue: 56 };
    },
    setPrimaryColor: (browser, color) => calls.push([browser.side, color]),
    registerObserver: (name, callback) => {
      const id = Symbol(name);
      observers.push({ id, name, callback });
      return id;
    },
    unregisterObserver: (id) => {
      calls.push(["unregister", id.description]);
      if (failUnregister) throw new Error("unregister failed");
    },
    debug: (message) => calls.push(["debug", message]),
  });
  return { calls, observers, service };
}

test("applies the selected primary color and clears the secondary side", () => {
  const { calls, service } = setup();

  service.update("tab");

  assert.deepEqual(calls, [
    ["left", { red: 12, green: 34, blue: 56 }],
    ["right", null],
  ]);
});

test("reapplies colors for all tabs and releases preference observers", () => {
  const { calls, observers, service } = setup();
  service.registerObservers("extensions.split-view");
  assert.deepEqual(
    observers.map(({ name }) => name),
    [
      "extensions.split-view.primaryScrollbarR",
      "extensions.split-view.primaryScrollbarG",
      "extensions.split-view.primaryScrollbarB",
    ],
  );

  observers[0].callback();
  service.unregisterObservers();

  assert.deepEqual(calls.slice(0, 2), [
    ["left", { red: 12, green: 34, blue: 56 }],
    ["right", null],
  ]);
  assert.equal(calls.filter(([kind]) => kind === "unregister").length, 3);
});

test("skips inactive split states and continues cleanup after observer errors", () => {
  const { calls, service } = setup({ failUnregister: true });

  service.update("missing");
  service.update("closing");
  service.registerObservers("extensions.split-view");
  service.unregisterObservers();

  assert.equal(calls.filter(([kind]) => kind === "debug").length, 3);
});

test("contains color read failures without applying a partial style", () => {
  const { calls, service } = setup({ failColor: true });

  service.update("tab");

  assert.deepEqual(calls, [
    ["debug", "Split view: updateScrollbarColors error: Error: color failed"],
  ]);
});
