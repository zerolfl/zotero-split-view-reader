const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener, options) {
      listeners.set(type, { listener, options });
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    dispatch(type, event = {}) {
      listeners.get(type)?.listener(event);
    },
    listener(type) {
      return listeners.get(type);
    },
  };
}

function setup() {
  const syncCalls = [];
  const paneCalls = [];
  const timeouts = [];
  const clearedTimeouts = [];
  const leftDocument = eventTarget();
  const readerDocument = eventTarget();
  const iframeWindow = Object.assign(eventTarget(), {
    document: leftDocument,
  });
  const observer = { id: "new observer" };
  let observerCallback;
  const leftBrowser = Object.assign(eventTarget(), {
    contains: (element) => element === leftBrowser.child,
    child: {},
    reader: {
      _primaryView: {
        _iframe: {
          contentWindow: {
            document: leftDocument,
            wrappedJSObject: iframeWindow,
          },
        },
      },
    },
    contentWindow: {
      document: readerDocument,
      wrappedJSObject: { document: readerDocument },
    },
  });
  const rightBrowser = Object.assign(eventTarget(), {
    contains: (element) => element === rightBrowser.child,
    child: {},
  });
  const state = {
    activeSide: "left",
    primarySide: "left",
    leftBrowser,
    rightBrowser,
    leftParentItemID: 10,
    rightParentItemID: 20,
    ctrlPressed: false,
    syncPaused: false,
    resizeTimerId: null,
    contextPaneObserver: { id: "old observer" },
    isCleaningUp: false,
    eventListeners: [],
  };
  const win = Object.assign(eventTarget(), {
    document: { activeElement: null },
    setTimeout(callback, delay) {
      timeouts.push({ callback, delay });
      return timeouts.length;
    },
    clearTimeout(id) {
      clearedTimeouts.push(id);
    },
  });
  const { SplitInteractions } = load(
    "src/modules/splitView/interactions.ts",
    {
      Zotero: { debug() {} },
    },
    {
      "../../platform/readerRuntime": {
        readerRuntime: {
          getInternalReaderFromBrowser: (browser) => browser.reader,
        },
      },
      "../../platform/contextPane": {
        contextPane: {
          disconnectObserver: (value) => paneCalls.push(["disconnect", value]),
          observeCollapsed: (_win, callback) => {
            observerCallback = callback;
            return observer;
          },
          setReaderOpen: (...args) => paneCalls.push(["open", ...args]),
          updateItem: (...args) => paneCalls.push(["item", ...args]),
        },
      },
      "../../utils/prefs": {
        getPref: () => rt.followFocusPrimary,
      },
    },
  );
  const rt = {
    followFocusPrimary: false,
    state,
    win,
    leftDocument,
    readerDocument,
    iframeWindow,
    rightBrowser,
    syncCalls,
    paneCalls,
    timeouts,
    clearedTimeouts,
    observer: () => observerCallback,
  };
  rt.interactions = new SplitInteractions({
    getState: (id) => (id === "tab" ? state : undefined),
    getEffectivePrimarySide: (current) => current.primarySide,
    sync: {
      initSyncState: (...args) => syncCalls.push(["init", ...args]),
      startSyncPolling: (...args) => syncCalls.push(["start", ...args]),
      stopSyncPolling: (...args) => syncCalls.push(["stop", ...args]),
      handleKeyboardZoom: (...args) => syncCalls.push(["zoom", ...args]),
    },
    trackEventListener(current, target, type, listener, options) {
      target.addEventListener(type, listener, options);
      current.eventListeners.push({ target, type, listener, options });
    },
    updateScrollbarColors: (...args) => paneCalls.push(["scrollbar", ...args]),
  });
  return rt;
}

test("Ctrl key state resets on keyup and PDF iframe blur", () => {
  const rt = setup();
  rt.interactions.setupCtrlKeyListener("tab", rt.state.leftBrowser);

  rt.leftDocument.dispatch("keydown", { key: "Control" });
  assert.equal(rt.state.ctrlPressed, true);
  rt.leftDocument.dispatch("keyup", { key: "Control" });
  assert.equal(rt.state.ctrlPressed, false);
  rt.readerDocument.dispatch("keydown", { key: "Control" });
  assert.equal(rt.state.ctrlPressed, true);
  rt.iframeWindow.dispatch("blur");
  assert.equal(rt.state.ctrlPressed, false);
  assert.equal(rt.syncCalls.filter(([name]) => name === "init").length, 2);
  assert.equal(rt.state.eventListeners.length, 4);
});

test("context pane observer replaces the old observer and mirrors collapse state", () => {
  const rt = setup();
  const oldObserver = rt.state.contextPaneObserver;
  rt.interactions.setupContextPaneObserver("tab", rt.win);

  assert.deepEqual(rt.paneCalls[0], ["disconnect", oldObserver]);
  assert.equal(rt.state.contextPaneObserver.id, "new observer");
  rt.observer()(false);
  assert.deepEqual(rt.paneCalls[1], ["open", rt.rightBrowser, false]);
});

test("focus activates the side and only follows focus when enabled", () => {
  const rt = setup();
  rt.interactions.setupBrowserFocusListeners(
    "tab",
    rt.rightBrowser,
    "right",
    rt.win,
  );
  rt.rightBrowser.dispatch("click");
  assert.equal(rt.timeouts[0].delay, 0);
  rt.timeouts[0].callback();
  assert.equal(rt.state.activeSide, "right");
  assert.deepEqual(rt.syncCalls, []);
  assert.deepEqual(rt.paneCalls.at(-1), ["item", "tab", rt.win, 20]);

  rt.followFocusPrimary = true;
  rt.interactions.activateSide("tab", "left", rt.win);
  assert.equal(rt.state.primarySide, "left");
  rt.interactions.activateSide("tab", "right", rt.win);
  assert.equal(rt.state.primarySide, "right");
  assert.deepEqual(
    rt.syncCalls.map(([name]) => name),
    ["stop", "init", "start"],
  );
});

test("keyboard zoom only forwards shortcuts from the effective primary side", () => {
  const rt = setup();
  rt.interactions.setupMainWindowKeyboardListener("tab", rt.win);
  rt.win.document.activeElement = rt.state.leftBrowser.child;
  rt.win.dispatch("keydown", {
    ctrlKey: true,
    altKey: false,
    metaKey: false,
    key: "+",
    code: "Equal",
  });
  rt.win.document.activeElement = rt.rightBrowser.child;
  rt.win.dispatch("keydown", {
    ctrlKey: true,
    altKey: false,
    metaKey: false,
    key: "-",
    code: "Minus",
  });
  rt.win.document.activeElement = null;
  rt.state.activeSide = "left";
  rt.win.dispatch("keydown", {
    ctrlKey: true,
    altKey: false,
    metaKey: false,
    key: "=",
    code: "Equal",
  });
  rt.win.dispatch("keydown", {
    ctrlKey: true,
    altKey: true,
    metaKey: false,
    key: "+",
    code: "Equal",
  });
  assert.deepEqual(rt.syncCalls, [
    ["zoom", "tab", true, "in"],
    ["zoom", "tab", true, "in"],
  ]);

  rt.state.primarySide = null;
  rt.win.dispatch("keydown", {
    ctrlKey: true,
    altKey: false,
    metaKey: false,
    key: "-",
    code: "Minus",
  });
  assert.equal(rt.syncCalls.length, 2);
});

test("resize debounce pauses sync and refreshes its baseline after settling", () => {
  const rt = setup();
  rt.interactions.setupResizeListener("tab", rt.win);
  rt.win.dispatch("resize");
  assert.equal(rt.state.syncPaused, true);
  assert.equal(rt.state.resizeTimerId, 1);
  rt.win.dispatch("resize");
  assert.deepEqual(rt.clearedTimeouts, [1]);
  assert.equal(rt.state.resizeTimerId, 2);
  assert.equal(rt.timeouts[1].delay, 200);
  rt.timeouts[1].callback();
  assert.equal(rt.state.syncPaused, false);
  assert.equal(rt.state.resizeTimerId, null);
  assert.deepEqual(rt.syncCalls, [["init", "tab"]]);
});
