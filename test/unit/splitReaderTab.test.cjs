const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

class Element {
  constructor(name = "element") {
    this.name = name;
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.style = {};
  }

  cloneNode() {
    return new Element(this.name);
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || [])
      listener(event);
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }
}

function setup() {
  const replaced = [];
  const parent = {
    replaceChild(next, previous) {
      replaced.push([next, previous]);
      next.parentNode = this;
      previous.parentNode = null;
    },
  };
  const oldContainer = new Element("tab-content");
  oldContainer.parentNode = parent;
  const doc = {
    createXULElement: (name) => new Element(name),
  };
  const win = {
    document: doc,
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    },
  };
  const calls = [];
  let state = null;
  const { SplitReaderTabAdapter } = load("src/platform/splitReaderTab.ts", {});
  const adapter = new SplitReaderTabAdapter({
    getState: () => state,
    getInternalReader: (browser) => ({
      setBottomPlaceholderHeight: (height) =>
        calls.push(["placeholder", browser, height]),
    }),
    setContextPaneOpen: (browser, open) =>
      calls.push(["context-pane", browser, open]),
  });
  const shell = adapter.create(win, "split-tab", oldContainer);
  state = {
    leftBrowser: shell.leftBrowser,
    rightBrowser: shell.rightBrowser,
    isCleaningUp: false,
  };
  return { calls, oldContainer, parent, replaced, shell, state };
}

test("creates a split tab shell and bridges Zotero tab-content methods", () => {
  const { calls, oldContainer, parent, replaced, shell } = setup();

  assert.equal(replaced.length, 1);
  assert.strictEqual(replaced[0][1], oldContainer);
  assert.strictEqual(shell.container.parentNode, parent);
  assert.deepEqual(
    shell.mainHbox.children.map((child) => child.name),
    ["browser", "box", "browser"],
  );
  assert.deepEqual(shell.container.children, [
    shell.mainHbox,
    shell.leftPopupset,
    shell.rightPopupset,
  ]);
  assert.equal(
    shell.leftBrowser.attributes.src,
    "resource://zotero/reader/reader.html",
  );
  assert.equal(shell.leftBrowser.attributes.type, "content");
  assert.equal(shell.leftBrowser.attributes.transparent, "true");
  assert.equal(shell.leftBrowser.style.flex, "1 1 0");
  assert.equal(shell.rightBrowser.style.minWidth, "200px");
  assert.equal(shell.resizer.attributes.mousethrough, "never");
  assert.equal(shell.eventListeners.length, 3);
  assert.ok(
    shell.eventListeners.every((entry) => entry.target === shell.container),
  );

  shell.container.setContextPaneOpen(true);
  shell.container.setBottomPlaceholderHeight(48);
  shell.container.onTabSelectionChanged(true);
  assert.deepEqual(calls, [
    ["context-pane", shell.rightBrowser, true],
    ["placeholder", shell.leftBrowser, 48],
    ["placeholder", shell.rightBrowser, 48],
  ]);
});

test("does not bridge tab events after split state cleanup begins", () => {
  const { calls, shell, state } = setup();
  state.isCleaningUp = true;

  shell.container.setContextPaneOpen(true);
  shell.container.setBottomPlaceholderHeight(48);

  assert.deepEqual(calls, []);
});
