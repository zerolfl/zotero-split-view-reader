const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function setup() {
  const elements = new Map();
  const listeners = new Map();
  let observerCallback;
  let observed;
  let active = true;
  let closed = 0;
  const document = {
    documentElement: {},
    head: {
      appendChild: (element) => elements.set(element.id, element),
    },
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => findButton,
    createElement: () => ({
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      addEventListener(type, callback) {
        listeners.set(`${this.id}:${type}`, callback);
      },
    }),
  };
  const findButton = {
    parentNode: {},
    after: (element) => elements.set(element.id, element),
  };
  class Observer {
    constructor(callback) {
      observerCallback = callback;
    }
    observe(target, options) {
      observed = { target, options };
    }
    disconnect() {}
  }
  const browser = {
    contentWindow: { document, MutationObserver: Observer },
  };
  const { installCloseButton } = load("src/platform/readerToolbar.ts", {
    Zotero: { debug: () => {} },
  });

  return {
    browser,
    elements,
    install: () =>
      installCloseButton(browser, {
        side: "right",
        label: "Close This View",
        isActive: () => active,
        onClose: () => closed++,
      }),
    listeners,
    observe: () => observerCallback(),
    setActive: (value) => (active = value),
    get closed() {
      return closed;
    },
    get observed() {
      return observed;
    },
  };
}

test("reader toolbar installs a localized close button and observes toolbar rebuilds", () => {
  const harness = setup();
  const observer = harness.install();
  const button = harness.elements.get("split-view-close-right");

  assert.ok(observer);
  assert.equal(button.attributes.title, "Close This View");
  assert.equal(button.attributes["aria-label"], "Close This View");
  assert.ok(harness.elements.has("split-view-close-button-style"));
  assert.equal(
    harness.observed.target,
    harness.browser.contentWindow.document.documentElement,
  );
  assert.equal(harness.observed.options.subtree, true);

  let prevented = 0;
  let stopped = 0;
  harness.listeners.get("split-view-close-right:mousedown")({
    preventDefault: () => prevented++,
    stopPropagation: () => stopped++,
  });
  harness.listeners.get("split-view-close-right:click")({
    preventDefault: () => prevented++,
    stopPropagation: () => stopped++,
  });
  assert.equal(prevented, 2);
  assert.equal(stopped, 2);
  assert.equal(harness.closed, 1);
});

test("reader toolbar retries insertion after mutations and ignores inactive splits", () => {
  const harness = setup();
  harness.install();
  harness.elements.delete("split-view-close-right");
  harness.setActive(false);
  harness.observe();
  assert.equal(harness.elements.has("split-view-close-right"), false);

  harness.setActive(true);
  harness.observe();
  assert.equal(harness.elements.has("split-view-close-right"), true);
});

test("reader toolbar returns without observing an unavailable browser window", () => {
  const harness = setup();
  harness.browser.contentWindow = null;
  assert.equal(harness.install(), null);
});

test("reader toolbar finds localized zoom controls using stable PDF.js IDs", () => {
  const zoomIn = {};
  const zoomOut = {};
  const buttons = new Map([
    ['[data-l10n-id="pdfjs-zoom-in-button"]', zoomIn],
    ['[data-l10n-id="pdfjs-zoom-out-button"]', zoomOut],
  ]);
  const document = {
    querySelector: (selector) => buttons.get(selector) || null,
    querySelectorAll: () => [],
  };
  const { findReaderZoomButton } = load("src/platform/readerToolbar.ts");
  const browser = {
    contentWindow: { wrappedJSObject: { document } },
  };

  assert.strictEqual(findReaderZoomButton(browser, "in"), zoomIn);
  assert.strictEqual(findReaderZoomButton(browser, "out"), zoomOut);
  assert.equal(findReaderZoomButton(browser, "reset"), null);
});

test("reader toolbar locates zoom controls by localized labels as a fallback", () => {
  const buttons = [
    {
      className: "",
      getAttribute: (name) => (name === "aria-label" ? "放大" : ""),
    },
    { className: "", getAttribute: (name) => (name === "title" ? "缩小" : "") },
    {
      className: "",
      getAttribute: (name) => (name === "aria-label" ? "重置" : ""),
    },
  ];
  const document = {
    querySelector: () => null,
    querySelectorAll: () => buttons,
  };
  const { findReaderZoomButton } = load("src/platform/readerToolbar.ts");
  const browser = { contentWindow: { document } };

  assert.strictEqual(findReaderZoomButton(browser, "in"), buttons[0]);
  assert.strictEqual(findReaderZoomButton(browser, "out"), buttons[1]);
  assert.strictEqual(findReaderZoomButton(browser, "reset"), buttons[2]);
  assert.equal(findReaderZoomButton({ contentWindow: null }, "in"), null);
});
