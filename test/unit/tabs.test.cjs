const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function setup(tabAPI) {
  const messages = [];
  const win = { Zotero_Tabs: tabAPI };
  const tabs = load("src/platform/tabs.ts", {
    Zotero: {
      getMainWindow: () => win,
      debug: (message) => messages.push(message),
    },
  });

  return {
    messages,
    setAudioStatus: tabs.setTabAudioStatus,
    getTabs: () => tabs.tabsForWindowIfAvailable(win),
  };
}

test("forwards audio status to the tab API", () => {
  const calls = [];
  const fixture = setup({
    setAudioStatus: (...args) => calls.push(args),
  });
  const status = { active: true, paused: false };

  fixture.setAudioStatus("split-tab", status);

  assert.deepEqual(calls, [["split-tab", status]]);
  assert.deepEqual(fixture.messages, []);
});

test("ignores Zotero versions without tab audio status support", () => {
  const fixture = setup({});

  assert.doesNotThrow(() => fixture.setAudioStatus("split-tab", {}));
  assert.deepEqual(fixture.messages, []);
});

test("returns no tabs adapter when the window has no Zotero tabs", () => {
  const fixture = setup(undefined);

  assert.equal(fixture.getTabs(), null);
});

test("returns a tabs adapter when the window exposes Zotero tabs", () => {
  const fixture = setup({ selectedID: "reader-tab" });

  assert.equal(fixture.getTabs().selectedID, "reader-tab");
});

test("logs tab audio status failures without propagating them", () => {
  const fixture = setup({
    setAudioStatus: () => {
      throw new Error("tab API failed");
    },
  });

  assert.doesNotThrow(() => fixture.setAudioStatus("split-tab", {}));
  assert.match(fixture.messages[0], /setSplitTabAudioStatus failed/);
  assert.match(fixture.messages[0], /tab API failed/);
});
