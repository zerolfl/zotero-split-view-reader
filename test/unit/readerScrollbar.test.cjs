const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function setup() {
  const styles = new Map();
  const appended = [];
  const deadWrappers = new WeakSet();
  const document = {
    getElementById: (id) => styles.get(id) || null,
    createElement: () => ({
      remove() {
        this.removed = true;
        styles.delete(this.id);
      },
    }),
    head: {
      appendChild: (style) => {
        style.parent = "head";
        appended.push(style);
        styles.set(style.id, style);
      },
    },
    documentElement: {
      appendChild: (style) => {
        style.parent = "root";
        appended.push(style);
        styles.set(style.id, style);
      },
    },
  };
  const browser = { contentWindow: {} };
  const internalReader = {
    _primaryView: { _iframe: { contentWindow: { document } } },
  };
  const { ReaderScrollbarAdapter } = load(
    "src/platform/readerScrollbar.ts",
    {
      Components: {
        utils: { isDeadWrapper: (value) => deadWrappers.has(value) },
      },
      Zotero: { debug: () => {} },
    },
    {
      "./readerRuntime": {
        readerRuntime: { getInternalReaderFromBrowser: () => internalReader },
      },
    },
  );

  return {
    adapter: new ReaderScrollbarAdapter(),
    appended,
    browser,
    document,
    deadWrappers,
    internalReader,
    styles,
  };
}

test("scrollbar adapter inserts a primary color and skips identical CSS", () => {
  const harness = setup();
  harness.adapter.setPrimaryColor(harness.browser, {
    red: 12,
    green: 34,
    blue: 56,
  });
  const style = harness.styles.get("split-view-scrollbar-style");

  assert.match(style.textContent, /rgba\(12, 34, 56, 0\.6\)/);
  harness.adapter.setPrimaryColor(harness.browser, {
    red: 12,
    green: 34,
    blue: 56,
  });
  assert.equal(harness.appended.length, 1);
});

test("scrollbar adapter replaces changed colors and clears secondary styling", () => {
  const harness = setup();
  harness.adapter.setPrimaryColor(harness.browser, {
    red: 255,
    green: 0,
    blue: 0,
  });
  const original = harness.styles.get("split-view-scrollbar-style");
  harness.adapter.setPrimaryColor(harness.browser, {
    red: 0,
    green: 80,
    blue: 200,
  });

  assert.equal(original.removed, true);
  assert.equal(harness.appended.length, 2);
  assert.match(
    harness.styles.get("split-view-scrollbar-style").textContent,
    /rgba\(0, 80, 200, 0\.6\)/,
  );
  harness.adapter.setPrimaryColor(harness.browser, null);
  assert.equal(harness.styles.has("split-view-scrollbar-style"), false);
});

test("scrollbar adapter tolerates a reader without a primary PDF view", () => {
  const harness = setup();
  harness.internalReader._primaryView = null;
  harness.adapter.setPrimaryColor(harness.browser, {
    red: 255,
    green: 0,
    blue: 0,
  });
  assert.equal(harness.appended.length, 0);
});

test("scrollbar adapter falls back to the live document root", () => {
  const harness = setup();
  harness.deadWrappers.add(harness.document.head);
  harness.adapter.setPrimaryColor(harness.browser, {
    red: 20,
    green: 30,
    blue: 40,
  });

  assert.equal(harness.styles.get("split-view-scrollbar-style").parent, "root");
});
