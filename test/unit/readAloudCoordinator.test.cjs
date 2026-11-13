const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function createState(overrides = {}) {
  return {
    tabID: "split-1",
    leftBrowser: { name: "left" },
    rightBrowser: { name: "right" },
    leftItemID: 11,
    rightItemID: 22,
    activeSide: "left",
    readAloudSide: null,
    readAloudStatuses: { left: null, right: null },
    isCleaningUp: false,
    ...overrides,
  };
}

function createCoordinator(states) {
  const readers = new Map();
  const audioStatuses = [];
  let pausedNativeReaders = 0;
  const { SplitReadAloudCoordinator } = load(
    "src/modules/splitView/readAloudCoordinator.ts",
    { Zotero: { debug: () => {} } },
  );
  const coordinator = new SplitReadAloudCoordinator({
    states: () => states,
    getState: (id) => states.find((state) => state.tabID === id),
    getReader: (browser) => readers.get(browser),
    setAudioStatus: (tabID, status) => audioStatuses.push({ tabID, status }),
    pauseOtherReaders: () => pausedNativeReaders++,
  });
  return {
    coordinator,
    readers,
    audioStatuses,
    get pausedNativeReaders() {
      return pausedNativeReaders;
    },
  };
}

test("playing on one side updates tab status and pauses competing readers", () => {
  const state = createState();
  const harness = createCoordinator([state]);
  const { coordinator, readers, audioStatuses } = harness;
  const pauses = [];
  readers.set(state.leftBrowser, {
    toggleReadAloudPaused: (...args) => pauses.push(args),
  });
  readers.set(state.rightBrowser, {
    toggleReadAloudPaused: (...args) => pauses.push(args),
  });
  const status = { active: true, paused: false, lang: "en" };

  coordinator.handleStatus(state.tabID, state.leftBrowser, status);

  assert.equal(state.readAloudSide, "left");
  assert.equal(state.readAloudStatuses.left, status);
  assert.equal(state.leftBrowser.docShellIsActive, true);
  assert.deepEqual(pauses, [[true]]);
  assert.equal(audioStatuses[0].status, status);
  assert.equal(harness.pausedNativeReaders, 1);
});

test("same attachment sides remain distinguishable by browser, not item id", () => {
  const state = createState({ rightItemID: 11 });
  const { coordinator } = createCoordinator([state]);

  assert.equal(coordinator.getReaderSide(state.tabID, { itemID: 11 }), null);
  assert.equal(
    coordinator.getReaderSideByBrowser(state.tabID, state.leftBrowser),
    "left",
  );
  assert.equal(
    coordinator.getReaderSideByBrowser(state.tabID, state.rightBrowser),
    "right",
  );
});

test("clearing the selected side promotes the other active side", () => {
  const left = { active: true, paused: false, lang: "en" };
  const right = { active: true, paused: true, lang: "fr" };
  const state = createState({
    readAloudSide: "left",
    readAloudStatuses: { left, right },
  });
  const { coordinator, audioStatuses } = createCoordinator([state]);

  coordinator.clearSide(state, "left");

  assert.equal(state.readAloudSide, "right");
  assert.equal(state.readAloudStatuses.left, null);
  assert.equal(audioStatuses[0].status, right);
});

test("position persistence follows only the actively speaking side", () => {
  const state = createState({
    readAloudSide: "right",
    readAloudStatuses: {
      left: { active: true, paused: false },
      right: { active: true, paused: true },
    },
  });
  const { coordinator } = createCoordinator([state]);

  assert.equal(
    coordinator.shouldSyncLastPosition(state, state.rightBrowser, {
      lastReadAloudPosition: 3,
    }),
    false,
  );
  state.readAloudSide = "left";
  assert.equal(
    coordinator.shouldSyncLastPosition(state, state.leftBrowser, {
      lastReadAloudPosition: 3,
    }),
    true,
  );
});

test("audio toggle targets the playing side and ignores cleaning tabs", () => {
  const state = createState({
    readAloudSide: "right",
    readAloudStatuses: {
      left: { active: true, paused: false },
      right: null,
    },
  });
  const { coordinator, readers } = createCoordinator([state]);
  const toggles = [];
  readers.set(state.leftBrowser, {
    toggleReadAloudPaused: () => toggles.push("left"),
  });
  readers.set(state.rightBrowser, {
    toggleReadAloudPaused: () => toggles.push("right"),
  });

  coordinator.toggleActive(state.tabID);
  state.isCleaningUp = true;
  coordinator.toggleActive(state.tabID);

  assert.deepEqual(toggles, ["left"]);
});
