const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { SplitViewShutdown } = load("src/modules/splitView/shutdown.ts");

test("saves and cleans split tabs before unregistering shared services", () => {
  const events = [];
  const states = new Map([
    ["first", { tabID: "first" }],
    ["second", { tabID: "second" }],
    ["third", { tabID: "third" }],
  ]);
  const shutdown = new SplitViewShutdown({
    disposePDFSelector: () => events.push("selector"),
    unregisterReaderContextMenu: () => events.push("reader-menu"),
    getStates: () => states.values(),
    saveAll: (values) => {
      assert.deepEqual(
        [...values].map((state) => state.tabID),
        ["first", "second", "third"],
      );
      events.push("save");
    },
    getTabIDs: () => states.keys(),
    cleanupTabResources: (tabID) => {
      events.push(`cleanup:${tabID}`);
      states.delete(tabID);
      if (tabID === "second") throw new Error("cleanup failed");
    },
    clearStates: () => {
      events.push("clear");
      states.clear();
    },
    unregisterSession: () => events.push("session"),
    unregisterTabNotifier: () => events.push("notifier"),
    unregisterScrollbarObservers: () => events.push("scrollbar"),
    unregisterTabTitles: () => events.push("titles"),
    unregisterReadAloud: () => events.push("read-aloud"),
    unregisterTabLookup: () => events.push("tab-hooks"),
    unregisterCommandPalette: () => events.push("commands"),
    debug: (message) => events.push(message),
  });

  shutdown.unregisterAll();

  assert.deepEqual(events, [
    "selector",
    "reader-menu",
    "save",
    "cleanup:first",
    "cleanup:second",
    "Split view: unregisterAll - cleanupTabResources(second) failed: Error: cleanup failed",
    "cleanup:third",
    "clear",
    "session",
    "notifier",
    "scrollbar",
    "titles",
    "read-aloud",
    "tab-hooks",
    "commands",
  ]);
  assert.equal(states.size, 0);
});

test("window unload saves and cleans only its tabs and retains shared services", () => {
  const first = {};
  const second = {};
  const states = new Map([
    ["first", { tabID: "first", ownerWindow: first }],
    ["second", { tabID: "second", ownerWindow: second }],
    ["third", { tabID: "third", ownerWindow: first }],
  ]);
  const events = [];
  const shared = () => assert.fail("shared services must remain registered");
  const shutdown = new SplitViewShutdown({
    getStates: () => states.values(),
    saveAll: (values) =>
      events.push(["save", [...values].map((state) => state.tabID)]),
    cleanupTabResources: (id) => {
      events.push(["cleanup", id]);
      states.delete(id);
    },
    unregisterTabLookup: (win) => events.push(["hooks", win]),
    unregisterCommandPalette: (win) => events.push(["palette", win]),
    disposePDFSelector: shared,
    unregisterReaderContextMenu: shared,
    getTabIDs: shared,
    clearStates: shared,
    unregisterSession: shared,
    unregisterTabNotifier: shared,
    unregisterScrollbarObservers: shared,
    unregisterTabTitles: shared,
    unregisterReadAloud: shared,
    debug: shared,
  });
  shutdown.unregisterWindow(first);
  assert.deepEqual(events, [
    ["save", ["first", "third"]],
    ["cleanup", "first"],
    ["cleanup", "third"],
    ["hooks", first],
    ["palette", first],
  ]);
  assert.equal(states.size, 1);
  assert.equal(states.get("second").ownerWindow, second);
  shutdown.unregisterWindow(second);
  assert.equal(states.size, 0);
});
