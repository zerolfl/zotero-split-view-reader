const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

const { SplitViewNotifications } = load(
  "src/modules/splitView/notifications.ts",
);

function setup() {
  const messages = [];
  const notifications = new SplitViewNotifications({
    getString: (key, options) => JSON.stringify({ key, options }),
    show: (...args) => messages.push(args),
  });
  return { messages, notifications };
}

test("maps split view lifecycle actions to localized notifications", () => {
  const { messages, notifications } = setup();

  notifications.showClosed();
  notifications.showLoadResult(true);
  notifications.showLoadResult(false);
  notifications.showCreated(true);
  notifications.showCreated(false);
  notifications.showSwapped();

  assert.deepEqual(
    messages.map(([text, type, duration]) => [
      JSON.parse(text).key,
      type,
      duration,
    ]),
    [
      ["splitview-closed", "default", 2000],
      ["splitview-loaded", "default", 2000],
      ["splitview-not-found", "error", 2000],
      ["splitview-same-pdf-loaded", "default", 3000],
      ["splitview-loaded", "default", 3000],
      ["splitview-swap-pdf", "default", 2000],
    ],
  );
});

test("reports position sync and a page clamp with the affected side", () => {
  const { messages, notifications } = setup();

  notifications.showPositionSynced("left", null);
  notifications.showPositionSynced("right", { pageIndexClamped: true });

  assert.deepEqual(JSON.parse(messages[0][0]), {
    key: "splitview-position-synced",
  });
  assert.deepEqual(JSON.parse(messages[1][0]), {
    key: "splitview-last-page-reached",
    options: { args: { side: "right" } },
  });
  assert.deepEqual(
    messages.map(([, type, duration]) => [type, duration]),
    [
      ["default", 2000],
      ["default", 2000],
    ],
  );
});
