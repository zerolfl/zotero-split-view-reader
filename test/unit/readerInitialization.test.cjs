const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { SplitReaderInitialization } = load(
  "src/modules/splitView/readerInitialization.ts",
);

function setup({ failSave = false } = {}) {
  const events = [];
  const state = {
    leftBrowser: { side: "left" },
    rightBrowser: { side: "right" },
    leftViewState: null,
    rightViewState: null,
    isCleaningUp: false,
  };
  let hostOptions;
  const host = {
    initialize: async (options) => {
      hostOptions = options;
      events.push(["host", options.item.id]);
    },
  };
  const service = new SplitReaderInitialization(host, {
    getState: () => state,
    getReadAloudConfig: async (browser, ftl, onStatus) => ({
      browser,
      ftl,
      onStatus,
    }),
    handleReadAloudStatus: (...args) => events.push(["audio", ...args]),
    openContextMenu: (...args) => events.push(["menu", ...args]),
    toggleSidebar: (...args) => events.push(["sidebar", ...args]),
    shouldSyncLastReadAloudPosition: () => true,
    syncLastReadAloudPosition: (...args) =>
      events.push(["last-position", ...args]),
    writeSession: (value) => events.push(["session", value]),
    saveAnnotations: async (item, browser, annotations, win) => {
      events.push(["save", item.id, browser.side, annotations, win]);
      if (failSave) throw new Error("save failed");
    },
    deleteAnnotations: async (itemID, ids) => {
      events.push(["delete", itemID, ids]);
      throw new Error("delete failed");
    },
    reportAnnotationFailure: (browser, error) =>
      events.push(["annotation-error", browser.side, error.message]),
    toggleContextPane: (tabID) => events.push(["toggle-pane", tabID]),
    afterReady: (...args) => events.push(["ready", ...args]),
  });
  return {
    events,
    getHostOptions: () => hostOptions,
    service,
    state,
  };
}

test("wires reader callbacks and tracks only the active side view state", async () => {
  const fixture = setup();
  const browser = fixture.state.rightBrowser;
  const item = { id: 2 };
  const popupset = {};
  const viewState = { pageIndex: 4 };

  await fixture.service.initialize(
    "tab",
    browser,
    item,
    popupset,
    viewState,
    true,
  );

  const options = fixture.getHostOptions();
  assert.strictEqual(options.browser, browser);
  assert.strictEqual(options.item, item);
  assert.strictEqual(options.viewState, viewState);
  assert.equal(options.isRight, true);
  assert.equal(options.isActive(), true);
  options.callbacks.onViewStateChange(viewState);
  assert.equal(fixture.state.rightViewState.pageIndex, viewState.pageIndex);
  assert.notStrictEqual(fixture.state.rightViewState, viewState);
  assert.ok(fixture.events.some(([name]) => name === "session"));
  assert.ok(fixture.events.some(([name]) => name === "last-position"));

  fixture.state.isCleaningUp = true;
  assert.equal(options.isActive(), false);
  options.callbacks.onViewStateChange({ pageIndex: 8 });
  assert.equal(fixture.state.rightViewState.pageIndex, 4);
});

test("reports annotation save and delete failures while releasing save callbacks", async () => {
  const fixture = setup({ failSave: true });
  const browser = fixture.state.leftBrowser;
  const item = { id: 1 };
  await fixture.service.initialize("tab", browser, item, {});
  const callbacks = fixture.getHostOptions().callbacks;
  let completed = 0;

  await callbacks.saveAnnotations([{ id: "a" }], () => completed++, {});
  callbacks.deleteAnnotations(["a"]);
  await Promise.resolve();

  assert.equal(completed, 1);
  assert.ok(
    fixture.events.some(
      ([name, side, message]) =>
        name === "annotation-error" &&
        side === "left" &&
        message === "save failed",
    ),
  );
  assert.ok(
    fixture.events.some(
      ([name, side, message]) =>
        name === "annotation-error" &&
        side === "left" &&
        message === "delete failed",
    ),
  );
});

test("forwards toolbar, sidebar, audio and context menu actions", async () => {
  const fixture = setup();
  const browser = fixture.state.leftBrowser;
  const popupset = {};
  await fixture.service.initialize("tab", browser, { id: 1 }, popupset);
  const options = fixture.getHostOptions();
  options.callbacks.onReadAloudStatus({ active: true });
  options.callbacks.toggleSidebar(true);
  options.callbacks.openContextMenu({ x: 4, y: 5, itemGroups: [] });
  options.callbacks.toggleContextPane();
  options.callbacks.afterReady();

  assert.ok(
    fixture.events.some(
      ([name, , , value]) => name === "audio" && value.active,
    ),
  );
  assert.ok(fixture.events.some(([name]) => name === "sidebar"));
  assert.ok(fixture.events.some(([name]) => name === "menu"));
  assert.ok(fixture.events.some(([name]) => name === "toggle-pane"));
  assert.deepEqual(fixture.events.at(-1), ["ready", "tab", browser, "left"]);
});
