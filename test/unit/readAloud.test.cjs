const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Blob } = require("node:buffer");
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
  const nativeScope = { Response: globalThis.Response };
  const observers = new Map();
  const globals = {
    Promise,
    URLSearchParams,
    Response: globalThis.Response,
    setTimeout,
    clearTimeout,
    Components: {
      utils: {
        cloneInto: (value) => value,
        getGlobalForObject: () => nativeScope,
      },
    },
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

test("enabled voice sync skips native readers without the backing setter", () => {
  const { platform, globals } = runtime();
  const voices = { en: { standard: ["voice"] } };
  let unsupportedCalls = 0;
  let supportedCalls = 0;
  globals.Zotero.Reader._readers = [
    {
      _handleReadAloudEnabledVoicesChange: () => unsupportedCalls++,
    },
    {
      _internalReader: { setReadAloudEnabledVoices() {} },
      _handleReadAloudEnabledVoicesChange: (value) => {
        assert.strictEqual(value, voices);
        supportedCalls++;
      },
    },
  ];

  platform.syncEnabledVoicesToNativeReaders(voices);

  assert.equal(unsupportedCalls, 0);
  assert.equal(supportedCalls, 1);
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
  for (const fails of [false, true]) {
    mainWindow.caches.open = async () => {
      if (fails) throw new Error("cache unavailable");
      return null;
    };
    const remote = platform.getReadAloudRemoteInterface(targetWindow);
    assert.equal(
      (await remote.getAudio({ text: "text" }, { id: "voice" })).audio,
      "audio",
    );
  }
});

test("audio caching uses the native service Response and opens its cache once", async () => {
  const { platform, targetWindow, mainWindow, globals, api } = runtime();
  const audio = new Blob(["audio"], { type: "audio/wav" });
  api.getReadAloudAudio = async () => ({ audio });
  const stored = [];
  let opened = 0;
  globals.Response = class {
    constructor() {
      throw new Error("plugin realm Response must not be used");
    }
  };
  mainWindow.Response = globals.Response;
  mainWindow.caches.open = async () => {
    opened++;
    return {
      match: async () => null,
      put: async (url, response) => stored.push({ url, response }),
    };
  };
  const remote = platform.getReadAloudRemoteInterface(targetWindow);
  const result = await remote.getAudio({ text: "text" }, { id: "voice" });
  assert.equal(result.audio, audio);
  assert.equal(stored.length, 1);
  assert.equal(
    stored[0].url,
    "https://read-aloud.zotero.invalid/audio?voice=voice&text=text&cacheVersion=undefined&timestamps=1",
  );
  assert.equal(await stored[0].response.text(), "audio");
  await remote.getAudio({ text: "another" }, { id: "voice" });
  assert.equal(opened, 1);
  assert.equal(stored.length, 2);
});

function cachedRuntime() {
  const fixture = runtime();
  const entries = new Map();
  fixture.mainWindow.caches.open = async () => ({
    match: async (url) => entries.get(url)?.clone(),
    put: async (url, response) => entries.set(url, response),
  });
  return { ...fixture, entries };
}

test("cached audio retains timestamps and separates voice cache versions", async () => {
  const { platform, api, targetWindow, entries } = cachedRuntime();
  const timestamps = [{ time: 0.1, start: 0, end: 4 }];
  let requests = 0;
  api.getReadAloudAudio = async () => {
    requests++;
    return { audio: new Blob(["audio"]), timestamps };
  };
  const remote = platform.getReadAloudRemoteInterface(targetWindow);
  const segment = { text: "text" };
  const voice = { id: "voice", cacheVersion: 2 };
  await remote.getAudio(segment, voice);
  const cached = await remote.getAudio(segment, voice);
  assert.equal(requests, 1);
  assert.equal(await cached.audio.text(), "audio");
  assert.deepEqual(JSON.parse(JSON.stringify(cached.timestamps)), timestamps);
  assert.equal(
    [...entries.values()][0].headers.get("X-Zotero-Timestamps"),
    JSON.stringify(timestamps),
  );
  await remote.getAudio(segment, { ...voice, cacheVersion: 3 });
  assert.equal(requests, 2);
  assert.equal(entries.size, 2);
});

test("invalid timestamp headers still return cached audio and report the error", async () => {
  const { platform, globals, api, targetWindow, entries } = cachedRuntime();
  const errors = [];
  globals.Zotero.logError = (error) => errors.push(error);
  api.getReadAloudAudio = async () => assert.fail("audio should be cached");
  entries.set(
    "https://read-aloud.zotero.invalid/audio?voice=voice&text=text&cacheVersion=2&timestamps=1",
    new globalThis.Response("audio", {
      headers: { "X-Zotero-Timestamps": "invalid" },
    }),
  );
  const remote = platform.getReadAloudRemoteInterface(targetWindow);
  const result = await remote.getAudio(
    { text: "text" },
    { id: "voice", cacheVersion: 2 },
  );
  assert.equal(await result.audio.text(), "audio");
  assert.equal(result.timestamps, undefined);
  assert.equal(errors.length, 1);
});

test("noStore audio responses bypass the cache", async () => {
  const { platform, api, targetWindow, entries } = cachedRuntime();
  let requests = 0;
  api.getReadAloudAudio = async () => {
    requests++;
    return { audio: new Blob(["audio"]), noStore: true };
  };
  const remote = platform.getReadAloudRemoteInterface(targetWindow);
  await remote.getAudio({ text: "text" }, { id: "voice" });
  await remote.getAudio({ text: "text" }, { id: "voice" });
  assert.equal(requests, 2);
  assert.equal(entries.size, 0);
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
    {
      "../../platform/readAloud": platform,
      "../../platform/readerReadAloud": load(
        "src/platform/readerReadAloud.ts",
        globals,
      ),
    },
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
