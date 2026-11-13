const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { SplitViewContextPane } = load("src/modules/splitView/contextPane.ts");

function setup() {
  const events = [];
  let state = { rightBrowser: { id: "right" } };
  const trackedCallbacks = [];
  let mainPaneOpen = false;
  const win = {};
  const contextPane = new SplitViewContextPane({
    getState: () => state,
    getMainWindow: () => win,
    showForSplitView: (target) => events.push(["show", target]),
    toggleMainPane: (target) => {
      events.push(["toggle", target]);
      return true;
    },
    isMainPaneOpen: () => mainPaneOpen,
    setReaderOpen: (...args) => events.push(["reader-open", ...args]),
    trackTimeout: (trackedState, callback, delay) => {
      events.push(["tracked-timeout", trackedState, delay]);
      trackedCallbacks.push(callback);
      return trackedCallbacks.length;
    },
  });

  return {
    contextPane,
    events,
    runTracked: (index = 0) => trackedCallbacks[index](),
    setMainPaneOpen: (value) => (mainPaneOpen = value),
    setState: (value) => (state = value),
    state,
    win,
  };
}

test("shows the pane immediately and schedules a tracked follow-up", () => {
  const fixture = setup();

  fixture.contextPane.setupForCreatedTab("split", fixture.win);

  assert.deepEqual(fixture.events, [
    ["show", fixture.win],
    ["tracked-timeout", fixture.state, 300],
  ]);
  fixture.runTracked();
  assert.deepEqual(fixture.events[2], ["show", fixture.win]);
});

test("toggles the pane and applies its settled state to the right reader", () => {
  const fixture = setup();

  fixture.contextPane.toggleForReader("split");

  assert.deepEqual(fixture.events, [
    ["toggle", fixture.win],
    ["tracked-timeout", fixture.state, 50],
  ]);
  fixture.setMainPaneOpen(true);
  fixture.runTracked();

  assert.deepEqual(fixture.events[2], [
    "reader-open",
    fixture.state.rightBrowser,
    true,
  ]);
});

test("skips pane setup for missing state and skips toggle sync after closure", () => {
  const fixture = setup();
  fixture.setState(undefined);
  fixture.contextPane.setupForCreatedTab("missing", fixture.win);
  assert.deepEqual(fixture.events, []);

  fixture.setState({ rightBrowser: { id: "right" } });
  fixture.contextPane.toggleForReader("split");
  fixture.setState(undefined);
  fixture.runTracked();
  assert.deepEqual(
    fixture.events.map(([name]) => name),
    ["toggle", "tracked-timeout"],
  );
});

test("does not apply a pending toggle to a replacement state with the same ID", () => {
  const fixture = setup();
  fixture.contextPane.toggleForReader("split");
  fixture.setState({ rightBrowser: { id: "replacement" } });

  fixture.setMainPaneOpen(true);
  fixture.runTracked();

  assert.deepEqual(
    fixture.events.map(([name]) => name),
    ["toggle", "tracked-timeout"],
  );
});
