const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

class Target {
  listeners = new Map();
  children = [];
  style = {};
  attributes = {};
  rect = { left: 0, right: 0, top: 0, bottom: 100, width: 1, height: 100 };

  addEventListener(type, listener, capture = false) {
    const list = this.listeners.get(type) || [];
    list.push({ listener, capture });
    this.listeners.set(type, list);
  }

  removeEventListener(type, listener, capture = false) {
    this.listeners.set(
      type,
      (this.listeners.get(type) || []).filter(
        (entry) => entry.listener !== listener || entry.capture !== capture,
      ),
    );
  }

  emit(type, values = {}) {
    const event = {
      ...values,
      key: values.key,
      preventDefault() {},
      stopPropagation() {},
    };
    for (const { listener } of [...(this.listeners.get(type) || [])])
      listener(event);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  remove() {
    this.removed = true;
  }

  setAttribute(key, value) {
    this.attributes[key] = value;
  }

  getBoundingClientRect() {
    return this.rect;
  }
}

function setup() {
  const state = {
    splitRatio: 0.5,
    isCleaningUp: false,
    eventListeners: [],
    dragOverlay: null,
  };
  const doc = new Target();
  doc.documentElement = new Target();
  doc.createElement = () => new Target();
  doc.createXULElement = () => new Target();
  const win = new Target();
  win.document = doc;
  win.requestAnimationFrame = (callback) => callback();
  const left = new Target();
  const right = new Target();
  const resizer = new Target();
  left.rect = {
    left: 100,
    right: 600,
    top: 0,
    bottom: 800,
    width: 500,
    height: 800,
  };
  resizer.rect = {
    left: 599,
    right: 600,
    top: 0,
    bottom: 800,
    width: 1,
    height: 800,
  };
  const container = new Target();
  container.rect = {
    left: 100,
    right: 1101,
    top: 0,
    bottom: 800,
    width: 1001,
    height: 800,
  };
  let persists = 0;
  const { SplitLayout } = load("src/modules/splitView/layout.ts", {});
  const layout = new SplitLayout(
    (id) => (id === "tab" ? state : undefined),
    () => persists++,
  );
  layout.setupResizerDrag("tab", resizer, left, right, container, win);
  return {
    state,
    doc,
    win,
    left,
    right,
    resizer,
    container,
    layout,
    persists: () => persists,
  };
}

test("resizer constrains both panes and Escape restores the original ratio without persisting", () => {
  const rt = setup();
  rt.resizer.emit("mousedown", { clientX: 600, clientY: 20 });
  const overlay = rt.state.dragOverlay;
  assert.ok(overlay);
  overlay.emit("mousemove", { clientX: 2000 });
  assert.equal(rt.state.splitRatio, 0.8);
  overlay.emit("mousemove", { clientX: 100 });
  assert.equal(rt.state.splitRatio, 0.2);
  rt.win.emit("keydown", { key: "Escape" });
  assert.equal(rt.state.splitRatio, 0.5);
  assert.equal(rt.state.dragOverlay, null);
  assert.equal(rt.win.listeners.get("keydown").length, 0);
  assert.equal(rt.persists(), 0);
});

test("mouse release persists the final ratio and removes all temporary listeners", () => {
  const rt = setup();
  rt.win.emit("mousedown", { clientX: 600, clientY: 20 });
  assert.ok(rt.state.dragOverlay);
  rt.state.dragOverlay.emit("mousemove", { clientX: 700 });
  assert.equal(rt.state.splitRatio, 0.6);
  rt.win.emit("mouseup");
  assert.equal(rt.state.dragOverlay, null);
  assert.equal(rt.persists(), 1);
  assert.equal(rt.win.listeners.get("mouseup").length, 0);
  assert.equal(rt.win.listeners.get("blur").length, 0);
  assert.equal(rt.win.listeners.get("keydown").length, 0);
  assert.equal(rt.state.eventListeners.length, 2);
});

test("browser panes use proportional flex sizing", () => {
  const rt = setup();
  rt.layout.updateBrowserFlex(rt.left, rt.right, 0.35);
  assert.equal(rt.left.style.flex, "350 1 0");
  assert.equal(rt.right.style.flex, "650 1 0");
});

test("resizing is ignored when the container cannot fit two minimum-width panes", () => {
  const rt = setup();
  rt.container.rect.width = 350;
  rt.resizer.emit("mousedown", { clientX: 600, clientY: 20 });
  rt.state.dragOverlay.emit("mousemove", { clientX: 700 });
  assert.equal(rt.state.splitRatio, 0.5);
  rt.win.emit("mouseup");
  assert.equal(rt.persists(), 1);
});
