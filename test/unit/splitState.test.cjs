const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { createSplitTabState } = load("src/modules/splitView/state.ts");

function options(overrides = {}) {
  return {
    tabID: "split-tab",
    container: {},
    leftBrowser: {},
    rightBrowser: {},
    leftPopupset: {},
    rightPopupset: {},
    leftItemID: 1,
    rightItemID: 2,
    leftParentItemID: 11,
    rightParentItemID: 22,
    primarySide: "left",
    leftViewState: { pageIndex: 3 },
    rightViewState: { pageIndex: 7 },
    eventListeners: [{ type: "click" }],
    originalTitle: "Original title",
    isSamePDF: false,
    ...overrides,
  };
}

test("creates a split tab state with isolated interaction and cleanup defaults", () => {
  const input = options();
  const state = createSplitTabState(input);

  assert.equal(state.tabID, input.tabID);
  assert.equal(state.leftBrowser, input.leftBrowser);
  assert.equal(state.leftViewState, input.leftViewState);
  assert.equal(state.rightViewState, input.rightViewState);
  assert.equal(state.eventListeners, input.eventListeners);
  assert.equal(state.primarySide, "left");
  assert.equal(state.activeSide, "left");
  assert.equal(state.isSamePDF, false);
  assert.equal(state.splitRatio, 0.5);
  assert.equal(state.isCleaningUp, false);
  assert.equal(state.resizeTimerId, null);
  assert.equal(state.readAloudStatuses.left, null);
  assert.equal(state.readAloudStatuses.right, null);
  assert.equal(state.sidebarToggleTimers.length, 0);
  assert.equal(state.timeoutIds.length, 0);
  assert.equal(state.toolbarCloseObservers.length, 0);
  assert.equal(state.scrollHandler, null);
  assert.equal(state.scrollHandlerBrowser, null);
  assert.equal(state.contextPaneObserver, null);
});

test("creates independent defaults for same-PDF and no-primary states", () => {
  const first = createSplitTabState(
    options({ primarySide: null, isSamePDF: true, rightItemID: 1 }),
  );
  const second = createSplitTabState(options());

  assert.equal(first.primarySide, null);
  assert.equal(first.isSamePDF, true);
  assert.equal(first.rightItemID, 1);
  first.sidebarToggleTimers.push(10);
  first.timeoutIds.push(20);
  assert.equal(second.sidebarToggleTimers.length, 0);
  assert.equal(second.timeoutIds.length, 0);
});
