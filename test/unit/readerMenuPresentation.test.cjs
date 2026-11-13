const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { ReaderMenuPresentation } = load(
  "src/modules/splitView/readerMenuPresentation.ts",
);

function setup() {
  const strings = [];
  const state = { isCleaningUp: false, primarySide: "left" };
  const presentation = new ReaderMenuPresentation({
    getString: (key, options) => {
      strings.push([key, options]);
      return `${key}:${options?.args?.state || options?.args?.side || ""}`;
    },
    getAddonRef: () => "split-view",
    getState: (tabID) => (tabID === "tab" ? state : null),
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
  });
  const attributes = new Map();
  const item = {
    classList: {
      values: [],
      add(value) {
        this.values.push(value);
      },
    },
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: (key) => attributes.delete(key),
  };
  return { attributes, item, presentation, state, strings };
}

test("localizes menu labels and builds addon icon URIs", () => {
  const { presentation, strings } = setup();

  assert.equal(
    presentation.getCloseViewMenuLabel(),
    "splitview-close-menu-label:",
  );
  assert.equal(
    presentation.getOpenAnotherPDFMenuLabel(),
    "splitview-open-another:",
  );
  assert.equal(
    presentation.getSyncPositionMenuLabel("left"),
    "splitview-sync-position:right",
  );
  assert.equal(
    presentation.getSetPrimaryMenuLabel("none"),
    "splitview-set-primary:none",
  );
  assert.equal(
    presentation.getIconURI("icon.svg"),
    "chrome://split-view/content/icons/icon.svg",
  );
  assert.equal(strings.length, 4);
});

test("styles menu icons and refreshes primary state from the live tab", () => {
  const { attributes, item, presentation } = setup();

  presentation.setMenuItemIcon(item, "icon.svg");
  const config = presentation.refreshPrimaryMenuItem(item, "tab", "left");

  assert.equal(item.classList.values[0], "menuitem-iconic");
  assert.equal(
    attributes.get("image"),
    "chrome://split-view/content/icons/primary_window_24dp.svg",
  );
  assert.equal(
    attributes.get("style"),
    "-moz-context-properties: fill; fill: currentColor;",
  );
  assert.equal(attributes.get("label"), "splitview-set-primary:current");
  assert.equal(attributes.has("disabled"), false);
  assert.equal(config.targetPrimarySide, null);
});

test("ignores menu refresh after its tab enters cleanup", () => {
  const { attributes, item, presentation, state } = setup();
  state.isCleaningUp = true;

  assert.equal(presentation.refreshPrimaryMenuItem(item, "tab", "right"), null);
  assert.equal(
    presentation.refreshPrimaryMenuItem(item, "missing", "right"),
    null,
  );
  assert.equal(attributes.size, 0);
});
