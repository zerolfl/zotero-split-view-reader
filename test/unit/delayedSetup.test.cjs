const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { SplitViewDelayedSetup } = load("src/modules/splitView/delayedSetup.ts");

function setup(primarySide = "left") {
  const events = [];
  let state = { primarySide };
  let callback;
  let timeout;
  const delayed = new SplitViewDelayedSetup({
    getState: () => state,
    trackTimeout: (trackedState, fn, delay) => {
      events.push(["timeout", trackedState, delay]);
      callback = fn;
      timeout = delay;
      return 42;
    },
    setupResizeListener: (...args) => events.push(["resize", ...args]),
    setupCtrlKeyListener: (...args) => events.push(["ctrl", ...args]),
    setupMainWindowKeyboardListener: (...args) =>
      events.push(["keyboard", ...args]),
    setupZoomButtonListeners: (...args) => events.push(["zoom", ...args]),
    setupContextPaneObserver: (...args) => events.push(["context", ...args]),
    cacheViewerContainers: (...args) => events.push(["cache", ...args]),
    initSyncState: (...args) => events.push(["sync-state", ...args]),
    startSyncPolling: (...args) => events.push(["sync-poll", ...args]),
    updateScrollbar: (...args) => events.push(["scrollbar", ...args]),
  });
  const win = {};
  const left = { side: "left" };
  const right = { side: "right" };

  return {
    callback: () => callback,
    delayed,
    events,
    left,
    right,
    setState: (value) => (state = value),
    state,
    timeout: () => timeout,
    win,
  };
}

test("schedules tracked setup and starts sync only for a primary side", () => {
  const fixture = setup();

  fixture.delayed.schedule(
    "tab-1",
    fixture.state,
    fixture.win,
    fixture.left,
    fixture.right,
  );

  assert.deepEqual(fixture.events, [["timeout", fixture.state, 500]]);
  assert.equal(fixture.timeout(), 500);
  fixture.callback()();

  assert.deepEqual(
    fixture.events.slice(1).map(([name]) => name),
    [
      "resize",
      "ctrl",
      "ctrl",
      "keyboard",
      "zoom",
      "zoom",
      "context",
      "cache",
      "sync-state",
      "sync-poll",
      "scrollbar",
    ],
  );
  assert.deepEqual(fixture.events[2], ["ctrl", "tab-1", fixture.left]);
  assert.deepEqual(fixture.events[3], ["ctrl", "tab-1", fixture.right]);
});

test("updates interactions without starting sync when no primary side exists", () => {
  const fixture = setup(null);
  fixture.delayed.schedule(
    "tab-2",
    fixture.state,
    fixture.win,
    fixture.left,
    fixture.right,
  );

  fixture.callback()();

  assert.deepEqual(
    fixture.events.map(([name]) => name),
    [
      "timeout",
      "resize",
      "ctrl",
      "ctrl",
      "keyboard",
      "zoom",
      "zoom",
      "context",
      "scrollbar",
    ],
  );
});

test("skips delayed setup after its tab state has been removed", () => {
  const fixture = setup();
  fixture.delayed.schedule(
    "closed-tab",
    fixture.state,
    fixture.win,
    fixture.left,
    fixture.right,
  );
  fixture.setState(undefined);

  fixture.callback()();

  assert.deepEqual(
    fixture.events.map(([name]) => name),
    ["timeout"],
  );
});

test("restarts sync after rechecking the current primary side", () => {
  const fixture = setup("right");

  fixture.delayed.restartSync("tab-3", fixture.state);
  fixture.callback()();

  assert.deepEqual(fixture.events, [
    ["timeout", fixture.state, 500],
    ["cache", "tab-3"],
    ["sync-state", "tab-3"],
    ["sync-poll", "tab-3"],
  ]);
});

test("skips sync restart when the tab is closed or has no primary side", () => {
  const closed = setup();
  closed.delayed.restartSync("closed-tab", closed.state);
  closed.setState(undefined);
  closed.callback()();

  const independent = setup(null);
  independent.delayed.restartSync("independent-tab", independent.state);
  independent.callback()();

  assert.deepEqual(
    closed.events.map(([name]) => name),
    ["timeout"],
  );
  assert.deepEqual(
    independent.events.map(([name]) => name),
    ["timeout"],
  );
});
