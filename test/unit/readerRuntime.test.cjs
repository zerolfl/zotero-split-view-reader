const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { readerRuntime } = load("src/platform/readerRuntime.ts", {
  Zotero: { debug() {} },
});

function browser(reader) {
  return {
    contentWindow: { wrappedJSObject: { _reader: reader } },
  };
}

test("sidebar state prefers the Reader method and falls back to the view", () => {
  const calls = [];
  assert.equal(
    readerRuntime.setSidebarOpen(
      browser({
        toggleSidebar: (open) => calls.push(["reader", open]),
        _primaryView: {
          setSidebarOpen: (open) => calls.push(["view", open]),
        },
      }),
      true,
    ),
    true,
  );
  assert.deepEqual(calls, [["reader", true]]);

  assert.equal(
    readerRuntime.setSidebarOpen(
      browser({
        _primaryView: {
          setSidebarOpen: (open) => calls.push(["view", open]),
        },
      }),
      false,
    ),
    true,
  );
  assert.deepEqual(calls, [
    ["reader", true],
    ["view", false],
  ]);
  assert.equal(readerRuntime.setSidebarOpen(browser({}), true), false);
});

test("sidebar view fallback runs when the Reader method throws", () => {
  const calls = [];
  const result = readerRuntime.setSidebarOpen(
    browser({
      toggleSidebar: () => {
        calls.push("reader");
        throw new Error("Reader method failed");
      },
      _primaryView: {
        setSidebarOpen: (open) => calls.push(["view", open]),
      },
    }),
    false,
  );

  assert.equal(result, true);
  assert.deepEqual(calls, ["reader", ["view", false]]);
});
