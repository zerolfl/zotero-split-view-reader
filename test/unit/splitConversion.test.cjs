const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { SplitViewConversionService } = load(
  "src/modules/splitView/conversion.ts",
  {},
);

function setup({
  item = { id: 1 },
  container = {},
  viewState = { pageIndex: 3 },
  failAt,
} = {}) {
  const events = [];
  const win = { document: {} };
  const shell = { leftBrowser: {}, rightBrowser: {} };
  const service = new SplitViewConversionService({
    getMainWindow: () => win,
    getItem: (id) => {
      events.push(["item", id]);
      return item;
    },
    getContainer: (currentWin, tabID) => {
      events.push(["container", currentWin, tabID]);
      return container;
    },
    getViewState: async (reader) => {
      events.push(["view-state", reader]);
      return viewState;
    },
    getStoredViewState: async (currentItem) => {
      events.push(["stored-state", currentItem]);
      return { pageIndex: 8 };
    },
    closeReader: async (reader) => events.push(["close", reader]),
    createShell: (currentWin, tabID, currentContainer) => {
      events.push(["shell", currentWin, tabID, currentContainer]);
      if (failAt === "shell") throw new Error("shell failed");
      return shell;
    },
    createAndInitialize: async (options) => {
      events.push(["create", options]);
      if (failAt === "reader") throw new Error("reader failed");
    },
    restoreReader: async (...args) => events.push(["restore", ...args]),
  });
  return { events, item, service, shell, viewState, win };
}

test("converts different PDFs and restores each side's position", async () => {
  const fixture = setup();
  const reader = { tabID: "reader-tab", itemID: 1 };
  const rightItem = { id: 2 };
  const restoredLeft = { pageIndex: 5 };

  await fixture.service.convertDifferentPDF(reader, rightItem, {
    leftViewState: restoredLeft,
  });

  const names = fixture.events.map(([name]) => name);
  assert.deepEqual(names, [
    "item",
    "container",
    "view-state",
    "stored-state",
    "close",
    "shell",
    "create",
  ]);
  const [, options] = fixture.events.at(-1);
  assert.strictEqual(options.win, fixture.win);
  assert.equal(options.tabID, "reader-tab");
  assert.strictEqual(options.shell, fixture.shell);
  assert.strictEqual(options.leftItem, fixture.item);
  assert.strictEqual(options.rightItem, rightItem);
  assert.strictEqual(options.leftViewState, restoredLeft);
  assert.deepEqual(options.rightViewState, { pageIndex: 8 });
  assert.equal(options.isSamePDF, false);
});

test("rolls back shell and reader failures using the current reading position", async () => {
  for (const failAt of ["shell", "reader"]) {
    for (const same of [false, true]) {
      const fixture = setup({ failAt });
      const reader = { tabID: "tab", itemID: 1 };
      const restored = { leftViewState: { pageIndex: 8 } };
      await assert.rejects(
        same
          ? fixture.service.convertSamePDF(reader, restored)
          : fixture.service.convertDifferentPDF(reader, { id: 2 }, restored),
        new RegExp(`${failAt} failed`),
      );
      const [name, win, tabID, , itemID, view] = fixture.events.at(-1);
      assert.equal(name, "restore");
      assert.strictEqual(win, fixture.win);
      assert.equal(tabID, "tab");
      assert.equal(itemID, 1);
      assert.strictEqual(view, fixture.viewState);
    }
  }
});

test("converts the same PDF and uses the captured position for both sides", async () => {
  const fixture = setup();
  const reader = { tabID: "reader-tab", itemID: 1 };
  const restoredRight = { pageIndex: 9 };

  await fixture.service.convertSamePDF(reader, {
    rightViewState: restoredRight,
  });

  assert.equal(
    fixture.events.some(([name]) => name === "stored-state"),
    false,
  );
  const [, options] = fixture.events.at(-1);
  assert.strictEqual(options.leftItem, fixture.item);
  assert.strictEqual(options.rightItem, fixture.item);
  assert.strictEqual(options.leftViewState, fixture.viewState);
  assert.strictEqual(options.rightViewState, restoredRight);
  assert.equal(options.isSamePDF, true);
});

test("keeps the current reader open when its attachment or tab is unavailable", async () => {
  const missingItem = setup({ item: null });
  await assert.rejects(
    missingItem.service.convertSamePDF({ tabID: "tab", itemID: 99 }),
    /Attachment 99 is unavailable/,
  );
  assert.equal(
    missingItem.events.some(([name]) => name === "close"),
    false,
  );

  const missingContainer = setup({ container: null });
  await assert.rejects(
    missingContainer.service.convertSamePDF({ tabID: "tab", itemID: 1 }),
    /Tab container not found/,
  );
  assert.equal(
    missingContainer.events.some(([name]) => name === "close"),
    false,
  );
});
