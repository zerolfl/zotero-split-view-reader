const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function setup({ samePDF = false, primarySide = "left" } = {}) {
  const events = [];
  const state = {
    tabID: "split",
    leftItemID: 1,
    rightItemID: samePDF ? 1 : 2,
    leftParentItemID: 10,
    rightParentItemID: samePDF ? 10 : 20,
    leftBrowser: { side: "left", pageIndex: 4 },
    rightBrowser: { side: "right", pageIndex: 7 },
    leftPopupset: "left-popup",
    rightPopupset: "right-popup",
    primarySide,
    activeSide: "right",
    isSamePDF: samePDF,
    isCleaningUp: false,
  };
  const items = new Map([
    [1, { id: 1 }],
    [2, { id: 2 }],
  ]);
  const { PDFSwapService } = load("src/modules/splitView/pdfSwap.ts", {});
  const service = new PDFSwapService({
    getState: () => state,
    captureViewState: (browser) => ({ pageIndex: browser.pageIndex }),
    replaceBrowser: async (_id, side) => {
      const browser = { side };
      state[`${side}Browser`] = browser;
      events.push(["replace", side]);
      return browser;
    },
    getItem: (id) => items.get(id),
    getMainWindow: () => "main-window",
    initializeReader: async (...args) => events.push(["initialize", ...args]),
    setupFocusListeners: (...args) => events.push(["focus", ...args]),
    setupCtrlKeyListener: (...args) => events.push(["ctrl", ...args]),
    setupZoomButtonListeners: (...args) => events.push(["zoom", ...args]),
    stopSyncPolling: (id) => events.push(["stop-sync", id]),
    updateScrollbarColors: (id) => events.push(["scrollbar", id]),
    updateContextPane: (...args) => events.push(["context", ...args]),
    bindAnnotations: () => events.push(["annotations"]),
    updateSession: (id) => events.push(["session", id]),
    renameTab: async (id) => events.push(["rename", id]),
    scheduleSyncRestart: (id) => events.push(["restart-sync", id]),
    showSwapped: () => events.push(["success"]),
    debug: (message) => events.push(["debug", message]),
  });
  return { service, state, events };
}

test("swaps items, parent IDs, and captured positions while retaining pane settings", async () => {
  const { service, state, events } = setup();
  await service.swap("split");

  assert.deepEqual([state.leftItemID, state.rightItemID], [2, 1]);
  assert.deepEqual([state.leftParentItemID, state.rightParentItemID], [20, 10]);
  assert.deepEqual(
    [state.leftViewState.pageIndex, state.rightViewState.pageIndex],
    [7, 4],
  );
  assert.equal(state.primarySide, "left");
  assert.equal(state.activeSide, "right");
  assert.deepEqual(
    events
      .filter(([name]) => name === "initialize")
      .map((event) => [
        event[2].side,
        event[3].id,
        event[5].pageIndex,
        event[6],
      ]),
    [
      ["left", 2, 7, false],
      ["right", 1, 4, true],
    ],
  );
  assert.ok(events.some(([name]) => name === "restart-sync"));
  assert.ok(events.some(([name]) => name === "success"));
});

test("same-PDF swaps rebind annotations and skip primary sync work when disabled", async () => {
  const { service, events } = setup({ samePDF: true, primarySide: null });
  await service.swap("split");

  assert.ok(events.some(([name]) => name === "annotations"));
  assert.equal(
    events.some(([name]) => name === "stop-sync"),
    false,
  );
  assert.equal(
    events.some(([name]) => name === "restart-sync"),
    false,
  );
});

test("swap ignores missing or cleaning-up tabs", async () => {
  const { service, state, events } = setup();
  state.isCleaningUp = true;
  await service.swap("split");
  assert.deepEqual(events, []);
});
