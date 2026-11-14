const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

test("item API adapter forwards lookups and existence checks", () => {
  const calls = [];
  const item = { id: 42 };
  const { itemApi } = load("src/platform/itemApi.ts", {
    Zotero: {
      Items: {
        get: (id) => {
          calls.push(["get", id]);
          return id === item.id ? item : false;
        },
        exists: (id) => {
          calls.push(["exists", id]);
          return id === item.id;
        },
      },
    },
  });

  assert.equal(itemApi.get(item.id), item);
  assert.equal(itemApi.get(99), false);
  assert.equal(itemApi.exists(item.id), true);
  assert.equal(itemApi.exists(99), false);
  assert.deepEqual(calls, [
    ["get", 42],
    ["get", 99],
    ["exists", 42],
    ["exists", 99],
  ]);
});
