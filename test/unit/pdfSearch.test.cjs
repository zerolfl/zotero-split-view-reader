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
    isFileAttachment: () => false,
  });
  const attachment = (id, parentID, contentType = "application/pdf") => ({
    id,
    parentID,
    isFileAttachment: () => true,
    isRegularItem: () => false,
    attachmentContentType: contentType,
    attachmentReaderType:
      contentType === "application/pdf"
        ? "pdf"
        : contentType === "application/epub+zip"
          ? "epub"
          : contentType === "text/html"
            ? "snapshot"
            : undefined,
  });
  items.set(1, regular(1, 1, [11, 12]));
  items.set(2, regular(2, 1, [21]));
  items.set(3, regular(3, 2, [31]));
  items.set(4, regular(4, 1, [41]));
  items.set(5, regular(5, 1, [51, 52, 53]));
  items.set(6, regular(6, 1, [61]));
  items.set(11, attachment(11, 1));
  items.set(12, attachment(12, 1));
  items.set(21, attachment(21, 2));
  items.set(31, attachment(31, 3));
  items.set(41, attachment(41, 4, "text/html"));
  items.set(51, attachment(51, 5, "application/pdf"));
  items.set(52, attachment(52, 5, "application/epub+zip"));
  items.set(53, attachment(53, 5, "text/html"));
  items.set(61, attachment(61, 6, "text/plain"));
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
          return [1, 2, 3, 4, 5, 6];
        }
      },
    },
  };
  const registry = load("src/platform/readerRegistry.ts", globals, {
    "./tabs": load("src/platform/tabs.ts", globals),
    "./readerApi": { readerApi: { getByTabID: () => null } },
  });
  const search = load("src/modules/attachmentSelector/search.ts", globals, {
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
    [1, 2, 5],
  );
  assert.deepEqual(runtime.conditions, [
    ["libraryID", "is", "1"],
    ["libraryID", "is", "1"],
    ["quicksearch-titleCreatorYear", "contains", "title"],
    ["itemType", "isNot", "attachment"],
    ["itemType", "isNot", "note"],
    ["itemType", "is", "attachment"],
    ["title", "contains", "title"],
  ]);
});

test("reader search includes PDF, EPUB and snapshots but filters other files", async () => {
  const runtime = searchRuntime();
  assert.deepEqual(
    Array.from(await runtime.searchReaderItems("title", 1), (item) => item.id),
    [1, 2, 4, 5],
  );
});
