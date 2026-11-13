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
