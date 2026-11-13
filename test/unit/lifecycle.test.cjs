const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function setup({
  samePDF = false,
  activeSide = "left",
  prepare,
  findReusable = true,
} = {}) {
  const events = [];
  const state = {
    tabID: "split",
    leftItemID: 1,
    rightItemID: samePDF ? 1 : 2,
    leftBrowser: "left-browser",
    rightBrowser: "right-browser",
    leftViewState: { pageIndex: 0 },
    rightViewState: { pageIndex: 1 },
    activeSide,
    isSamePDF: samePDF,
    isCleaningUp: false,
  };
  const states = new Map([[state.tabID, state]]);
  const tabs = {
    lookup: (id) => ({ tabIndex: 3, tab: id === "split" ? {} : null }),
    select: (id) => events.push(["select", id]),
    close: (id) => events.push(["close", id]),
  };
  const targets = {
    findReusableReaderTabID: (itemID) =>
      findReusable ? `reader-${itemID}` : null,
    waitForTabClosed: async (id) => events.push(["wait-closed", id]),
    waitForSplitViewToSettle: async () => events.push(["settle"]),
    restore: async (id, viewState) =>
      events.push(["restore", id, viewState.pageIndex]),
    prepare: async (target, index, activate, deferRestore) => {
      events.push([
        "prepare",
        target.itemID,
        target.tabID,
        index,
        activate,
        deferRestore,
        target.viewState.pageIndex,
      ]);
      if (prepare) await prepare(target, index, activate, deferRestore);
    },
  };
  const { SplitViewLifecycle } = load("src/modules/splitView/lifecycle.ts", {});
  const lifecycle = new SplitViewLifecycle({
    getState: (id) => states.get(id) || null,
    getTabs: () => tabs,
    targets,
    captureViewState: (browser) =>
      browser === "left-browser" ? { pageIndex: 4 } : { pageIndex: 5 },
    saveViewState: async (id, viewState) =>
      events.push(["save", id, viewState.pageIndex]),
    cleanup: (id) => {
      events.push(["cleanup", id]);
      states.delete(id);
    },
    prepareSingleReaderClose: (id, itemID) =>
      events.push(["rewrite-close", id, itemID]),
    showClosed: () => events.push(["message"]),
    debug: (message) => events.push(["debug", message]),
  });
  return { lifecycle, events, state, states };
}

test("closing one same-PDF side saves only the retained side position", async () => {
  const { lifecycle, events } = setup({ samePDF: true });
  await lifecycle.revertToSingleReader("split", "left");

  assert.deepEqual(
    events.filter(([name]) => name === "save"),
    [["save", 1, 5]],
  );
  assert.ok(events.some((event) => event[0] === "rewrite-close"));
  assert.ok(events.some((event) => event[0] === "close"));
});

test("separating different PDFs saves and restores each live position", async () => {
  const { lifecycle, events } = setup();
  await lifecycle.separate("split", "right");

  assert.deepEqual(
    events.filter(([name]) => name === "save"),
    [
      ["save", 1, 4],
      ["save", 2, 5],
    ],
  );
  assert.deepEqual(
    events.filter(([name]) => name === "restore"),
    [
      ["restore", "reader-2", 5],
      ["restore", "reader-1", 4],
    ],
  );
  assert.equal(
    events.findIndex(([name]) => name === "cleanup") <
      events.findIndex(([name]) => name === "close"),
    true,
  );
});

test("separating a same-PDF split persists the selected side only", async () => {
  const { lifecycle, events } = setup({ samePDF: true });
  await lifecycle.separate("split", "left");

  assert.deepEqual(
    events.filter(([name]) => name === "save"),
    [["save", 1, 4]],
  );
  assert.deepEqual(
    events.filter(([name]) => name === "restore"),
    [["restore", "reader-1", 4]],
  );
});

test("reader preparation failure leaves the split tab and state intact", async () => {
  const { lifecycle, events, state, states } = setup({
    prepare: async () => {
      throw new Error("reader failed to open");
    },
  });
  await lifecycle.revertToSingleReader("split", "left");

  assert.strictEqual(states.get("split"), state);
  assert.equal(state.isCleaningUp, false);
  assert.equal(
    events.some(([name]) => name === "cleanup"),
    false,
  );
  assert.equal(
    events.some(([name]) => name === "close"),
    false,
  );
  assert.ok(
    events.some(
      ([name, message]) =>
        name === "debug" && message.includes("reader failed to open"),
    ),
  );
});

test("a missing prepared reader tab prevents closing the split", async () => {
  const { lifecycle, events, state, states } = setup({
    findReusable: false,
  });
  await lifecycle.separate("split", "left");

  assert.strictEqual(states.get("split"), state);
  assert.equal(state.isCleaningUp, false);
  assert.equal(
    events.some(([name]) => name === "cleanup"),
    false,
  );
  assert.equal(
    events.some(([name]) => name === "close"),
    false,
  );
  assert.ok(
    events.some(
      ([name, message]) =>
        name === "debug" && message.includes("was not prepared"),
    ),
  );
});
