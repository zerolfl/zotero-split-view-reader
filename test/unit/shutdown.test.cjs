const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { SplitViewShutdown } = load("src/modules/splitView/shutdown.ts");

test("restores split tabs before clearing shared state", async () => {
  const events = [];
  const states = new Map([
    ["first", { tabID: "first" }],
    ["second", { tabID: "second" }],
    ["third", { tabID: "third" }],
  ]);
  const shutdown = new SplitViewShutdown({
    disposeAttachmentSelector: () => events.push("selector"),
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
    restoreTabForDisable: async (tabID) => {
      events.push(`restore:${tabID}`);
      if (tabID === "second") throw new Error("restore failed");
      states.delete(tabID);
    },
    cleanupTabResources: (tabID) => {
      events.push(`cleanup:${tabID}`);
      states.delete(tabID);
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

  await shutdown.unregisterAll();

  assert.deepEqual(events, [
    "selector",
    "reader-menu",
    "session",
    "notifier",
    "scrollbar",
    "titles",
    "read-aloud",
    "tab-hooks",
    "commands",
    "restore:first",
    "restore:second",
    "Split view: unregisterAll - restoreTabForDisable(second) failed: Error: restore failed",
    "cleanup:second",
    "restore:third",
    "clear",
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
    disposeAttachmentSelector: shared,
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
