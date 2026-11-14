const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { SplitViewRegistration } = load("src/modules/splitView/registration.ts");

function setup() {
  const events = [];
  const registration = new SplitViewRegistration({
    registerSessionRestore: () => events.push("session"),
    registerTitleItemNotifier: () => events.push("title-notifier"),
    registerReaderContextMenu: () => events.push("reader-menu"),
    registerTabLookup: (win) => events.push(["tabs", win]),
    clearLegacySyncPreference: () => events.push("clear-legacy-pref"),
    registerScrollbarPreferences: (prefix) =>
      events.push(["scrollbar-prefs", prefix]),
    registerTitlePreference: (name) => events.push(["title-pref", name]),
    registerReadAloud: () => events.push("read-aloud"),
    registerCommandPalette: (win) => events.push(["commands", win]),
    unregisterAll: () => events.push("shutdown"),
  });
  return { events, registration };
}

test("registers preference observers after clearing the retired preference", () => {
  const { events, registration } = setup();

  registration.registerPreferences("extensions.split-view");

  assert.deepEqual(events, [
    "clear-legacy-pref",
    ["scrollbar-prefs", "extensions.split-view"],
    ["title-pref", "extensions.split-view.splitTabsTitle"],
    "read-aloud",
  ]);
});

test("routes startup, window and shutdown registration calls", () => {
  const { events, registration } = setup();
  const win = {};

  registration.registerSessionRestore();
  registration.registerTitleItemNotifier();
  registration.registerReaderContextMenu();
  registration.registerTabLookup(win);
  registration.registerCommandPalette(win);
  registration.unregisterAll();

  assert.deepEqual(events, [
    "session",
    "title-notifier",
    "reader-menu",
    ["tabs", win],
    ["commands", win],
    "shutdown",
  ]);
});
