const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function searchRuntime() {
  const items = new Map();
  const conditions = [];
  const tabs = [
    {
      id: "split",
      type: "reader-unloaded",
      data: { itemID: 11, rightItemID: 21 },
    },
    { id: "library2", type: "reader-loading", data: { itemID: 31 } },
  ];
  const regular = (id, libraryID, attachments) => ({
    id,
    libraryID,
    getAttachments: () => attachments,
    isRegularItem: () => true,
  });
  const attachment = (id, parentID, contentType = "application/pdf") => ({
    id,
    parentID,
    isFileAttachment: () => true,
    attachmentContentType: contentType,
  });
  items.set(1, regular(1, 1, [11, 12]));
  items.set(2, regular(2, 1, [21]));
  items.set(3, regular(3, 2, [31]));
  items.set(4, regular(4, 1, [41]));
  items.set(11, attachment(11, 1));
  items.set(12, attachment(12, 1));
  items.set(21, attachment(21, 2));
  items.set(31, attachment(31, 3));
  items.set(41, attachment(41, 4, "text/html"));
  const globals = {
    Zotero: {
      Items: { get: (id) => items.get(id) },
      Reader: {
        _readers: [{ itemID: 12 }, { itemID: 41 }],
        getByTabID: () => null,
      },
      getMainWindow: () => ({ Zotero_Tabs: { _tabs: tabs } }),
      Search: class {
        addCondition(...args) {
          conditions.push(args);
        }
        async search() {
          return [1, 2, 3, 4];
        }
      },
    },
  };
  const registry = load("src/platform/readerRegistry.ts", globals, {
    "./tabs": load("src/platform/tabs.ts", globals),
  });
  const search = load("src/modules/pdfSelector/search.ts", globals, {
    "../../platform/readerRegistry": registry,
  });
  return { ...search, conditions, registry };
}

test("empty search includes both split sides, filters the library and deduplicates parents", async () => {
  const runtime = searchRuntime();
  assert.deepEqual(
    Array.from(await runtime.searchPDFItems("", 1), (item) => item.id),
    [1, 2],
  );
  assert.deepEqual(
    Array.from(await runtime.searchPDFItems(""), (item) => item.id),
    [1, 2, 3],
  );
  assert.equal(runtime.conditions.length, 0);
});

test("keyword search retains PDF parents and uses supported three-argument conditions", async () => {
  const runtime = searchRuntime();
  assert.deepEqual(
    Array.from(await runtime.searchPDFItems("title", 1), (item) => item.id),
    [1, 2],
  );
  assert.deepEqual(runtime.conditions, [
    ["libraryID", "is", "1"],
    ["itemType", "isNot", "attachment"],
    ["itemType", "isNot", "note"],
    ["quicksearch-titleCreatorYear", "contains", "title"],
  ]);
});
