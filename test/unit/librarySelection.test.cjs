const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function setup() {
  const calls = [];
  const states = new Map();
  const parents = new Map();
  const { SplitLibrarySelection } = load(
    "src/modules/splitView/librarySelection.ts",
  );
  const selection = new SplitLibrarySelection({
    getState: (tabID) => states.get(tabID) || null,
    getParentItemID: (itemID) => parents.get(itemID) || null,
    selectItem: (win, itemID) => calls.push([win, itemID]),
  });
  return { calls, parents, selection, states };
}

test("library selection follows the active side and prefers its parent item", () => {
  const fixture = setup();
  const win = {};
  fixture.states.set("split", {
    activeSide: "right",
    leftItemID: 11,
    rightItemID: 22,
    isCleaningUp: false,
  });
  fixture.parents.set(22, 2);

  fixture.selection.showActiveItem("split", win);

  assert.deepEqual(fixture.calls, [[win, 2]]);
});

test("library selection falls back to the active attachment without a parent", () => {
  const fixture = setup();
  const win = {};
  fixture.states.set("split", {
    activeSide: "left",
    leftItemID: 11,
    rightItemID: 22,
    isCleaningUp: false,
  });

  fixture.selection.showActiveItem("split", win);

  assert.deepEqual(fixture.calls, [[win, 11]]);
});

test("library selection ignores missing or cleaning split state", () => {
  const fixture = setup();
  fixture.states.set("closing", {
    activeSide: "left",
    leftItemID: 11,
    rightItemID: 22,
    isCleaningUp: true,
  });

  fixture.selection.showActiveItem("missing", {});
  fixture.selection.showActiveItem("closing", {});

  assert.deepEqual(fixture.calls, []);
});

test("library pane adapter prefers the window-local pane and falls back", () => {
  const { LibraryPaneAdapter } = load("src/platform/libraryPane.ts");
  const calls = [];
  const localPane = { selectItem: (id) => calls.push(["local", id]) };
  const globalPane = { selectItem: (id) => calls.push(["global", id]) };
  const adapter = new LibraryPaneAdapter();

  assert.equal(
    adapter.selectItem(
      { ZoteroPane_Local: localPane, ZoteroPane: globalPane },
      5,
    ),
    true,
  );
  assert.equal(adapter.selectItem({ ZoteroPane: globalPane }, 6), true);
  assert.equal(adapter.selectItem({}, 7), false);
  assert.deepEqual(calls, [
    ["local", 5],
    ["global", 6],
  ]);
});
