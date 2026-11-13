const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

async function flush() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function item(id, attachments = []) {
  return { id, attachments, getField: () => `Item ${id}` };
}

function selectorRuntime(search) {
  const views = [];
  const timers = new Map();
  const errors = [];
  let timerID = 0;
  const { PDFSelector } = load(
    "src/modules/pdfSelector/index.ts",
    {
      Zotero: { logError: (error) => errors.push(error) },
      setTimeout: (callback) => {
        timers.set(++timerID, callback);
        return timerID;
      },
      clearTimeout: (id) => timers.delete(id),
    },
    {
      "../../platform/selectionPrompt": { createSelectionPrompt: () => {} },
      "../../utils/locale": { getString: (key) => key },
      "./search": {
        getItemDescription: () => "description",
        getPDFAttachments: (value) => value.attachments,
        searchPDFItems: search,
      },
    },
  );
  const selector = new PDFSelector(() => {
    const view = {
      rows: [],
      renders: 0,
      disposed: false,
      open(_placeholder, handlers) {
        this.handlers = handlers;
      },
      resetInput() {},
      render(rows) {
        this.rows = rows;
        this.renders++;
      },
      dispose(commands) {
        this.disposed = true;
        this.commands = commands;
      },
    };
    views.push(view);
    return view;
  }, search);
  return {
    selector,
    views,
    errors,
    timers,
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

test("an older search cannot replace newer results or cancel on stale failure", async () => {
  for (const rejectOlder of [false, true]) {
    const older = deferred();
    const newer = deferred();
    const runtime = selectorRuntime((query) =>
      query ? newer.promise : older.promise,
    );
    const selected = runtime.selector.select();
    const view = runtime.views[0];
    view.handlers.input("new");
    runtime.runTimers();
    newer.resolve([item(2)]);
    await flush();
    assert.equal(view.rows[0].title, "Item 2");
    if (rejectOlder) older.reject(new Error("stale failure"));
    else older.resolve([item(1)]);
    await flush();
    assert.equal(view.rows[0].title, "Item 2");
    assert.equal(view.disposed, false);
    assert.equal(runtime.errors.length, 0);
    runtime.selector.dispose();
    assert.equal(await selected, null);
  }
});

test("cancelling a selection clears debounce and prevents late rendering", async () => {
  const pending = deferred();
  const runtime = selectorRuntime(() => pending.promise);
  const selected = runtime.selector.select();
  const view = runtime.views[0];
  view.handlers.input("later");
  runtime.selector.dispose();
  assert.equal(await selected, null);
  assert.equal(runtime.timers.size, 0);
  pending.resolve([item(1)]);
  await flush();
  assert.equal(view.renders, 0);
});

test("opening another selector cancels only the previous session", async () => {
  const runtime = selectorRuntime(async () => []);
  const first = runtime.selector.select();
  const second = runtime.selector.select();
  assert.equal(await first, null);
  assert.equal(runtime.views[0].disposed, true);
  assert.equal(runtime.views[1].disposed, false);
  runtime.selector.dispose();
  assert.equal(await second, null);
});

test("Escape returns from attachment choices, then settles and restores commands", async () => {
  const parent = item(1, [item(11), item(12)]);
  const runtime = selectorRuntime(async () => [parent]);
  const selected = runtime.selector.select();
  const view = runtime.views[0];
  await flush();
  view.rows[0].select();
  await flush();
  assert.equal(view.rows.length, 2);
  view.handlers.back();
  await flush();
  assert.equal(view.rows.length, 1);
  assert.equal(view.disposed, false);
  view.handlers.back();
  assert.equal(await selected, null);
  assert.equal(view.commands, true);
});

test("a selected attachment settles the result and current search failures clean up", async () => {
  const attachment = item(11);
  const runtime = selectorRuntime(async () => [item(1, [attachment])]);
  const selected = runtime.selector.select();
  await flush();
  runtime.views[0].rows[0].select();
  assert.equal(await selected, attachment);
  assert.equal(runtime.views[0].disposed, true);

  const failed = selectorRuntime(async () => {
    throw new Error("search failed");
  });
  assert.equal(await failed.selector.select(), null);
  assert.equal(failed.errors[0].message, "search failed");
  assert.equal(failed.views[0].disposed, true);
});
