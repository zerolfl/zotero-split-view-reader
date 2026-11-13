const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function setup(overrides = {}) {
  const events = [];
  const reader = { tabID: "reader-1", itemID: 1 };
  const first = { id: 1, libraryID: 7 };
  const second = { id: 2, libraryID: 7 };
  let tabs = overrides.tabs || [];
  let readerLookups = 0;
  const { SplitLibraryFlow } = load("src/modules/splitView/libraryFlow.ts", {});
  const flow = new SplitLibraryFlow({
    selectPDF: async (step, libraryID) => {
      events.push(["select", step, libraryID]);
      const key = step === "first" ? "first" : "second";
      return Object.hasOwn(overrides, key)
        ? overrides[key]
        : step === "first"
          ? first
          : second;
    },
    getTabs: () => ({
      list: () => tabs,
      select: (id) => events.push(["tab", id]),
    }),
    getReader: (id) => {
      events.push(["reader", id]);
      readerLookups++;
      return overrides.getReader ? overrides.getReader(readerLookups) : null;
    },
    openReader: async (id) => {
      events.push(["open", id]);
      return overrides.openReader === undefined ? reader : overrides.openReader;
    },
    wait: async (milliseconds) => events.push(["wait", milliseconds]),
    waitForReaderReady: async () => events.push(["ready"]),
    hasSplitState: () => overrides.hasSplitState || false,
    splitSamePDF: async () => events.push(["same"]),
    splitDifferentPDF: async (_reader, item) =>
      events.push(["different", item.id]),
  });
  return {
    flow,
    events,
    reader,
    first,
    second,
    setTabs: (value) => (tabs = value),
  };
}

test("library flow stops when either PDF selection is cancelled", async () => {
  const firstCancel = setup({ first: null });
  await firstCancel.flow.open();
  assert.deepEqual(firstCancel.events, [["select", "first", undefined]]);

  const secondCancel = setup({ second: null });
  await secondCancel.flow.open();
  assert.deepEqual(secondCancel.events, [
    ["select", "first", undefined],
    ["open", 1],
    ["ready"],
    ["select", "second", 7],
  ]);
});

test("library flow selects existing split tabs for either attachment", async () => {
  for (const data of [
    { itemID: 1, rightItemID: 2 },
    { itemID: 2, rightItemID: 1 },
  ]) {
    const rt = setup({ tabs: [{ id: "split", data }] });
    await rt.flow.open();
    assert.deepEqual(rt.events, [
      ["select", "first", undefined],
      ["tab", "split"],
    ]);
  }
});

test("library flow reuses an existing reader and waits for unloaded tabs", async () => {
  const rt = setup({
    tabs: [{ id: "existing", data: { itemID: 1 } }],
    getReader: (lookup) =>
      lookup === 1 ? null : { tabID: "reader-1", itemID: 1 },
    hasSplitState: true,
  });
  await rt.flow.open();
  assert.deepEqual(rt.events, [
    ["select", "first", undefined],
    ["tab", "existing"],
    ["wait", 300],
    ["reader", "existing"],
    ["wait", 1000],
    ["reader", "existing"],
  ]);
});

test("library flow continues after an existing tab finishes loading", async () => {
  const rt = setup({
    tabs: [{ id: "existing", data: { itemID: 1 } }],
    getReader: (lookup) =>
      lookup === 1 ? null : { tabID: "reader-1", itemID: 1 },
    second: null,
  });
  await rt.flow.open();
  assert.deepEqual(rt.events, [
    ["select", "first", undefined],
    ["tab", "existing"],
    ["wait", 300],
    ["reader", "existing"],
    ["wait", 1000],
    ["reader", "existing"],
    ["ready"],
    ["select", "second", 7],
  ]);
});

test("library flow opens a reader and chooses the same or different PDF path", async () => {
  for (const same of [true, false]) {
    const rt = setup({
      second: same ? { id: 1, libraryID: 7 } : { id: 2, libraryID: 7 },
    });
    await rt.flow.open();
    assert.deepEqual(rt.events, [
      ["select", "first", undefined],
      ["open", 1],
      ["ready"],
      ["select", "second", 7],
      same ? ["same"] : ["different", 2],
    ]);
  }
});

test("library flow returns when no reader can be opened", async () => {
  const rt = setup({ openReader: false });
  await rt.flow.open();
  assert.deepEqual(rt.events, [
    ["select", "first", undefined],
    ["open", 1],
  ]);
});
