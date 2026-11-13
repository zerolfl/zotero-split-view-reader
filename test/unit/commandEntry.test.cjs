const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function setup() {
  const calls = [];
  const readers = new Map();
  const { SplitCommandEntry } = load("src/modules/splitView/commandEntry.ts");
  const entry = new SplitCommandEntry({
    getReader: (win) => readers.get(win) || null,
    openReader: async (reader) => calls.push(["reader", reader]),
    openLibrary: async () => calls.push(["library"]),
  });
  return { calls, entry, readers };
}

test("command entry routes to the reader flow when the window has a reader", async () => {
  const fixture = setup();
  const win = {};
  const reader = { tabID: "reader-tab" };
  fixture.readers.set(win, reader);

  await fixture.entry.execute(win);

  assert.deepEqual(fixture.calls, [["reader", reader]]);
});

test("command entry falls back to library flow without a selected reader", async () => {
  const fixture = setup();

  await fixture.entry.execute({});

  assert.deepEqual(fixture.calls, [["library"]]);
});

test("command entry reads the current reader each time it executes", async () => {
  const fixture = setup();
  const win = {};

  await fixture.entry.execute(win);
  const reader = { tabID: "new-selection" };
  fixture.readers.set(win, reader);
  await fixture.entry.execute(win);

  assert.deepEqual(fixture.calls, [["library"], ["reader", reader]]);
});

test("command entry resolves reader context from the supplied window", async () => {
  const fixture = setup();
  const firstWindow = {};
  const secondWindow = {};
  const reader = { tabID: "second-window-reader" };
  fixture.readers.set(secondWindow, reader);

  await fixture.entry.execute(firstWindow);
  await fixture.entry.execute(secondWindow);

  assert.deepEqual(fixture.calls, [["library"], ["reader", reader]]);
});

test("command entry awaits its selected flow and propagates failures", async () => {
  const { SplitCommandEntry } = load("src/modules/splitView/commandEntry.ts");
  let settle;
  const pending = new Promise((resolve) => (settle = resolve));
  const entry = new SplitCommandEntry({
    getReader: () => ({ tabID: "reader-tab" }),
    openReader: () => pending,
    openLibrary: async () => assert.fail("library flow should not run"),
  });
  let finished = false;
  const execution = entry.execute({}).then(() => (finished = true));

  await Promise.resolve();
  assert.equal(finished, false);
  settle();
  await execution;
  assert.equal(finished, true);

  const failing = new SplitCommandEntry({
    getReader: () => null,
    openReader: async () => {},
    openLibrary: async () => {
      throw new Error("library failed");
    },
  });
  await assert.rejects(failing.execute({}), /library failed/);
});
