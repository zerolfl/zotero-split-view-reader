const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { SplitReaderToolbar } = load("src/modules/splitView/readerToolbar.ts");

function setup(
  state = { toolbarCloseObservers: [], isCleaningUp: false },
  browserAlive = true,
) {
  const events = [];
  let installedOptions;
  const toolbar = new SplitReaderToolbar({
    getState: () => state,
    isBrowserAlive: () => browserAlive,
    hasActiveSplitState: () => true,
    getCloseLabel: () => "Close view",
    closeSide: (...args) => events.push(["close", ...args]),
    installButton: (browser, options) => {
      events.push(["install", browser]);
      installedOptions = options;
      return { disconnect: () => events.push(["disconnect", browser]) };
    },
  });
  return {
    events,
    get installedOptions() {
      return installedOptions;
    },
    state,
    toolbar,
  };
}

test("replaces only the same-side toolbar observer and closes that side", () => {
  let oldDisconnected = 0;
  const setupState = {
    toolbarCloseObservers: [
      { side: "left", observer: { disconnect: () => {} } },
      {
        side: "right",
        observer: { disconnect: () => oldDisconnected++ },
      },
    ],
    isCleaningUp: false,
  };
  const harness = setup(setupState);
  const browser = {};

  harness.toolbar.installCloseButton("tab-1", browser, "right");

  assert.equal(oldDisconnected, 1);
  assert.equal(setupState.toolbarCloseObservers.length, 2);
  assert.equal(setupState.toolbarCloseObservers[0].side, "left");
  assert.equal(setupState.toolbarCloseObservers[1].side, "right");
  assert.deepEqual(harness.events.at(-1), ["install", browser]);
  assert.equal(harness.installedOptions.label, "Close view");
  assert.equal(harness.installedOptions.isActive(), true);
  harness.installedOptions.onClose();
  assert.deepEqual(harness.events.at(-1), ["close", "tab-1", "right"]);
});

test("skips installation when state is missing, cleaning, or browser is dead", () => {
  const missing = setup(null);
  missing.toolbar.installCloseButton("tab-1", {}, "left");
  assert.deepEqual(missing.events, []);

  const cleaning = setup({ toolbarCloseObservers: [], isCleaningUp: true });
  cleaning.toolbar.installCloseButton("tab-1", {}, "left");
  assert.deepEqual(cleaning.events, []);

  const dead = setup(undefined, false);
  dead.toolbar.installCloseButton("tab-1", {}, "left");
  assert.deepEqual(dead.events, []);
});
