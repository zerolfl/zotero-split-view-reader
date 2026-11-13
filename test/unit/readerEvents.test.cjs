const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function loadAdapter(reader) {
  return load("src/platform/readerEvents.ts", { Zotero: { Reader: reader } });
}

test("uses plugin-scoped cleanup when Zotero 8/9 public cleanup is inverted", () => {
  const removedByPluginID = [];
  const reader = {
    _registeredListeners: [],
    registerEventListener(type, handler, pluginID) {
      this._registeredListeners.push({ type, handler, pluginID });
    },
    unregisterEventListener(type, handler) {
      this._registeredListeners = this._registeredListeners.filter(
        (entry) => entry.type === type && entry.handler === handler,
      );
    },
    _unregisterEventListenerByPluginID(pluginID) {
      removedByPluginID.push(pluginID);
      this._registeredListeners = this._registeredListeners.filter(
        (entry) => entry.pluginID !== pluginID,
      );
    },
  };
  const { registerReaderEventListener } = loadAdapter(reader);
  const otherHandler = () => {};
  const pluginHandler = () => {};
  reader.registerEventListener("createViewContextMenu", otherHandler, "other");

  const dispose = registerReaderEventListener(
    "createViewContextMenu",
    pluginHandler,
    "addon-id",
  );
  assert.equal(reader._registeredListeners.length, 2);
  assert.equal(reader._registeredListeners[1].pluginID, "addon-id");

  dispose();
  dispose();

  assert.deepEqual(removedByPluginID, ["addon-id"]);
  assert.deepEqual(
    reader._registeredListeners.map((entry) => entry.handler),
    [otherHandler],
  );
});

test("falls back to public cleanup when the plugin-scoped method is absent", () => {
  let listeners = [];
  let removed = 0;
  const reader = {
    registerEventListener(type, handler, pluginID) {
      listeners.push({ type, handler, pluginID });
    },
    unregisterEventListener(type, handler) {
      removed++;
      listeners = listeners.filter(
        (entry) => entry.type !== type || entry.handler !== handler,
      );
    },
  };
  const { registerReaderEventListener } = loadAdapter(reader);
  const handler = () => {};
  const dispose = registerReaderEventListener("event", handler, "addon-id");

  dispose();

  assert.equal(removed, 1);
  assert.deepEqual(listeners, []);
});
