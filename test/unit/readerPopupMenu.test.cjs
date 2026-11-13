const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { SplitReaderPopupMenu } = load(
  "src/modules/splitView/readerPopupMenu.ts",
);

class Element {
  constructor(name) {
    this.name = name;
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) || []) listener({ type });
  }

  remove() {
    this.parentNode.children = this.parentNode.children.filter(
      (child) => child !== this,
    );
  }

  getBoundingClientRect() {
    return { left: 20, top: 30 };
  }

  openPopupAtScreen(x, y, show) {
    this.openedAt = [x, y, show];
  }
}

function setup({ split = false, convertCoordinates = true } = {}) {
  const events = [];
  const scheduled = [];
  const windowTimers = [];
  const browser = new Element("browser");
  const state = {
    leftBrowser: browser,
    rightBrowser: new Element("right-browser"),
    primarySide: "left",
    isCleaningUp: false,
  };
  const win = {
    document: { createXULElement: (name) => new Element(name) },
    setTimeout: (callback) => windowTimers.push(callback),
  };
  if (convertCoordinates) {
    win.windowUtils = {
      toScreenRectInCSSUnits: (x, y) => ({ x: x + 100, y: y + 200 }),
    };
  }
  const service = new SplitReaderPopupMenu({
    isBrowserAlive: () => true,
    getMainWindow: () => win,
    getStates: () => (split ? [["split-tab", state]] : []),
    getState: (tabID) => (tabID === "split-tab" ? state : null),
    getString: (key, options) => `${key}:${options?.args?.side || ""}`,
    getIconURI: (name) => `icon:${name}`,
    setMenuItemIcon: (item, uri) => item.setAttribute("image", uri),
    getCloseViewMenuLabel: () => "close-split",
    getOpenAnotherPDFMenuLabel: () => "open-another",
    getSyncPositionMenuLabel: (side) => `sync-${side}`,
    getSetPrimaryMenuLabel: (menuState) => `primary-${menuState}`,
    getPrimaryMenuConfig: (current, side) => ({
      menuState: current.primarySide
        ? current.primarySide === side
          ? "current"
          : "other"
        : "none",
      disabled: false,
      isCurrentPrimary: current.primarySide === side,
      targetPrimarySide: current.primarySide === side ? null : side,
    }),
    swapPDFs: async (tabID) => events.push(["swap", tabID]),
    separateViews: (tabID, side) => events.push(["separate", tabID, side]),
    closeSide: (tabID, side) => events.push(["close", tabID, side]),
    setPrimarySide: (tabID, side) => {
      events.push(["primary", tabID, side]);
      state.primarySide = side;
    },
    selectAndLoadPDF: async (tabID, side) =>
      events.push(["replace", tabID, side]),
    syncPositionAndScale: (tabID, side) => events.push(["sync", tabID, side]),
    activateSide: (tabID, side) => events.push(["activate", tabID, side]),
    refreshPrimaryMenuItem: (item, tabID, side) =>
      events.push(["refresh", tabID, side, item.attributes.label]),
    schedule: (callback) => scheduled.push(callback),
  });
  const popupset = new Element("popupset");
  return { browser, events, popupset, scheduled, service, windowTimers };
}

test("renders nested reader menu groups and opens at converted screen coordinates", () => {
  const fixture = setup();
  fixture.service.open(fixture.browser, fixture.popupset, {
    x: 5,
    y: 7,
    itemGroups: [
      [
        {
          label: "Tools",
          groups: [[{ label: "Check", checked: true }]],
        },
        { label: "Disabled", disabled: true },
      ],
      [{ label: "Next" }],
    ],
  });

  const popup = fixture.popupset.children[0];
  assert.equal(popup.name, "menupopup");
  assert.equal(popup.children[0].name, "menu");
  assert.equal(
    popup.children[0].children[0].children[0].attributes.checked,
    "true",
  );
  assert.equal(popup.children[1].attributes.label, "Disabled");
  assert.equal(popup.children[2].name, "menuseparator");
  assert.equal(popup.children[3].attributes.label, "Next");
  fixture.scheduled[0]();
  assert.deepEqual(popup.openedAt, [125, 237, true]);
  popup.dispatch("popuphidden");
  assert.equal(fixture.popupset.children.length, 0);
});

test("adds side-specific split commands and activates the pane on popup shown", () => {
  const fixture = setup({ split: true });
  fixture.service.open(fixture.browser, fixture.popupset, {
    x: 0,
    y: 0,
    itemGroups: [],
  });
  const popup = fixture.popupset.children[0];
  const menuItems = popup.children.filter((item) => item.name === "menuitem");

  assert.equal(menuItems.length, 6);
  assert.equal(menuItems[0].attributes.label, "splitview-swap-pdf:");
  assert.equal(menuItems[3].attributes.label, "primary-current");
  assert.equal(menuItems[5].attributes.label, "sync-left");
  for (const item of menuItems) item.dispatch("command");
  popup.dispatch("popupshown");
  fixture.windowTimers[0]();

  assert.deepEqual(
    fixture.events.map(([name]) => name),
    [
      "swap",
      "separate",
      "close",
      "primary",
      "replace",
      "sync",
      "activate",
      "refresh",
    ],
  );
  assert.deepEqual(fixture.events.at(-1), [
    "refresh",
    "split-tab",
    "left",
    "primary-current",
  ]);
});

test("uses the browser-relative fallback when screen conversion is unavailable", () => {
  const fixture = setup({ convertCoordinates: false });
  fixture.service.open(fixture.browser, fixture.popupset, {
    x: 3,
    y: 4,
    itemGroups: [],
  });

  fixture.scheduled[0]();
  assert.deepEqual(fixture.popupset.children[0].openedAt, [23, 34, true]);
});
