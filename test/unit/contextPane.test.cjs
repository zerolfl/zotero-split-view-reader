const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function createAdapter(globals = {}, readerRuntime = {}) {
  const { ContextPaneAdapter } = load("src/platform/contextPane.ts", globals, {
    "./readerRuntime": { readerRuntime },
  });
  return new ContextPaneAdapter();
}

test("context pane adapter toggles and reads the native pane state", () => {
  let toggled = 0;
  const adapter = createAdapter();
  const win = {
    ZoteroContextPane: {
      collapsed: false,
      togglePane: () => toggled++,
    },
  };

  assert.equal(adapter.toggleMainPane(win), true);
  assert.equal(toggled, 1);
  assert.equal(adapter.isMainPaneOpen(win), true);

  win.ZoteroContextPane.collapsed = true;
  assert.equal(adapter.isMainPaneOpen(win), false);
  assert.equal(adapter.toggleMainPane({}), false);
  assert.equal(adapter.isMainPaneOpen({}), false);
});

test("context pane adapter updates and selects the split tab item details", () => {
  const item = { id: 9, libraryID: 2, deleted: false };
  const appended = [];
  const deck = {
    querySelector: () => null,
    appendChild: (node) => appended.push(node),
  };
  const sidenav = {};
  const pane = { _itemPaneDeck: deck, _sidenav: sidenav };
  const document = {
    querySelector: () => pane,
    createXULElement: () => ({ dataset: {} }),
  };
  const adapter = createAdapter({
    Zotero: {
      Items: { get: (id) => (id === item.id ? item : null) },
      Libraries: { get: () => ({ editable: true }) },
    },
  });

  adapter.updateItem("tab-1", { document }, item.id);

  assert.equal(appended.length, 1);
  assert.equal(deck.selectedPanel, appended[0]);
  assert.equal(appended[0].dataset.tabId, "tab-1");
  assert.equal(appended[0].item, item);
  assert.equal(appended[0].editable, true);
  assert.equal(appended[0].sidenav, sidenav);
});

test("context pane adapter observes collapse changes and disconnects cleanly", () => {
  let observerCallback;
  let observed;
  let disconnected = false;
  class Observer {
    constructor(callback) {
      observerCallback = callback;
    }
    observe(target, options) {
      observed = { target, options };
    }
    disconnect() {
      disconnected = true;
    }
  }
  const pane = { collapsed: "false", getAttribute: () => pane.collapsed };
  const changes = [];
  const adapter = createAdapter({}, {});
  const observer = adapter.observeCollapsed(
    { document: { getElementById: () => pane }, MutationObserver: Observer },
    (isOpen) => changes.push(isOpen),
  );

  assert.ok(observer);
  assert.equal(observed.target, pane);
  assert.equal(
    Array.from(observed.options.attributeFilter).join(","),
    "collapsed",
  );
  pane.collapsed = "true";
  observerCallback([{ type: "attributes", attributeName: "collapsed" }]);
  assert.deepEqual(changes, [false]);
  adapter.disconnectObserver(observer);
  assert.equal(disconnected, true);
});

test("context pane adapter dispatches reader updates in the content window", () => {
  let dispatched;
  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.init = init;
    }
  }
  const contentWindow = {
    document: { dispatchEvent: (event) => (dispatched = event) },
    CustomEvent,
  };
  const browser = { contentWindow };
  const adapter = createAdapter(
    { Components: { utils: { cloneInto: (value) => value } } },
    { isBrowserAlive: () => true },
  );

  adapter.setReaderOpen(browser, false);

  assert.equal(dispatched.type, "__splitview_context_pane");
  assert.equal(dispatched.init.detail.open, false);
});
