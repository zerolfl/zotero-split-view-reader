const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

test("reader API adapter forwards open and tab lookup calls", async () => {
  const calls = [];
  const reader = { tabID: "reader-1" };
  const { readerApi } = load("src/platform/readerApi.ts", {
    Zotero: {
      Reader: {
        getByTabID: (tabID) => {
          calls.push(["getByTabID", tabID]);
          return tabID === reader.tabID ? reader : undefined;
        },
        open: async (...args) => {
          calls.push(["open", ...args]);
          return reader;
        },
      },
    },
  });
  const location = { pageIndex: 3 };
  const options = { openInBackground: true };

  assert.equal(readerApi.getByTabID(reader.tabID), reader);
  assert.equal(readerApi.getByTabID("missing"), null);
  assert.equal(await readerApi.open(42, location, options), reader);
  assert.deepEqual(calls, [
    ["getByTabID", "reader-1"],
    ["getByTabID", "missing"],
    ["open", 42, location, options],
  ]);
});
