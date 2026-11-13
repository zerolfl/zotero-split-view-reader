const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { SplitReaderEntryFlow } = load(
  "src/modules/splitView/readerEntryFlow.ts",
);

function setup({
  state = null,
  item = { id: 1, libraryID: 5 },
  selectedPDF,
} = {}) {
  const events = [];
  const reader = { tabID: "reader-tab", itemID: 1 };
  let currentState = state;
  const flow = new SplitReaderEntryFlow({
    getState: () => currentState,
    cleanup: (tabID) => {
      events.push(["cleanup", tabID]);
      currentState = null;
    },
    wait: async (milliseconds) => events.push(["wait", milliseconds]),
    getItem: (itemID) => {
      events.push(["item", itemID]);
      return item;
    },
    selectPDF: async (libraryID) => {
      events.push(["select", libraryID]);
      return selectedPDF === undefined ? { id: 2 } : selectedPDF;
    },
    convertSamePDF: async (value) => events.push(["same", value]),
    convertDifferentPDF: async (value, target) =>
      events.push(["different", value, target]),
  });
  return {
    events,
    flow,
    reader,
    setState: (value) => (currentState = value),
  };
}

test("cleans stale tab state and routes same or different PDF selections", async () => {
  const same = setup({
    state: { isCleaningUp: false },
    selectedPDF: { id: 1 },
  });
  await same.flow.open(same.reader);
  assert.deepEqual(
    same.events.map(([name]) => name),
    ["cleanup", "wait", "item", "select", "same"],
  );
  assert.deepEqual(same.events[1], ["wait", 50]);
  assert.strictEqual(same.events.at(-1)[1], same.reader);

  const different = setup({ selectedPDF: { id: 3 } });
  await different.flow.open(different.reader);
  const call = different.events.at(-1);
  assert.equal(call[0], "different");
  assert.strictEqual(call[1], different.reader);
  assert.deepEqual(call[2], { id: 3 });
});

test("stops when the current item is missing or PDF selection is cancelled", async () => {
  const missingItem = setup({ item: null });
  await missingItem.flow.open(missingItem.reader);
  assert.deepEqual(
    missingItem.events.map(([name]) => name),
    ["wait", "item"],
  );

  const cancelled = setup({ selectedPDF: null });
  await cancelled.flow.open(cancelled.reader);
  assert.deepEqual(
    cancelled.events.map(([name]) => name),
    ["wait", "item", "select"],
  );
});

test("cleans a newly created split state when conversion fails", async () => {
  const fixture = setup();
  const { SplitReaderEntryFlow: Flow } = load(
    "src/modules/splitView/readerEntryFlow.ts",
  );
  let state = null;
  const flow = new Flow({
    getState: () => state,
    cleanup: (tabID) => {
      fixture.events.push(["cleanup", tabID]);
      state = null;
    },
    wait: async () => {},
    getItem: () => ({ id: 1, libraryID: 5 }),
    selectPDF: async () => ({ id: 2 }),
    convertSamePDF: async () => {},
    convertDifferentPDF: async () => {
      state = { isCleaningUp: false };
      throw new Error("conversion failed");
    },
  });

  await flow.open(fixture.reader);

  assert.deepEqual(fixture.events, [["cleanup", "reader-tab"]]);
});
