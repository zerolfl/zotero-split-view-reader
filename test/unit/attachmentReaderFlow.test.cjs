const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

test("opens the selected attachment in Zotero Reader", async () => {
  const events = [];
  const attachment = { id: 42 };
  const { AttachmentReaderFlow } = load(
    "src/modules/splitView/attachmentReaderFlow.ts",
  );
  const flow = new AttachmentReaderFlow({
    selectAttachment: async () => {
      events.push("select");
      return attachment;
    },
    openReader: async (id) => events.push(["open", id]),
  });

  await flow.open();

  assert.deepEqual(events, ["select", ["open", 42]]);
});

test("does nothing when attachment selection is cancelled", async () => {
  let opened = false;
  const { AttachmentReaderFlow } = load(
    "src/modules/splitView/attachmentReaderFlow.ts",
  );
  const flow = new AttachmentReaderFlow({
    selectAttachment: async () => null,
    openReader: async () => {
      opened = true;
    },
  });

  await flow.open();

  assert.equal(opened, false);
});

test("reuses a normal reader tab and duplicates a split-only attachment", () => {
  const { findExistingReaderTabID, needsSeparateReaderTab } = load(
    "src/modules/splitView/attachmentReaderFlow.ts",
  );
  const splitOnly = [{ id: "split", data: { itemID: 42, rightItemID: 43 } }];
  const splitAndReader = [...splitOnly, { id: "reader", data: { itemID: 42 } }];

  assert.equal(findExistingReaderTabID(42, splitAndReader), "reader");
  assert.equal(needsSeparateReaderTab(42, splitOnly), true);
  assert.equal(needsSeparateReaderTab(42, splitAndReader), false);
});
