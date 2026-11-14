const assert = require("node:assert/strict");
const { test } = require("node:test");
const { setImmediate } = require("node:timers");
const { load } = require("./helpers.cjs");

function runtime() {
  const calls = [];
  const cloned = [];
  class ContentError extends Error {}
  class ContentPromise extends Promise {}
  const targetWindow = { Promise: ContentPromise, Error: ContentError };
  const result = { ok: true, bytes: new Uint8Array([1, 2]).buffer };
  const globals = {
    Zotero: {
      SDT: {
        getPack: async (itemID, options) => {
          calls.push({ itemID, ...options });
          options.onProgress?.(75);
          return result;
        },
      },
    },
    Components: {
      utils: {
        waiveXrays: (value) => value,
        isDeadWrapper: () => false,
        cloneInto: (value, target) => {
          assert.equal(target, targetWindow);
          cloned.push(value);
          return globalThis.structuredClone(value);
        },
      },
    },
  };
  const { createGetSDTPack } = load("src/platform/readerSDT.ts", globals);
  return { createGetSDTPack, targetWindow, globals, calls, cloned, result };
}

test("SDT provider is optional on older clients and requires an attachment", () => {
  const { createGetSDTPack, targetWindow, globals } = runtime();
  assert.equal(createGetSDTPack(0, targetWindow), null);
  delete globals.Zotero.SDT;
  assert.equal(createGetSDTPack(7, targetWindow), null);
  globals.Zotero.SDT = {};
  assert.equal(createGetSDTPack(7, targetWindow), null);
});

test("SDT provider requests its attachment and clones bytes into a content Promise", async () => {
  const { createGetSDTPack, targetWindow, calls, result } = runtime();
  const progress = [];
  const promise = createGetSDTPack(
    7,
    targetWindow,
  )({
    onProgress: (value) => progress.push(value),
  });
  assert.ok(promise instanceof targetWindow.Promise);
  const pack = await promise;
  assert.deepEqual(pack, result);
  assert.notEqual(pack.bytes, result.bytes);
  assert.equal(calls[0].itemID, 7);
  assert.equal(calls[0].isPriority, true);
  assert.deepEqual(progress, [75]);
});

test("SDT unavailable results reach the reader without a progress callback", async () => {
  const { createGetSDTPack, targetWindow, globals } = runtime();
  globals.Zotero.SDT.getPack = async (_itemID, options) => {
    assert.equal(options.onProgress, null);
    return { ok: false, reason: "unavailable" };
  };
  assert.deepEqual(await createGetSDTPack(8, targetWindow)(), {
    ok: false,
    reason: "unavailable",
  });
});

test("unexpected SDT failures reject with a content Error", async () => {
  const { createGetSDTPack, targetWindow, globals } = runtime();
  globals.Zotero.SDT.getPack = async () => {
    throw new Error("extraction failed");
  };
  await assert.rejects(createGetSDTPack(9, targetWindow)(), (error) => {
    assert.ok(error instanceof targetWindow.Error);
    assert.equal(error.message, "extraction failed");
    return true;
  });
});

test("SDT completion and progress skip a destroyed reader window", async () => {
  const { createGetSDTPack, targetWindow, globals, cloned, result } = runtime();
  let complete;
  let report;
  globals.Zotero.SDT.getPack = (_itemID, { onProgress }) => {
    report = onProgress;
    return new Promise((resolve) => (complete = resolve));
  };
  let notified = false;
  createGetSDTPack(
    10,
    targetWindow,
  )({
    onProgress: () => (notified = true),
  });
  await Promise.resolve();
  globals.Components.utils.isDeadWrapper = () => true;
  report(100);
  complete(result);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notified, false);
  assert.deepEqual(cloned, []);
});
