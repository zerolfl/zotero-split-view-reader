const assert = require("node:assert/strict");
const { test } = require("node:test");
const { setTimeout, clearTimeout } = require("node:timers");
const { URLSearchParams } = require("node:url");
const { load } = require("./helpers.cjs");

function runtime() {
  const writes = [];
  const api = {
    getReadAloudVoices: async () => [{ id: "voice" }],
    getReadAloudAudio: async () => ({ audio: "audio" }),
    getReadAloudCreditsRemaining: async () => ({ credits: 5 }),
    resetReadAloudCredits: async () => ({ credits: 0 }),
  };
  const mainWindow = {
    openDialog: () => {},
    caches: { open: async () => null },
  };
  const observers = new Map();
  const globals = {
    Promise,
    URLSearchParams,
    Response: globalThis.Response,
    setTimeout,
    clearTimeout,
    Components: { utils: { cloneInto: (value) => value } },
    PathUtils: { join: (...parts) => parts.join("/") },
    IOUtils: {
      readJSON: async () => ({}),
      writeJSON: async (...args) => writes.push(args),
    },
    Zotero: {
      Profile: { dir: "profile" },
      Sync: {
        APIClient: { prototype: api },
        Runner: { getAPIClient: () => api },
        Data: { Local: { getAPIKey: async () => "key" } },
      },
      Reader: { _readers: [] },
      getMainWindow: () => mainWindow,
      Prefs: {
        get: () => "{}",
        registerObserver: (_key, callback) => {
          const id = Symbol();
          observers.set(id, callback);
          return id;
        },
        unregisterObserver: (id) => observers.delete(id),
      },
      logError: () => {},
    },
  };
  const platform = load("src/platform/readAloud.ts", globals);
  class ContentError extends Error {}
  const targetWindow = { Promise, Error: ContentError };
  return {
    platform,
    globals,
    api,
    mainWindow,
    writes,
    observers,
    targetWindow,
  };
}

test("Zotero 8 sync services alone do not enable Read Aloud", () => {
  const { platform, globals } = runtime();
  globals.Zotero.Sync.APIClient.prototype = {};
  assert.equal(platform.isReadAloudAvailable(), false);
});

test("pausing native readers skips unsupported readers and reports failures", () => {
  const { platform, globals } = runtime();
  const paused = [];
  const errors = [];
  globals.Zotero.Reader._readers = [
    { toggleReadAloudPaused: (value) => paused.push(value) },
    null,
    {
      toggleReadAloudPaused: () => {
        throw new Error("reader closing");
      },
    },
  ];
  globals.Zotero.logError = (error) => errors.push(error.message);

  platform.pauseNativeReaders();

  assert.deepEqual(paused, [true]);
  assert.deepEqual(errors, ["reader closing"]);
});

test("all remote operations reject in the content realm on API failure", async () => {
  const { platform, api, targetWindow } = runtime();
  for (const key of Object.keys(api)) {
    api[key] = async () => {
      throw new Error("offline");
    };
  }
  const remote = platform.getReadAloudRemoteInterface(targetWindow);
  for (const operation of [
    () => remote.getVoices(),
    () => remote.getAudio({ text: "text" }, { id: "voice" }),
    () => remote.getCreditsRemaining(),
    () => remote.resetCredits(),
  ]) {
    await assert.rejects(operation, (error) => {
      assert.ok(error instanceof targetWindow.Error);
      assert.equal(error.message, "offline");
      return true;
    });
  }
});

test("missing or rejected cache still falls back to the audio API", async () => {
  const { platform, targetWindow, mainWindow } = runtime();
  const remote = platform.getReadAloudRemoteInterface(targetWindow);
  assert.equal(
    (await remote.getAudio({ text: "text" }, { id: "voice" })).audio,
    "audio",
  );
  mainWindow.caches.open = async () => {
    throw new Error("cache unavailable");
  };
  assert.equal(
    (await remote.getAudio({ text: "text" }, { id: "voice" })).audio,
    "audio",
  );
});

test("voice write observation filters paths and restores its own wrapper", async () => {
  const { platform, globals, writes } = runtime();
  const original = globals.IOUtils.writeJSON;
  const notifications = [];
  const dispose = platform.observeEnabledVoicesWrites((value) =>
    notifications.push(value),
  );
  await globals.IOUtils.writeJSON("other.json", { other: true });
  const voices = { en: { standard: ["voice"] } };
  await globals.IOUtils.writeJSON(
    "profile/readAloudEnabledVoices.json",
    voices,
  );
  assert.deepEqual(notifications, [voices]);
  assert.equal(writes.length, 2);
  dispose();
  assert.equal(globals.IOUtils.writeJSON, original);
});

test("disposing an older hook preserves a later wrapper without stale callbacks", async () => {
  const { platform, globals, writes } = runtime();
  let notified = false;
  const dispose = platform.observeEnabledVoicesWrites(() => {
    notified = true;
  });
  const captured = globals.IOUtils.writeJSON;
  const laterWrapper = (...args) => captured(...args);
  globals.IOUtils.writeJSON = laterWrapper;
  dispose();
  assert.equal(globals.IOUtils.writeJSON, laterWrapper);
  await globals.IOUtils.writeJSON("profile/readAloudEnabledVoices.json", {});
  assert.equal(writes.length, 1);
  assert.equal(notified, false);
});

test("service registration is idempotent and unregister cancels queued dialogs", async () => {
  const { platform, globals, mainWindow, observers, targetWindow } = runtime();
  const { SplitReadAloudService } = load(
    "src/modules/splitView/readAloud.ts",
    globals,
    { "../../platform/readAloud": platform },
  );
  let opened = 0;
  mainWindow.openDialog = () => opened++;
  const browser = { contentWindow: targetWindow };
  const service = new SplitReadAloudService({
    states: () => [],
    getReader: () => null,
    isActive: () => true,
  });
  const original = globals.IOUtils.writeJSON;
  service.register();
  const wrapper = globals.IOUtils.writeJSON;
  service.register();
  assert.equal(observers.size, 1);
  assert.equal(globals.IOUtils.writeJSON, wrapper);
  const config = await service.getReaderConfig(browser, [], () => {});
  config.onOpenReadAloudFirstRunPopup({ lang: "en" });
  service.unregister();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(opened, 0);
  assert.equal(observers.size, 0);
  assert.equal(globals.IOUtils.writeJSON, original);
});
