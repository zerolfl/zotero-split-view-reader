const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

test("main window unload uses window cleanup and retains global toolkit services", async () => {
  const events = [];
  const { default: hooks } = load(
    "src/hooks.ts",
    {
      ztoolkit: {
        unregisterAll: () => assert.fail("toolkit must remain registered"),
      },
      addon: {
        data: {
          dialog: {
            window: {
              close: () => assert.fail("unrelated dialog must remain open"),
            },
          },
        },
      },
    },
    {
      "./modules/splitView": {
        SplitViewFactory: {
          unregisterWindow: (win) => events.push(win),
          unregisterAll: () =>
            assert.fail("shared services must remain registered"),
        },
      },
      "./utils/locale": {},
      "./modules/preferenceScript": {},
    },
  );
  const win = {};
  await hooks.onMainWindowUnload(win);
  assert.deepEqual(events, [win]);
});
