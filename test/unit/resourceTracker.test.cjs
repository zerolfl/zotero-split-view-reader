const assert = require("node:assert/strict");
const { test } = require("node:test");
const { setTimeout } = require("node:timers");
const { load } = require("./helpers.cjs");

const { SplitTabResourceTracker } = load(
  "src/modules/splitView/resourceTracker.ts",
);

test("tracks event listeners and their registration options on the tab", () => {
  const registrations = [];
  const target = {
    addEventListener: (...args) => registrations.push(args),
  };
  const state = { eventListeners: [], timeoutIds: [] };
  const options = { once: true, passive: true };
  const listener = () => {};
  const tracker = new SplitTabResourceTracker(() => ({ setTimeout }));

  tracker.trackEventListener(state, target, "change", listener, options);

  assert.equal(registrations.length, 1);
  assert.strictEqual(registrations[0][0], "change");
  assert.strictEqual(registrations[0][1], listener);
  assert.strictEqual(registrations[0][2], options);
  assert.equal(state.eventListeners.length, 1);
  const [tracked] = state.eventListeners;
  assert.strictEqual(tracked.target, target);
  assert.equal(tracked.type, "change");
  assert.strictEqual(tracked.listener, listener);
  assert.strictEqual(tracked.options, options);
});

test("tracks main-window timeout IDs for tab cleanup", () => {
  const state = { eventListeners: [], timeoutIds: [] };
  const callback = () => {};
  const events = [];
  const tracker = new SplitTabResourceTracker(() => ({
    setTimeout: (fn, delay) => {
      events.push([fn, delay]);
      return 17;
    },
  }));

  const id = tracker.trackTimeout(state, callback, 350);

  assert.equal(id, 17);
  assert.deepEqual(state.timeoutIds, [17]);
  assert.deepEqual(events, [[callback, 350]]);
});
