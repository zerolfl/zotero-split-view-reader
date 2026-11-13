const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { SplitTabCleanup } = load("src/modules/splitView/tabCleanup.ts");

function setup({
  selectedTabID = "split",
  extraTab = false,
  failTimers = false,
} = {}) {
  const events = [];
  const state = {
    leftBrowser: "left-browser",
    rightBrowser: "right-browser",
    eventListeners: [],
    timeoutIds: [1, 2],
    toolbarCloseObservers: [],
    sidebarToggleTimers: [3],
    resizeTimerId: 4,
    contextPaneObserver: {
      disconnect: () => events.push(["context-observer"]),
    },
    dragOverlay: { parentNode: {}, remove: () => events.push(["overlay"]) },
    leftViewerContainer: {},
    rightViewerContainer: {},
    disposeAnnotations: () => events.push(["annotations"]),
    isCleaningUp: false,
  };
  const states = new Map([["split", state]]);
  if (extraTab) states.set("other", {});
  const win = {
    document: {
      documentElement: {
        classList: { remove: (name) => events.push(["class-remove", name]) },
      },
    },
    clearTimeout: (id) => {
      if (failTimers) throw new Error("timer failure");
      events.push(["timer", id]);
    },
  };
  const cleanup = new SplitTabCleanup({
    getState: (id) => states.get(id) || null,
    removeState: (id) => {
      events.push(["remove-state", id]);
      states.delete(id);
    },
    hasState: (id) => states.has(id),
    hasAnyState: () => states.size > 0,
    pauseReader: (browser) => events.push(["pause", browser]),
    setAudioStatus: (id) => events.push(["audio-off", id]),
    unloadBrowser: (browser) => events.push(["unload", browser]),
    stopSyncPolling: (id) => events.push(["stop-sync", id]),
    getMainWindow: () => win,
    getSelectedTabID: () => selectedTabID,
    disconnectContextPaneObserver: (observer) => observer?.disconnect(),
    unregisterTabNotifier: () => events.push(["unregister-notifier"]),
    debug: (message) => events.push(["debug", message]),
  });
  return { cleanup, events, state, states };
}

test("unloads readers before clearing tracked resources and stops sync first", () => {
  const fixture = setup();
  const listenerTarget = {
    removeEventListener: (...args) =>
      fixture.events.push(["listener", ...args]),
  };
  const observer = {
    disconnect: () => fixture.events.push(["toolbar-observer"]),
  };
  fixture.state.eventListeners.push({
    target: listenerTarget,
    type: "click",
    listener: () => {},
  });
  fixture.state.toolbarCloseObservers.push({ observer });

  fixture.cleanup.cleanup("split");

  const names = fixture.events.map(([name]) => name);
  assert.ok(names.indexOf("unload") < names.indexOf("stop-sync"));
  assert.ok(names.indexOf("stop-sync") < names.indexOf("remove-state"));
  assert.ok(names.includes("listener"));
  assert.ok(names.includes("toolbar-observer"));
  assert.ok(names.includes("context-observer"));
  assert.equal(fixture.state.eventListeners.length, 0);
  assert.equal(fixture.state.timeoutIds.length, 0);
  assert.equal(fixture.state.isCleaningUp, true);
  assert.ok(names.includes("unregister-notifier"));
});

test("keeps shared chrome and notifier while another split tab remains", () => {
  const fixture = setup({ selectedTabID: "other", extraTab: true });

  fixture.cleanup.cleanup("split");

  assert.ok(!fixture.events.some(([name]) => name === "class-remove"));
  assert.ok(!fixture.events.some(([name]) => name === "unregister-notifier"));
  assert.equal(fixture.states.has("other"), true);
});

test("continues cleanup when individual listener or timer releases fail", () => {
  const fixture = setup({ failTimers: true });
  fixture.state.eventListeners.push({
    target: {
      removeEventListener: () => {
        throw new Error("listener failure");
      },
    },
    type: "keydown",
    listener: () => {},
  });
  fixture.state.toolbarCloseObservers.push({
    observer: {
      disconnect: () => {
        throw new Error("observer failure");
      },
    },
  });
  fixture.state.dragOverlay = {
    parentNode: {},
    remove: () => {
      throw new Error("overlay failure");
    },
  };

  fixture.cleanup.cleanup("split");

  assert.equal(fixture.events.filter(([name]) => name === "debug").length, 7);
  assert.ok(fixture.events.some(([name]) => name === "unregister-notifier"));
});
