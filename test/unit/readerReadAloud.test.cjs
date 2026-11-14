const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

test("unsupported readers skip both optional methods and content cloning", () => {
  const { readerReadAloud } = load("src/platform/readerReadAloud.ts", {
    Components: {
      utils: {
        cloneInto: () => assert.fail("Unsupported readers must not clone"),
      },
    },
  });
  for (const reader of [null, undefined, {}]) {
    readerReadAloud.setVoices(reader, {}, {});
    readerReadAloud.setEnabledVoices(reader, {}, {});
    readerReadAloud.openPopup(reader);
    readerReadAloud.togglePaused(reader);
    readerReadAloud.togglePaused(reader, true);
  }
});

test("voice changes cross into the target realm and retain the reader receiver", () => {
  const clones = [];
  const { readerReadAloud } = load("src/platform/readerReadAloud.ts", {
    Components: {
      utils: {
        cloneInto: (value, win) => {
          const clone = globalThis.structuredClone(value);
          clones.push({ value, win, clone });
          return clone;
        },
      },
    },
  });
  const win = {};
  const selected = { en: { voice: "test-voice", speed: 1 } };
  const enabled = { en: { standard: ["test-voice"] } };
  const reader = {
    setReadAloudVoices(value) {
      assert.strictEqual(this, reader);
      assert.notStrictEqual(value, selected);
      assert.deepEqual(value, selected);
      value.en.speed = 2;
    },
    setReadAloudEnabledVoices(value) {
      assert.strictEqual(this, reader);
      assert.notStrictEqual(value, enabled);
      assert.deepEqual(value, enabled);
    },
  };

  readerReadAloud.setVoices(reader, win, selected);
  readerReadAloud.setEnabledVoices(reader, win, enabled);

  assert.equal(selected.en.speed, 1);
  assert.equal(clones.length, 2);
  assert.ok(clones.every((entry) => entry.win === win));
});

test("playback controls preserve explicit pause and implicit toggle semantics", () => {
  const { readerReadAloud } = load("src/platform/readerReadAloud.ts", {});
  const calls = [];
  const reader = {
    toggleReadAloudPopup(open) {
      assert.strictEqual(this, reader);
      calls.push(["popup", open]);
    },
    toggleReadAloudPaused(...args) {
      assert.strictEqual(this, reader);
      calls.push(["pause", ...args]);
    },
  };

  readerReadAloud.openPopup(reader);
  readerReadAloud.togglePaused(reader, true);
  readerReadAloud.togglePaused(reader, false);
  readerReadAloud.togglePaused(reader);

  assert.deepEqual(calls, [
    ["popup", true],
    ["pause", true],
    ["pause", false],
    ["pause"],
  ]);
});
