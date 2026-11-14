const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function container(top = 0, left = 0) {
  const listeners = new Map();
  return {
    scrollTop: top,
    scrollLeft: left,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    scrollTo(x, y) {
      this.scrollLeft = x;
      this.scrollTop = y;
    },
    emit(type) {
      listeners.get(type)?.();
    },
    hasListener(type) {
      return listeners.has(type);
    },
  };
}

function setup() {
  const frameCallbacks = [];
  const timeouts = [];
  const sidebarTimeouts = [];
  const clearedSidebarTimeouts = [];
  const notifications = [];
  const leftContainer = container(100, 20);
  const rightContainer = container(30, 5);
  const zoomButton = {
    listeners: [],
    addEventListener(_type, listener) {
      this.listeners.push(listener);
    },
    click() {
      for (const listener of this.listeners) listener();
    },
    getAttribute() {
      return "";
    },
  };
  const makeBrowser = (viewState = null) => ({
    container: null,
    viewState,
    reader: {},
    contentWindow: {
      document: {
        querySelector: (selector) =>
          selector === "#zoomIn" ? zoomButton : null,
        querySelectorAll: () => [],
      },
    },
  });
  const leftBrowser = makeBrowser({ pageIndex: 4, scale: 125 });
  const rightBrowser = makeBrowser({ pageIndex: 1, scale: 100 });
  leftBrowser.container = leftContainer;
  rightBrowser.container = rightContainer;
  const state = {
    isCleaningUp: false,
    primarySide: "left",
    leftBrowser,
    rightBrowser,
    leftViewerContainer: leftContainer,
    rightViewerContainer: rightContainer,
    lastPrimaryScroll: null,
    syncPaused: false,
    ctrlPressed: false,
    zoomingCount: 0,
    sidebarToggleTimers: [],
    scrollHandler: null,
    scrollHandlerBrowser: null,
    scrollSyncRAFPending: false,
    lastScrollSyncTime: 0,
    eventListeners: [],
    timeoutIds: [],
    leftViewState: null,
    rightViewState: null,
  };
  const readerView = {
    getViewerContainerFromBrowser: (browser) => browser.container,
    getImmediateViewStateFromBrowser: (browser) => browser.viewState,
    getCurrentViewStateFromBrowser: () => null,
    applyViewStateToReader: async (reader, viewState) => {
      reader.applied = viewState;
      return { pageIndexClamped: false };
    },
  };
  const readerRuntime = {
    isBrowserAlive: () => true,
    getInternalReaderFromBrowser: (browser) => browser.reader,
    setSidebarOpen: (browser, open) => browser.reader.toggleSidebar?.(open),
  };
  const { SplitSync } = load(
    "src/modules/splitView/sync.ts",
    {
      Zotero: { debug() {} },
    },
    {
      "../../platform/readerView": { readerView },
      "../../platform/readerRuntime": { readerRuntime },
      "../../platform/readerToolbar": {
        findReaderZoomButton: (_browser, direction) =>
          direction === "in" ? zoomButton : null,
      },
    },
  );
  const sync = new SplitSync({
    getState: (id) => (id === "tab" ? state : undefined),
    getEffectivePrimarySide: (current) => current.primarySide,
    getMainWindow: () => ({
      requestAnimationFrame: (callback) => frameCallbacks.push(callback),
      setTimeout: (callback, delay) => {
        sidebarTimeouts.push({ callback, delay });
        return 100 + sidebarTimeouts.length;
      },
      clearTimeout: (id) => clearedSidebarTimeouts.push(id),
    }),
    trackEventListener: (current, target, type, listener, options) => {
      target.addEventListener(type, listener, options);
      current.eventListeners.push({ target, type, listener, options });
    },
    trackTimeout: (current, callback, delay) => {
      timeouts.push({ callback, delay });
      current.timeoutIds.push(timeouts.length);
      return timeouts.length;
    },
    onPositionSynced: (...args) => notifications.push(args),
  });
  return {
    sync,
    state,
    leftContainer,
    rightContainer,
    leftBrowser,
    rightBrowser,
    frameCallbacks,
    timeouts,
    sidebarTimeouts,
    clearedSidebarTimeouts,
    notifications,
    zoomButton,
  };
}

test("scroll synchronization applies primary deltas and removes its listener", () => {
  const rt = setup();
  rt.sync.initSyncState("tab");
  rt.sync.startSyncPolling("tab");
  rt.leftContainer.scrollTop = 125;
  rt.leftContainer.scrollLeft = 40;
  rt.leftContainer.emit("scroll");
  rt.frameCallbacks[0]();
  assert.equal(rt.rightContainer.scrollTop, 55);
  assert.equal(rt.rightContainer.scrollLeft, 25);
  rt.sync.stopSyncPolling("tab");
  assert.equal(rt.leftContainer.hasListener("scroll"), false);
  assert.equal(rt.state.scrollHandler, null);
});

test("no primary view keeps both panes independent", () => {
  const rt = setup();
  rt.state.primarySide = null;
  rt.state.lastPrimaryScroll = { top: 2, left: 3 };
  rt.sync.initSyncState("tab");
  rt.sync.startSyncPolling("tab");
  assert.equal(rt.state.lastPrimaryScroll, null);
  assert.equal(rt.leftContainer.hasListener("scroll"), false);
  rt.leftContainer.scrollTop = 150;
  rt.sync.syncViews("tab");
  assert.equal(rt.rightContainer.scrollTop, 30);
});

test("sidebar changes mirror from primary, debounce and resume scroll sync", () => {
  const rt = setup();
  let sidebarOpen = null;
  rt.rightBrowser.reader.toggleSidebar = (open) => (sidebarOpen = open);
  rt.state.sidebarToggleTimers = [9];
  rt.sync.handleSidebarToggle("tab", rt.leftBrowser, true);
  assert.equal(sidebarOpen, true);
  assert.deepEqual(rt.clearedSidebarTimeouts, [9]);
  assert.equal(rt.state.syncPaused, true);
  assert.equal(rt.state.sidebarToggleTimers.length, 1);
  assert.equal(rt.state.sidebarToggleTimers[0], 101);
  assert.equal(rt.sidebarTimeouts[0].delay, 200);

  rt.sync.handleSidebarToggle("tab", rt.rightBrowser, false);
  assert.equal(sidebarOpen, true);
  assert.equal(rt.sidebarTimeouts.length, 1);

  rt.sidebarTimeouts[0].callback();
  assert.equal(rt.state.syncPaused, false);
  assert.equal(rt.state.sidebarToggleTimers.length, 0);
  assert.equal(rt.state.lastPrimaryScroll.top, 100);
});

test("toolbar and keyboard zoom sync to the secondary and reset the baseline", () => {
  const rt = setup();
  let zoomIn = 0;
  let zoomOut = 0;
  rt.rightBrowser.reader.zoomIn = () => zoomIn++;
  rt.rightBrowser.reader.zoomOut = () => zoomOut++;
  rt.sync.setupZoomButtonListeners("tab", rt.leftBrowser);
  rt.zoomButton.click();
  assert.equal(zoomIn, 1);
  assert.equal(rt.state.zoomingCount, 1);
  assert.equal(rt.timeouts[0].delay, 150);
  rt.sync.handleKeyboardZoom("tab", true, "out");
  assert.equal(zoomOut, 1);
  assert.equal(rt.state.zoomingCount, 2);
  rt.timeouts[0].callback();
  assert.equal(rt.state.zoomingCount, 1);
  rt.timeouts[1].callback();
  assert.equal(rt.state.zoomingCount, 0);
  assert.equal(rt.state.lastPrimaryScroll.top, 100);
  assert.equal(rt.state.lastPrimaryScroll.left, 20);
  rt.state.ctrlPressed = true;
  rt.zoomButton.click();
  assert.equal(zoomIn, 1);
  rt.leftContainer.scrollTop = 500;
  rt.sync.syncViews("tab");
  assert.equal(rt.rightContainer.scrollTop, 30);
  rt.state.ctrlPressed = false;
  rt.sync.initSyncState("tab");
  rt.leftContainer.scrollTop = 505;
  rt.sync.syncViews("tab");
  assert.equal(rt.rightContainer.scrollTop, 35);
});

test("manual alignment copies the opposite view and resumes scroll sync", async () => {
  const rt = setup();
  await rt.sync.syncPositionAndScale("tab", "left");
  assert.deepEqual(rt.leftBrowser.reader.applied, {
    pageIndex: 1,
    scale: 100,
  });
  assert.equal(rt.notifications.length, 1);
  assert.equal(rt.state.syncPaused, true);
  assert.equal(rt.timeouts[0].delay, 400);
  rt.timeouts[0].callback();
  assert.equal(rt.state.syncPaused, false);
  assert.equal(rt.state.lastPrimaryScroll.top, 100);
  assert.equal(rt.state.lastPrimaryScroll.left, 20);
});
