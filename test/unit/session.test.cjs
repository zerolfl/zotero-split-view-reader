const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function runtime() {
  const timers = new Map();
  const records = new Map();
  const states = new Map();
  const restores = [];
  const visible = new Map();
  let loadListener;
  let counter = 0;
  let unsubscribed = false;
  const tabs = {
    list: () =>
      Array.from(records, ([id, data]) => ({ id, data, type: "reader" })),
    lookup: (id) => ({
      tab: records.has(id) ? { data: records.get(id) } : null,
    }),
    clearDataFields: (id, fields) =>
      fields.forEach((field) => delete records.get(id)[field]),
    setTabData: (id, data) => records.set(id, { ...records.get(id), ...data }),
  };
  const { SplitSession } = load(
    "src/modules/splitView/session.ts",
    {
      Zotero: {
        logError(error) {
          throw error;
        },
      },
      setTimeout: (callback) => {
        timers.set(++counter, callback);
        return counter;
      },
      clearTimeout: (id) => timers.delete(id),
    },
    {
      "../../platform/readerView": {
        readerView: {
          getImmediateViewStateFromBrowser: (browser) => visible.get(browser),
        },
      },
      "../../platform/tabs": {
        tabsForWindow: () => tabs,
        observeReaderLoads: (callback) => {
          loadListener = callback;
          return () => {
            unsubscribed = true;
          };
        },
      },
    },
  );
  const session = new SplitSession(
    async (id) => {
      restores.push(id);
    },
    () => false,
    (id) => states.get(id),
  );
  return {
    session,
    timers,
    records,
    states,
    restores,
    visible,
    load: (id, data) => loadListener(id, data),
    unsubscribed: () => unsubscribed,
    runTimers() {
      const jobs = [...timers.values()];
      timers.clear();
      jobs.forEach((callback) => callback());
    },
  };
}

test("session restoration deduplicates a loaded tab and cancels queued work on unload", async () => {
  const rt = runtime();
  rt.records.set("one", { isSplitView: true });
  rt.session.register();
  rt.runTimers();
  rt.load("one", { isSplitView: true });
  rt.runTimers();
  assert.deepEqual(rt.restores, ["one"]);
  rt.load("later", { isSplitView: true });
  rt.session.unregister();
  rt.runTimers();
  assert.deepEqual(rt.restores, ["one"]);
  assert.equal(rt.timers.size, 0);
  assert.equal(rt.unsubscribed(), true);
});

test("session data writes by tab ID and normal-reader close removes split fields", () => {
  const { session, records, visible, states } = runtime();
  const leftBrowser = {};
  visible.set(leftBrowser, { pageIndex: 5 });
  records.set("split", { syncEnabled: true, unrelated: "keep" });
  states.set("split", {
    tabID: "split",
    container: {},
    leftBrowser,
    leftItemID: 1,
    rightItemID: 1,
    isSamePDF: true,
    primarySide: null,
    activeSide: "right",
    splitRatio: 0.4,
    leftViewState: { pageIndex: 0, lastReadAloudPosition: { pageIndex: 2 } },
    rightViewState: { pageIndex: 1 },
  });
  session.writeTab("split");
  session.writeTab("missing");
  assert.equal(records.get("split").leftViewState.pageIndex, 5);
  assert.equal(
    records.get("split").leftViewState.lastReadAloudPosition.pageIndex,
    2,
  );
  assert.equal(records.get("split").rightViewState.pageIndex, 1);
  assert.equal("syncEnabled" in records.get("split"), false);
  session.prepareClose("split", 1);
  assert.deepEqual(records.get("split"), { itemID: 1, unrelated: "keep" });
});
