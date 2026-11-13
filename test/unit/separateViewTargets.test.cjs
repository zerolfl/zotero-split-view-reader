const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function setup({ tabs = [], readers = new Map(), openReader } = {}) {
  const events = [];
  const list = [...tabs];
  const deps = {
    getTabs: () => ({
      list: () => list,
      lookup: (id) => ({ tab: list.find((tab) => tab.id === id) || null }),
      move: (id, index) => events.push(["move", id, index]),
      close: (id) => {
        events.push(["close", id]);
        const index = list.findIndex((tab) => tab.id === id);
        if (index >= 0) list.splice(index, 1);
      },
      select: (id) => events.push(["select", id]),
      selectedID: "other",
    }),
    getReader: (id) => readers.get(id) || null,
    openReader: async (itemID, options) => {
      events.push(["open", itemID, options]);
      const reader = openReader
        ? await openReader(itemID, options)
        : { tabID: "opened", id: "opened" };
      if (reader?.tabID) {
        readers.set(reader.tabID, reader);
        list.push({ id: reader.tabID, type: "reader", data: { itemID } });
      }
      return reader;
    },
    waitForReaderReady: async (reader) => events.push(["ready", reader.id]),
    applyViewState: async (reader, state) =>
      events.push(["restore", reader.id, state.pageIndex]),
    delay: async (milliseconds) => events.push(["delay", milliseconds]),
    debug: (message) => events.push(["debug", message]),
  };
  const { SeparateViewTargets } = load(
    "src/modules/splitView/separateViewTargets.ts",
    {},
  );
  return { service: new SeparateViewTargets(deps), events, list };
}

test("reusable reader lookup excludes split and explicitly excluded tabs", () => {
  const { service } = setup({
    tabs: [
      { id: "split", type: "reader", data: { itemID: 7, isSplitView: true } },
      { id: "excluded", type: "reader", data: { itemID: 7 } },
      { id: "other", type: "reader", data: { itemID: 8 } },
      { id: "reuse", type: "reader-unloaded", data: { itemID: 7 } },
    ],
  });
  assert.equal(
    service.findReusableReaderTabID(7, new Set(["excluded"])),
    "reuse",
  );
  assert.equal(service.findReusableReaderTabID(8), "other");
  assert.equal(service.findReusableReaderTabID(9), null);
});

test("prepare opens a missing target in the background and restores its position", async () => {
  const { service, events } = setup();
  const target = {
    itemID: 7,
    tabID: null,
    viewState: { pageIndex: 2 },
    side: "left",
  };
  await service.prepare(target, 4);
  assert.equal(target.tabID, "opened");
  assert.deepEqual(
    events.map((event) => event[0]),
    ["open", "ready", "restore"],
  );
  assert.equal(events[0][2].openInBackground, true);
  assert.equal(events[0][2].allowDuplicate, true);
  assert.deepEqual(events[2], ["restore", "opened", 2]);
});

test("prepare moves and restores a live reader tab, or defers its restore", async () => {
  const reader = { id: "live", tabID: "live" };
  const { service, events } = setup({
    tabs: [{ id: "live", type: "reader", title: "PDF", data: { itemID: 7 } }],
    readers: new Map([["live", reader]]),
  });
  const target = {
    itemID: 7,
    tabID: "live",
    viewState: { pageIndex: 1 },
    side: "right",
  };
  await service.prepare(target, 3, true);
  assert.deepEqual(events, [
    ["move", "live", 3],
    ["select", "live"],
    ["ready", "live"],
    ["restore", "live", 1],
  ]);
  events.length = 0;
  await service.prepare(target, 2, false, true);
  assert.deepEqual(events, [["move", "live", 2]]);
});

test("prepare replaces an unloaded target while preserving its title", async () => {
  const { service, events, list } = setup({
    tabs: [
      {
        id: "unloaded",
        type: "reader-unloaded",
        title: "Original title",
        data: { itemID: 7 },
      },
    ],
  });
  const target = {
    itemID: 7,
    tabID: "unloaded",
    viewState: { pageIndex: 1 },
    side: "left",
  };
  await service.prepare(target, 0);
  assert.equal(target.tabID, "opened");
  assert.equal(
    list.some((tab) => tab.id === "unloaded"),
    false,
  );
  const openEvent = events.find((event) => event[0] === "open");
  assert.equal(openEvent[1], 7);
  assert.equal(openEvent[2].title, "Original title");
  assert.equal(openEvent[2].tabIndex, 0);
  assert.equal(openEvent[2].openInBackground, true);
  assert.equal(openEvent[2].allowDuplicate, true);
});
