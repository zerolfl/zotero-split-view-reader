const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");
const { structuredClone } = globalThis;

function runtime(readerRuntime = {}) {
  return load(
    "src/platform/readerView.ts",
    {
      Zotero: { debug() {} },
      Components: { utils: { cloneInto: (value) => structuredClone(value) } },
    },
    { "./readerRuntime": { readerRuntime } },
  ).readerView;
}

function reader(pagesCount = 3) {
  const pdfViewer = {
    pagesCount,
    _location: { pageNumber: 2, scale: 125, top: 100, left: 20 },
    scrollMode: 0,
    spreadMode: 0,
  };
  const win = { PDFViewerApplication: { pdfViewer } };
  const applied = [];
  const internal = {
    _primaryView: {
      _iframeWindow: win,
      _iframe: { contentWindow: win },
      _setState: async (state) => {
        applied.push(state);
        pdfViewer._location.pageNumber = state.pageIndex + 1;
      },
    },
    _state: {
      primaryViewState: {
        pageIndex: 0,
        scale: 50,
        lastReadAloudPosition: { pageIndex: 0 },
      },
    },
  };
  return { internal, applied, pdfViewer };
}

test("capture keeps the visible position and reading metadata ahead of stale disk state", async () => {
  const view = runtime();
  const { internal } = reader();
  const state = await view.getViewStateFromReader({
    _internalReader: internal,
    _getState: async () => {
      throw new Error("Disk should not replace live state");
    },
  });
  assert.equal(state.pageIndex, 1);
  assert.equal(state.scale, 125);
  assert.equal(state.top, 100);
  assert.equal(state.lastReadAloudPosition.pageIndex, 0);
  state.lastReadAloudPosition.pageIndex = 2;
  assert.equal(
    internal._state.primaryViewState.lastReadAloudPosition.pageIndex,
    0,
  );
});

test("current browser state prefers the live PDF position and keeps cached metadata", () => {
  const view = runtime({ getInternalReaderFromBrowser: () => internal });
  const { internal } = reader();
  const state = view.getCurrentViewStateFromBrowser({});
  assert.equal(state.pageIndex, 1);
  assert.equal(state.scale, 125);
  assert.equal(state.lastReadAloudPosition.pageIndex, 0);
});

test("state application clamps pages and drops offsets that belong to another page", async () => {
  const view = runtime();
  const { internal, applied } = reader(2);
  const result = await view.applyViewStateToReader(internal, {
    pageIndex: 8,
    scale: 100,
    top: 200,
    left: 50,
    scrollMode: 1,
  });
  assert.equal(result.pageIndexClamped, true);
  assert.equal(result.appliedPageIndex, 1);
  assert.equal(applied[0].pageIndex, 1);
  assert.equal(applied[0].scrollMode, 1);
  assert.equal("top" in applied[0], false);
  assert.equal("left" in applied[0], false);
});

test("state capture falls back to disk when no live reader exists", async () => {
  assert.equal(
    (
      await runtime().getViewStateFromReader({
        _getState: async () => ({ pageIndex: 3 }),
      })
    ).pageIndex,
    3,
  );
});

test("reader readiness releases its deadline after success or rejected initialization", async () => {
  const pending = new Map();
  let counter = 0;
  const { readerRuntime } = load("src/platform/readerRuntime.ts", {
    Zotero: { debug() {} },
    setTimeout: (callback) => {
      pending.set(++counter, callback);
      return counter;
    },
    clearTimeout: (id) => pending.delete(id),
  });
  const ready = { _iframeWindow: {}, initializedPromise: Promise.resolve() };
  await readerRuntime.waitForReaderReady({
    _internalReader: { _primaryView: ready },
  });
  assert.equal(pending.size, 0);
  await readerRuntime.waitForReaderReady({
    _initPromise: Promise.reject(new Error("failed")),
  });
  assert.equal(pending.size, 0);
});
