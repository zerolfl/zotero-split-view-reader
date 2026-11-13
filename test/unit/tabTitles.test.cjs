const assert = require("node:assert/strict");
const { test } = require("node:test");
const { setImmediate } = require("node:timers");
const { load } = require("./helpers.cjs");

function setup(states = []) {
  const items = new Map();
  const renamed = [];
  const notifierCallbacks = new Map();
  const preferenceCallbacks = new Map();
  const unregistered = [];
  let mode = "filename";
  const imports = {
    "../../platform/tabs": {
      tabsForWindow: () => ({
        rename: async (tabID, title) => renamed.push({ tabID, title }),
      }),
    },
    "../../utils/splitTabTitle": {
      getSplitViewTabTitleForItems: async (left, right, titleMode) =>
        `${left.title}|${right.title}|${titleMode}`,
    },
    "../../utils/prefs": { getPref: () => mode },
  };
  const globals = {
    Zotero: {
      Items: { get: (id) => items.get(id) },
      getMainWindow: () => ({}),
      Prefs: {
        registerObserver: (name, callback) => {
          const id = Symbol(name);
          preferenceCallbacks.set(id, callback);
          return id;
        },
        unregisterObserver: (id) => unregistered.push(id),
      },
      Notifier: {
        registerObserver: (observer) => {
          notifierCallbacks.set("title", observer);
          return "title";
        },
        unregisterObserver: (id) => unregistered.push(id),
      },
      debug: () => {},
      logError: () => {},
    },
  };
  const { SplitTabTitleService } = load(
    "src/modules/splitView/tabTitles.ts",
    globals,
    imports,
  );
  const service = new SplitTabTitleService({
    getStates: () => states,
    getState: (tabID) => states.find((state) => state.tabID === tabID),
  });
  return {
    service,
    items,
    renamed,
    notifierCallbacks,
    preferenceCallbacks,
    unregistered,
    setMode: (value) => (mode = value),
  };
}

function state(tabID, leftItemID, rightItemID, overrides = {}) {
  return {
    tabID,
    leftItemID,
    rightItemID,
    leftParentItemID: leftItemID + 100,
    rightParentItemID: rightItemID + 100,
    isCleaningUp: false,
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("title service reads split item IDs and falls back to ordinary tab data", async () => {
  const harness = setup();
  harness.items.set(1, { title: "Left" });
  harness.items.set(2, { title: "Right" });

  assert.equal(
    await harness.service.getTitleForTab({
      data: { leftItemID: 1, rightItemID: 2 },
    }),
    "Left|Right|filename",
  );
  assert.equal(
    await harness.service.getTitleForTab({ data: { itemID: 1 } }),
    "Left|Left|filename",
  );
  assert.equal(await harness.service.getTitleForTab({ data: {} }), "");
  harness.setMode("creatorYearTitle");
  assert.equal(
    await harness.service.getTitleForTab({
      data: { leftItemID: 1, rightItemID: 2 },
    }),
    "Left|Right|creatorYearTitle",
  );
});

test("item notifier renames only split tabs affected by either side or parent", async () => {
  const first = state("first", 1, 2);
  const other = state("other", 3, 4);
  const closing = state("closing", 5, 6, { isCleaningUp: true });
  const harness = setup([first, other, closing]);
  for (const id of [1, 2, 3, 4, 5, 6]) {
    harness.items.set(id, { title: `item-${id}` });
  }
  harness.service.registerItemNotifier();
  harness.service.registerItemNotifier();
  const notify = harness.notifierCallbacks.get("title").notify;

  notify("modify", "item", ["102"], {});
  await flush();
  assert.deepEqual(
    harness.renamed.map(({ tabID }) => tabID),
    ["first"],
  );
  notify("delete", "item", ["101"], {});
  notify("modify", "collection", ["101"], {});
  await flush();
  assert.equal(harness.renamed.length, 1);
});

test("preference changes refresh open titles and unregister both observers", async () => {
  const active = state("active", 1, 2);
  const closing = state("closing", 3, 4, { isCleaningUp: true });
  const harness = setup([active, closing]);
  for (const id of [1, 2]) harness.items.set(id, { title: `item-${id}` });

  harness.service.registerPreferenceObserver("plugin.splitTabsTitle");
  harness.service.registerPreferenceObserver("plugin.splitTabsTitle");
  harness.service.registerItemNotifier();
  harness.preferenceCallbacks.values().next().value();
  await flush();
  assert.deepEqual(
    harness.renamed.map(({ tabID }) => tabID),
    ["active"],
  );

  harness.service.unregister();
  assert.equal(harness.unregistered.length, 2);
  harness.service.unregister();
  assert.equal(harness.unregistered.length, 2);
});
