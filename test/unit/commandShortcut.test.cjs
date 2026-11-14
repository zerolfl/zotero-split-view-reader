const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { DEFAULT_COMMAND_SHORTCUT, formatShortcut, matchesShortcut } = load(
  "src/ui/commandShortcut.ts",
  {},
);

function event(key, modifiers = {}) {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    ...modifiers,
  };
}

test("formats recorded key combinations", () => {
  assert.equal(DEFAULT_COMMAND_SHORTCUT, "Shift+P");
  assert.equal(formatShortcut(event("P", { shiftKey: true })), "Shift+P");
  assert.equal(
    formatShortcut(event("k", { ctrlKey: true, altKey: true })),
    "Ctrl+Alt+K",
  );
  assert.equal(formatShortcut(event("P")), null);
  assert.equal(formatShortcut(event("Escape", { shiftKey: true })), null);
});

test("matches the configured combination exactly", () => {
  assert.equal(
    matchesShortcut(event("P", { shiftKey: true }), "Shift+P"),
    true,
  );
  assert.equal(
    matchesShortcut(event("k", { ctrlKey: true, altKey: true }), "Ctrl+Alt+K"),
    true,
  );
  assert.equal(
    matchesShortcut(event("P", { shiftKey: true, ctrlKey: true }), "Shift+P"),
    false,
  );
  assert.equal(matchesShortcut(event("P"), "Shift+P"), false);
});
