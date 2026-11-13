const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function setup({ selectedPDF, initializeReader, active = true } = {}) {
  const events = [];
  const state = {
    leftItemID: 1,
    rightItemID: 2,
    leftParentItemID: 10,
    rightParentItemID: 20,
    leftBrowser: { side: "left" },
    rightBrowser: { side: "right" },
    leftPopupset: "left-popup",
    rightPopupset: "right-popup",
    primarySide: active ? "left" : null,
    isSamePDF: false,
    isCleaningUp: false,
  };
  const items = new Map([
    [1, { id: 1, libraryID: 5 }],
    [2, { id: 2, libraryID: 6 }],
  ]);
  const { PDFReplacementService } = load(
    "src/modules/splitView/pdfReplacement.ts",
    {},
  );
  const service = new PDFReplacementService({
    getState: () => state,
    getItem: (id) => items.get(id),
    selectPDF: async (libraryID) => {
      events.push(["select", libraryID]);
      return selectedPDF;
    },
    getStoredViewState: async (item) => {
      events.push(["stored", item.id]);
      return { pageIndex: 3 };
    },
    replaceBrowser: async (_id, side) => {
      const browser = { side, fresh: true };
      state[`${side}Browser`] = browser;
      events.push(["replace", side]);
      return browser;
    },
    getMainWindow: () => "window",
    initializeReader: async (...args) => {
      events.push(["initialize", ...args]);
      if (initializeReader) await initializeReader(...args);
    },
    setupBrowserFocusListeners: (...args) => events.push(["focus", ...args]),
    setupCtrlKeyListener: (...args) => events.push(["ctrl", ...args]),
    setupZoomButtonListeners: (...args) => events.push(["zoom", ...args]),
    stopSyncPolling: (id) => events.push(["stop", id]),
    updateScrollbarColors: (id) => events.push(["scrollbar", id]),
    bindAnnotations: () => events.push(["annotations"]),
    updateSession: (id) => events.push(["session", id]),
    renameTab: async (id) => events.push(["rename", id]),
    scheduleSyncRestart: (id) => events.push(["restart", id]),
    showLoaded: () => events.push(["loaded"]),
    showFailure: () => events.push(["failure"]),
    debug: (message) => events.push(["debug", message]),
  });
  return { service, state, events };
}

test("replaces the requested side, restores its position and keeps pane control", async () => {
  const selectedPDF = { id: 3, parentItemID: 30 };
  const { service, state, events } = setup({ selectedPDF });
  await service.selectAndLoad("split", "right");

  assert.deepEqual(
    [state.rightItemID, state.rightParentItemID, state.leftItemID],
    [3, 30, 1],
  );
  assert.equal(state.isSamePDF, false);
  assert.equal(state.primarySide, "left");
  assert.equal(events.find(([name]) => name === "select")[1], 6);
  const init = events.find(([name]) => name === "initialize");
  assert.equal(init[2].side, "right");
  assert.equal(init[3], selectedPDF);
  assert.equal(init[4], "right-popup");
  assert.deepEqual(init[5], { pageIndex: 3 });
  assert.equal(init[6], true);
  assert.ok(events.some(([name]) => name === "restart"));
  assert.ok(events.some(([name]) => name === "loaded"));
});

test("selecting the current PDF reports success without rebuilding the reader", async () => {
  const { service, events } = setup({ selectedPDF: { id: 1 } });
  await service.selectAndLoad("split", "left");

  assert.deepEqual(
    events.map(([name]) => name),
    ["select", "loaded"],
  );
});

test("cancelling selection leaves the split state and readers untouched", async () => {
  const { service, state, events } = setup();
  await service.selectAndLoad("split", "right");

  assert.equal(state.rightItemID, 2);
  assert.deepEqual(
    events.map(([name]) => name),
    ["select"],
  );
});

test("reader initialization failure reports an error and does not update item data", async () => {
  const { service, state, events } = setup({
    selectedPDF: { id: 3 },
    initializeReader: async () => {
      throw new Error("reader initialization failed");
    },
  });
  await service.selectAndLoad("split", "left");

  assert.equal(state.leftItemID, 1);
  assert.ok(events.some(([name]) => name === "failure"));
  assert.ok(
    events.some(
      ([name, message]) =>
        name === "debug" && message.includes("reader initialization failed"),
    ),
  );
});
