const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function setup({ withParent = true, withDocument = true } = {}) {
  const events = [];
  const child = { id: "old-child" };
  const container = {
    replaceChild(next, old) {
      events.push(["replace-child", next, old]);
      next.parentNode = this;
      old.parentNode = null;
    },
  };
  const document = {
    createXULElement: (name) => {
      events.push(["create", name]);
      return {
        attributes: {},
        style: {},
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
      };
    },
  };
  const oldBrowser = {
    parentNode: withParent ? container : null,
    ownerDocument: withDocument ? document : null,
    className: "reader-browser",
    style: {
      flex: "600 1 0",
      minWidth: "200px",
      maxWidth: "none",
      overflow: "hidden",
      boxSizing: "border-box",
    },
    removeEventListener: (...args) => events.push(["remove-listener", ...args]),
  };
  const otherTarget = {};
  const state = {
    leftBrowser: oldBrowser,
    rightBrowser: { id: "right" },
    disposeAnnotations: () => events.push(["dispose-annotations"]),
    eventListeners: [
      { target: oldBrowser, type: "load", listener: child, options: true },
      { target: otherTarget, type: "click", listener: () => {} },
    ],
  };
  const { SplitReaderBrowserAdapter } = load(
    "src/platform/splitReaderBrowser.ts",
    {},
  );
  const adapter = new SplitReaderBrowserAdapter({
    getState: () => state,
    getReaderForBrowser: (browser) => {
      events.push(["get-reader", browser]);
      return { id: "old-reader" };
    },
    closeReader: async (reader) => events.push(["close-reader", reader]),
    clearReadAloudSide: (_state, side) => events.push(["clear-audio", side]),
  });
  return { adapter, child, container, events, oldBrowser, otherTarget, state };
}

test("replaces a browser after disposing its reader, annotation hooks and listeners", async () => {
  const { adapter, container, events, oldBrowser, otherTarget, state } =
    setup();
  const browser = await adapter.replace("split", "left");

  assert.strictEqual(state.leftBrowser, browser);
  assert.equal(state.disposeAnnotations, undefined);
  assert.deepEqual(
    state.eventListeners.map((entry) => entry.target),
    [otherTarget],
  );
  assert.equal(browser.parentNode, container);
  assert.equal(browser.className, oldBrowser.className);
  assert.deepEqual(browser.attributes, {
    type: "content",
    transparent: "true",
    src: "resource://zotero/reader/reader.html",
  });
  assert.deepEqual(browser.style, oldBrowser.style);
  assert.ok(events.some(([name]) => name === "dispose-annotations"));
  assert.ok(events.some(([name]) => name === "close-reader"));
  assert.ok(events.some(([name]) => name === "clear-audio"));
  assert.ok(events.some(([name]) => name === "remove-listener"));
});

test("returns without disposing resources when the browser has no parent", async () => {
  const { adapter, events, state } = setup({ withParent: false });
  assert.equal(await adapter.replace("split", "left"), null);
  assert.equal(state.disposeAnnotations !== undefined, true);
  assert.deepEqual(events, []);
});

test("returns null when the old browser has no owner document", async () => {
  const { adapter, events, state } = setup({ withDocument: false });
  assert.equal(await adapter.replace("split", "left"), null);
  assert.equal(state.disposeAnnotations, undefined);
  assert.ok(events.some(([name]) => name === "close-reader"));
  assert.ok(events.some(([name]) => name === "clear-audio"));
  assert.equal(
    events.some(([name]) => name === "replace-child"),
    false,
  );
});
