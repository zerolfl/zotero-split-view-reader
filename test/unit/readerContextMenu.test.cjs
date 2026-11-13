const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function setup() {
  const actions = [];
  const menuListeners = new Map();
  const documentListeners = new Map();
  const tabState = {
    isCleaningUp: false,
    activeSide: "left",
    primarySide: "left",
  };
  let alive = true;
  let readerSide = "left";
  let registeredHandler;
  let registeredCount = 0;
  let unregisteredCount = 0;
  const mainWindow = {
    document: {
      addEventListener: (type, handler) => documentListeners.set(type, handler),
    },
    setTimeout: (callback) => callback(),
  };
  const { SplitReaderContextMenu } = load(
    "src/modules/splitView/readerContextMenu.ts",
    {
      Zotero: {
        Reader: {
          registerEventListener: (_type, handler, pluginID) => {
            registeredHandler = handler;
            registeredCount++;
            actions.push(["register", pluginID]);
          },
          unregisterEventListener: (_type, handler) => {
            assert.strictEqual(handler, registeredHandler);
            unregisteredCount++;
          },
        },
        getMainWindow: () => mainWindow,
      },
    },
  );
  const service = new SplitReaderContextMenu({
    isAlive: () => alive,
    getState: (id) => (id === "split" ? tabState : null),
    getReaderSide: () => readerSide,
    getPrimaryMenuConfig: (_state, side) => ({
      menuState: side === "left" ? "current" : "other",
      disabled: false,
      isCurrentPrimary: side === "left",
      targetPrimarySide: side === tabState.primarySide ? null : side,
    }),
    getString: (key) => key,
    getCloseMenuLabel: () => "close",
    getSetPrimaryMenuLabel: (state) => `primary-${state}`,
    getIconURI: (name) => `icon/${name}`,
    setMenuItemIcon: (item, uri) => item.setAttribute("image", uri),
    swapPDFs: async (id) => actions.push(["swap", id]),
    separateViews: (id, side) => actions.push(["separate", id, side]),
    handleSplitView: (reader) => actions.push(["open", reader.tabID]),
    revertToSingleReader: (id, side) => actions.push(["close", id, side]),
    setPrimarySide: (id, side) => actions.push(["primary", id, side]),
    selectAndLoadPDF: async (id, side) => actions.push(["replace", id, side]),
    syncPositionAndScale: (id, side) => actions.push(["sync", id, side]),
    activateSide: (id, side) => actions.push(["activate", id, side]),
    refreshPrimaryMenuItem: (_item, id, side) =>
      actions.push(["refresh", id, side]),
  });

  function createMenuItems(labels) {
    return labels.map((label) => {
      const attributes = new Map([
        ["label", label],
        ["type", "checkbox"],
        ["checked", "true"],
      ]);
      return {
        getAttribute: (name) => attributes.get(name) || null,
        removeAttribute: (name) => attributes.delete(name),
        setAttribute: (name, value) => attributes.set(name, value),
        attributes,
      };
    });
  }

  function createPopup(items) {
    return {
      tagName: "menupopup",
      querySelectorAll: () => items,
      addEventListener: (type, callback) => menuListeners.set(type, callback),
    };
  }

  function buildMenu(tabID = "split") {
    const items = [];
    registeredHandler({
      reader: { tabID },
      append: (...entries) => items.push(...entries),
    });
    return items;
  }

  return {
    actions,
    buildMenu,
    createMenuItems,
    createPopup,
    documentListeners,
    mainWindow,
    menuListeners,
    service,
    setAlive: (value) => (alive = value),
    setReaderSide: (value) => (readerSide = value),
    tabState,
    get registeredCount() {
      return registeredCount;
    },
    get unregisteredCount() {
      return unregisteredCount;
    },
  };
}

test("reader context menu registers once and builds split actions", async () => {
  const harness = setup();
  harness.service.register("plugin-id");
  harness.service.register("plugin-id");
  assert.equal(harness.registeredCount, 1);
  assert.deepEqual(harness.actions[0], ["register", "plugin-id"]);

  const items = harness.buildMenu();
  assert.deepEqual(
    items.map(({ label }) => label),
    [
      "splitview-swap-pdf",
      "splitview-separate-views",
      "close",
      "primary-current",
      "splitview-open-another",
      "splitview-sync-position",
    ],
  );
  await items[0].onCommand();
  items[1].onCommand();
  items[2].onCommand();
  items[3].onCommand();
  await items[4].onCommand();
  items[5].onCommand();
  assert.deepEqual(harness.actions.slice(1), [
    ["swap", "split"],
    ["separate", "split", "left"],
    ["close", "split", "left"],
    ["primary", "split", null],
    ["replace", "split", "left"],
    ["sync", "split", "left"],
  ]);
});

test("reader context menu decorates native items and activates the clicked side", () => {
  const harness = setup();
  harness.service.register("plugin-id");
  harness.buildMenu();
  const labels = ["close", "primary-current", "splitview-swap-pdf"];
  const items = harness.createMenuItems(labels);
  const popup = harness.createPopup(items);
  harness.documentListeners.get("popupshowing")({ target: popup });

  assert.equal(
    items[0].attributes.get("image"),
    "icon/do_not_splitscreen_vertical_24dp.svg",
  );
  assert.equal(items[0].attributes.has("type"), false);
  assert.equal(items[0].attributes.has("checked"), false);
  harness.menuListeners.get("popupshown")();
  assert.deepEqual(harness.actions.slice(-2), [
    ["activate", "split", "left"],
    ["refresh", "split", "left"],
  ]);
});

test("reader context menu handles ordinary tabs, unload and unregister", () => {
  const harness = setup();
  harness.service.register("plugin-id");
  assert.deepEqual(
    harness.buildMenu("ordinary").map(({ label }) => label),
    ["splitview-menu-label"],
  );
  harness.setAlive(false);
  assert.deepEqual(harness.buildMenu(), []);
  harness.service.unregister();
  harness.service.unregister();
  assert.equal(harness.unregisteredCount, 1);
});
