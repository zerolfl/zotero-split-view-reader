const assert = require("node:assert/strict");
const { test } = require("node:test");
const { setTimeout, clearTimeout } = require("node:timers");
const { load } = require("./helpers.cjs");

const { createSplitTabState } = load("src/modules/splitView/state.ts");
function setup({ failInitialization = false, timers, initialize } = {}) {
  const { SplitViewCreationService } = load(
    "src/modules/splitView/creation.ts",
    timers || { setTimeout, clearTimeout },
    { "./state": { createSplitTabState } },
  );
  const events = [];
  const win = {};
  const leftItem = { id: 1, parentItemID: 11 };
  const rightItem = { id: 2, parentItemID: 22 };
  const shell = {
    container: {},
    mainHbox: {},
    leftBrowser: { side: "left" },
    rightBrowser: { side: "right" },
    resizer: {},
    leftPopupset: {},
    rightPopupset: {},
    eventListeners: [],
  };
  let state;
  let delayedSetup;
  const service = new SplitViewCreationService({
    getDefaultPrimarySide: () => "left",
    getOriginalTitle: () => "Reader",
    setState: (tabID, value) => {
      state = value;
      events.push(["state", tabID]);
    },
    setupShell: (tabID, value, currentShell, currentWin) =>
      events.push(["shell", tabID, value, currentShell, currentWin]),
    initializeReader: async (
      tabID,
      browser,
      item,
      popupset,
      viewState,
      isRight,
    ) => {
      events.push([
        "reader",
        browser.side,
        item.id,
        popupset,
        viewState,
        isRight,
      ]);
      if (initialize) await initialize(isRight);
      if (failInitialization && isRight) throw new Error("reader failed");
    },
    showLoaded: (isSamePDF) => events.push(["loaded", isSamePDF]),
    updateContextPane: (...args) => events.push(["context", ...args]),
    setupFocusListeners: (...args) => events.push(["focus", ...args]),
    bindAnnotations: (value) => events.push(["annotations", value]),
    scheduleDelayedSetup: (...args) => {
      delayedSetup = args;
      events.push(["delayed", ...args]);
    },
    writeSession: (value) => events.push(["session", value]),
    renameTab: async (tabID) => events.push(["rename", tabID]),
    cleanup: (tabID) => events.push(["cleanup", tabID]),
  });
  return {
    events,
    leftItem,
    rightItem,
    service,
    shell,
    win,
    getState: () => state,
    getDelayedSetup: () => delayedSetup,
  };
}

test("initializes different PDFs and persists the shared split setup", async () => {
  const fixture = setup();
  const leftViewState = { pageIndex: 1 };
  const rightViewState = { pageIndex: 4 };

  await fixture.service.createAndInitialize({
    win: fixture.win,
    tabID: "split-tab",
    shell: fixture.shell,
    leftItem: fixture.leftItem,
    rightItem: fixture.rightItem,
    leftViewState,
    rightViewState,
    isSamePDF: false,
  });

  const state = fixture.getState();
  assert.equal(state.leftItemID, 1);
  assert.equal(state.rightItemID, 2);
  assert.equal(state.leftParentItemID, 11);
  assert.equal(state.rightParentItemID, 22);
  assert.strictEqual(state.leftViewState, leftViewState);
  assert.strictEqual(state.rightViewState, rightViewState);
  assert.ok(fixture.events.some(([name, same]) => name === "loaded" && !same));
  assert.ok(!fixture.events.some(([name]) => name === "annotations"));
  assert.ok(fixture.events.some(([name]) => name === "session"));
  assert.deepEqual(fixture.events.at(-1), ["rename", "split-tab"]);

  const [, scheduledState, scheduledWin, leftBrowser, rightBrowser] =
    fixture.getDelayedSetup();
  assert.strictEqual(scheduledState, state);
  assert.strictEqual(scheduledWin, fixture.win);
  assert.strictEqual(leftBrowser, fixture.shell.leftBrowser);
  assert.strictEqual(rightBrowser, fixture.shell.rightBrowser);
});

test("times out a stalled reader and ignores a later initialization completion", async () => {
  let expire;
  let release;
  const stalled = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = setup({
    timers: {
      setTimeout: (callback) => {
        expire = callback;
        return 1;
      },
      clearTimeout: () => {},
    },
    initialize: () => stalled,
  });
  const result = fixture.service.createAndInitialize({
    win: fixture.win,
    tabID: "stalled-tab",
    shell: fixture.shell,
    leftItem: fixture.leftItem,
    rightItem: fixture.rightItem,
    isSamePDF: false,
  });
  expire();
  await assert.rejects(result, /initialization timed out/);
  release();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(fixture.events.at(-1), ["cleanup", "stalled-tab"]);
  assert.ok(!fixture.events.some(([name]) => name === "session"));
});

test("binds annotations for same-PDF creation", async () => {
  const fixture = setup();

  await fixture.service.createAndInitialize({
    win: fixture.win,
    tabID: "same-pdf-tab",
    shell: fixture.shell,
    leftItem: fixture.leftItem,
    rightItem: fixture.leftItem,
    leftViewState: { pageIndex: 1 },
    rightViewState: { pageIndex: 6 },
    isSamePDF: true,
  });

  assert.ok(fixture.events.some(([name, same]) => name === "loaded" && same));
  const annotationCall = fixture.events.find(
    ([name]) => name === "annotations",
  );
  assert.strictEqual(annotationCall[1], fixture.getState());
  assert.equal(fixture.getState().leftItemID, fixture.getState().rightItemID);
});

test("cleans up and propagates reader initialization failures", async () => {
  const fixture = setup({ failInitialization: true });

  await assert.rejects(
    fixture.service.createAndInitialize({
      win: fixture.win,
      tabID: "failed-tab",
      shell: fixture.shell,
      leftItem: fixture.leftItem,
      rightItem: fixture.rightItem,
      leftViewState: null,
      rightViewState: null,
      isSamePDF: false,
    }),
    /reader failed/,
  );

  assert.deepEqual(fixture.events.at(-1), ["cleanup", "failed-tab"]);
  assert.ok(!fixture.events.some(([name]) => name === "session"));
});
