const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

test("reader host builds localized config, clones it and runs callbacks after readiness", async () => {
  const calls = [];
  let config;
  let readAloudStatus;
  let ready = 0;
  let menuParams;
  let savedWindow;
  let saveCompleted = 0;
  let contextPaneToggled = 0;
  let launchedURL;
  const zotero = { launchURL: (url) => (launchedURL = url) };
  const win = {
    wrappedJSObject: {
      contextMenuParams: { x: 12 },
      createReader: (value) => (config = value),
    },
  };
  const item = {
    id: 7,
    key: "PDFKEY",
    libraryID: 1,
    library: { libraryType: "user" },
  };
  const callback = () => {};
  const preferences = { get: (key) => (key === "layout" ? "stacked" : key) };
  const { buildSplitReaderConfig } = load(
    "src/modules/splitView/readerConfig.ts",
    { Zotero: zotero },
  );
  const { SplitReaderHost } = load(
    "src/modules/splitView/readerHost.ts",
    {
      Zotero: Object.assign(zotero, {
        API: { getLibraryPrefix: () => "users/1" },
        File: { getContentsFromURL: (url) => `contents:${url}` },
        Prefs: preferences,
        Users: { getCurrentName: () => "Reader" },
        Libraries: { userLibraryID: 1 },
        SyncedSettings: { get: () => [{ id: "theme" }] },
        rtl: false,
        getMainWindow: () => ({ ZoteroContextPane: { collapsed: false } }),
      }),
      Components: { utils: { cloneInto: (value) => value } },
    },
    {
      "../../platform/readerRuntime": {
        readerRuntime: {
          waitForBrowserLoad: async () => calls.push("browser"),
          waitForInternalReader: async () => calls.push("reader"),
        },
      },
      "../../platform/annotationStore": {
        annotationStore: {
          load: async () => [{ id: "annotation" }],
          isReadOnly: () => false,
        },
      },
      "./readerConfig": { buildSplitReaderConfig },
    },
  );
  const host = new SplitReaderHost();
  await host.initialize({
    browser: { contentWindow: win },
    item,
    viewState: { pageIndex: 2 },
    isRight: true,
    getReadAloudConfig: async (ftl, onStatus) => {
      assert.equal(ftl.length, 2);
      readAloudStatus = onStatus;
      return { enableReadAloud: true };
    },
    callbacks: {
      onReadAloudStatus: callback,
      openContextMenu: (params) => (menuParams = params),
      toggleSidebar: callback,
      onViewStateChange: callback,
      saveAnnotations: async (_annotations, done, targetWindow) => {
        savedWindow = targetWindow;
        done();
      },
      deleteAnnotations: callback,
      toggleContextPane: () => contextPaneToggled++,
      afterReady: () => ready++,
    },
  });

  assert.deepEqual(calls, ["browser", "reader"]);
  assert.equal(config.type, "pdf");
  assert.equal(config.data.url, "zotero://attachment/users/1/items/PDFKEY/");
  assert.equal(config.bottomPlaceholderHeight, 0);
  assert.equal(config.contextPaneOpen, true);
  assert.equal(config.showContextPaneToggle, true);
  assert.equal(config.enableReadAloud, true);
  assert.equal(config.fontFamily, "reader.ebookFontFamily");
  assert.equal(config.primaryViewState.pageIndex, 2);
  assert.equal(config.onToggleSidebar, callback);
  assert.equal(typeof readAloudStatus, "function");
  assert.equal(readAloudStatus, callback);
  config.onOpenContextMenu();
  assert.deepEqual(menuParams, { x: 12 });
  await config.onSaveAnnotations([], () => saveCompleted++);
  assert.equal(savedWindow, win);
  assert.equal(saveCompleted, 1);
  config.onToggleContextPane();
  assert.equal(contextPaneToggled, 1);
  config.onOpenLink("https://example.com");
  assert.equal(launchedURL, "https://example.com");
  assert.equal(ready, 1);
});
