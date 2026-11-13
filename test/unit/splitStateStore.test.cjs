const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { SplitTabStateStore } = load("src/modules/splitView/stateStore.ts");

function state(tabID, rightItemID, isCleaningUp = false) {
  return { tabID, rightItemID, isCleaningUp };
}

test("stores per-tab state and supports lifecycle operations", () => {
  const store = new SplitTabStateStore();
  const first = state("first", 10);
  const second = state("second", 20);

  assert.equal(store.get("missing"), undefined);
  assert.equal(store.hasAny(), false);

  store.set(first.tabID, first);
  store.set(second.tabID, second);

  assert.strictEqual(store.get("first"), first);
  assert.equal(store.has("second"), true);
  assert.deepEqual([...store.keys()], ["first", "second"]);
  assert.deepEqual([...store.values()], [first, second]);
  const entries = [...store.entries()];
  assert.equal(entries[0][0], "first");
  assert.strictEqual(entries[0][1], first);
  assert.equal(entries[1][0], "second");
  assert.strictEqual(entries[1][1], second);
  assert.equal(store.hasAny(), true);

  assert.equal(store.remove("first"), true);
  assert.equal(store.remove("first"), false);
  store.clear();

  assert.equal(store.has("second"), false);
  assert.equal(store.hasAny(), false);
});

test("finds a right-side attachment only in an active split state", () => {
  const store = new SplitTabStateStore();
  const cleaning = state("cleaning", 42, true);
  const active = state("active", 42);
  store.set(cleaning.tabID, cleaning);
  store.set(active.tabID, active);

  assert.strictEqual(store.findByRightItem(42), active);
  assert.equal(store.findByRightItem(99), undefined);

  active.isCleaningUp = true;
  assert.equal(store.findByRightItem(42), undefined);
});
