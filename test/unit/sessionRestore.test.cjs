const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { SplitSessionRestore } = load("src/modules/splitView/sessionRestore.ts");

function setup({
  reader = {},
  existingState = false,
  items = [1, 2],
  onConvert = () => {},
} = {}) {
  const events = [];
  const leftItem = { id: 1 };
  const rightItem = { id: 2 };
  const itemsByID = new Map(
    items.map((id) => [id, id === 1 ? leftItem : rightItem]),
  );
  const state = {
    leftBrowser: {},
    rightBrowser: {},
    splitRatio: 0.5,
    primarySide: "left",
    activeSide: "left",
  };
  const service = new SplitSessionRestore({
    getReader: () => reader,
    getInitializationPromise: (value) => value.initialization || null,
    hasState: () => existingState,
    itemExists: (id) => itemsByID.has(id),
    getItem: (id) => itemsByID.get(id) || null,
    convertSamePDF: async (...args) => {
      events.push(["same", ...args]);
      onConvert();
    },
    convertDifferentPDF: async (...args) => {
      events.push(["different", ...args]);
      onConvert();
    },
    getState: () => state,
    updateBrowserFlex: (...args) => events.push(["flex", ...args]),
    updateScrollbarColors: (id) => events.push(["scrollbar", id]),
    writeSession: (id) => events.push(["session", id]),
    debug: (message) => events.push(["debug", message]),
  });
  return { events, leftItem, rightItem, service, state };
}

test("restores a same-PDF split after reader initialization and reapplies settings", async () => {
  const events = [];
  const initialization = Promise.resolve().then(() =>
    events.push("initialized"),
  );
  const reader = { initialization };
  const fixture = setup({ reader });
  const savedData = {
    leftItemID: 1,
    rightItemID: 1,
    isSamePDF: true,
    splitRatio: 0.65,
    primarySide: null,
    activeSide: "right",
  };

  await fixture.service.restore("tab", savedData);

  assert.equal(events[0], "initialized");
  assert.equal(fixture.events[1][0], "same");
  assert.strictEqual(fixture.events[1][1], reader);
  assert.notStrictEqual(fixture.events[1][2], savedData);
  assert.deepEqual({ ...fixture.events[1][2] }, savedData);
  assert.equal(fixture.state.splitRatio, 0.65);
  assert.equal(fixture.state.primarySide, null);
  assert.equal(fixture.state.activeSide, "right");
  assert.equal(
    fixture.events.some(([name]) => name === "flex"),
    true,
  );
  assert.equal(fixture.events.at(-1)[0], "debug");
});

test("restores different PDFs and migrates the legacy disabled-sync flag", async () => {
  const fixture = setup();
  const savedData = {
    leftItemID: 1,
    rightItemID: 2,
    isSamePDF: false,
    splitRatio: 1,
    primarySide: "right",
    activeSide: "left",
    syncEnabled: false,
  };

  await fixture.service.restore("different-tab", savedData);

  assert.equal(fixture.events[1][0], "different");
  assert.strictEqual(fixture.events[1][2], fixture.rightItem);
  assert.notStrictEqual(fixture.events[1][3], savedData);
  assert.deepEqual({ ...fixture.events[1][3] }, savedData);
  assert.equal(fixture.state.splitRatio, 0.5);
  assert.equal(fixture.state.primarySide, null);
  assert.equal(fixture.state.activeSide, "left");
  assert.deepEqual(
    fixture.events.slice(2).map(([name]) => name),
    ["scrollbar", "session", "debug"],
  );
});

test("skips restoration for a missing reader, existing split or missing item", async () => {
  const missingReader = setup({ reader: null });
  await missingReader.service.restore("tab", {});
  assert.equal(
    missingReader.events.some(([name]) => name === "debug"),
    true,
  );

  const existing = setup({ existingState: true });
  await existing.service.restore("tab", {});
  assert.match(existing.events[0][1], /already has split view/);

  const missingItem = setup({ items: [1] });
  await missingItem.service.restore("tab", { leftItemID: 1, rightItemID: 2 });
  assert.match(missingItem.events[0][1], /items no longer exist/);
});

test("preserves saved settings when reader creation rewrites live tab data", async () => {
  for (const isSamePDF of [true, false]) {
    const savedData = {
      leftItemID: 1,
      rightItemID: isSamePDF ? 1 : 2,
      isSamePDF,
      splitRatio: 0.65,
      primarySide: null,
      activeSide: "right",
    };
    const fixture = setup({
      onConvert: () =>
        Object.assign(savedData, {
          splitRatio: 0.5,
          primarySide: "left",
          activeSide: "left",
        }),
    });
    await fixture.service.restore("tab", savedData);
    assert.equal(fixture.state.splitRatio, 0.65);
    assert.equal(fixture.state.primarySide, null);
    assert.equal(fixture.state.activeSide, "right");
  }
});

test("propagates a failed reader initialization before restoring session data", async () => {
  const failure = new Error("reader initialization failed");
  const fixture = setup({
    reader: { initialization: Promise.reject(failure) },
  });

  await assert.rejects(
    fixture.service.restore("tab", { leftItemID: 1, rightItemID: 2 }),
    failure,
  );
  assert.equal(fixture.events.length, 0);
});
