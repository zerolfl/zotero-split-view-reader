const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { SplitPrimaryView } = load("src/modules/splitView/primaryView.ts");

function setup() {
  const events = [];
  const state = {
    primarySide: "left",
    lastPrimaryScroll: { top: 25, left: 0 },
    isCleaningUp: false,
  };
  const service = new SplitPrimaryView({
    getState: (tabID) => (tabID === "split" ? state : null),
    stopSyncPolling: (tabID) => events.push(["stop", tabID]),
    updateScrollbarColors: (tabID) => events.push(["scrollbar", tabID]),
    initSyncState: (tabID) => events.push(["init", tabID]),
    startSyncPolling: (tabID) => events.push(["start", tabID]),
    updateSession: (tabID) => events.push(["session", tabID]),
  });
  return { events, service, state };
}

test("reports primary menu state and default side", () => {
  const { service, state } = setup();

  assert.equal(service.getDefaultSide(), "left");
  assert.equal(service.getEffectiveSide(state), "left");
  const current = service.getMenuConfig(state, "left");
  assert.equal(current.menuState, "current");
  assert.equal(current.disabled, false);
  assert.equal(current.isCurrentPrimary, true);
  assert.equal(current.targetPrimarySide, null);
  const other = service.getMenuConfig(state, "right");
  assert.equal(other.menuState, "other");
  assert.equal(other.disabled, false);
  assert.equal(other.isCurrentPrimary, false);
  assert.equal(other.targetPrimarySide, "right");

  state.primarySide = null;
  const none = service.getMenuConfig(state, null);
  assert.equal(none.menuState, "none");
  assert.equal(none.disabled, false);
  assert.equal(none.isCurrentPrimary, false);
  assert.equal(none.targetPrimarySide, null);
});

test("switching the primary side restarts sync and persists the change", () => {
  const { events, service, state } = setup();

  service.setSide("split", "right");

  assert.equal(state.primarySide, "right");
  assert.equal(state.lastPrimaryScroll, null);
  assert.deepEqual(
    events.map(([name]) => name),
    ["stop", "scrollbar", "init", "start", "session"],
  );
});

test("clearing the primary disables sync and ignores missing or closing tabs", () => {
  const { events, service, state } = setup();

  service.setSide("split", null);
  assert.equal(state.primarySide, null);
  assert.deepEqual(
    events.map(([name]) => name),
    ["stop", "scrollbar", "session"],
  );

  events.length = 0;
  service.setSide("missing", "left");
  state.isCleaningUp = true;
  service.setSide("split", "left");
  assert.deepEqual(events, []);
});
