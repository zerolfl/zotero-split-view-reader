import { assert } from "chai";
import { config } from "../package.json";
import { SplitViewFactory } from "../src/modules/splitView";
import { readerRuntime } from "../src/platform/readerRuntime";
import { readerView } from "../src/platform/readerView";
import { annotationStore } from "../src/platform/annotationStore";
import { readerReadAloud } from "../src/platform/readerReadAloud";
import { findReaderZoomButton } from "../src/platform/readerToolbar";
import { getPref, setPref } from "../src/utils/prefs";
import { createPDFAttachment } from "./fixtures/pdf";

describe("split reader integration", function () {
  this.timeout(30000);
  const factory = SplitViewFactory as any;
  let left: Zotero.Item;
  let right: Zotero.Item;
  let globals: Record<string, PropertyDescriptor | undefined>;
  let errors: string[];
  let logError: typeof Zotero.logError;

  before(async function () {
    const instance = Zotero[config.addonInstance];
    globals = {};
    for (const [name, value] of Object.entries({
      addon: instance,
      ztoolkit: instance.data.ztoolkit,
    })) {
      globals[name] = Object.getOwnPropertyDescriptor(window, name);
      Object.defineProperty(window, name, { configurable: true, value });
    }
    left = await createPDFAttachment("Left PDF");
    right = await createPDFAttachment("Right PDF");
  });

  beforeEach(function () {
    errors = [];
    logError = Zotero.logError;
    Zotero.logError = (error: any) => {
      errors.push(String(error));
      logError.call(Zotero, error);
    };
  });

  afterEach(async function () {
    Zotero.logError = logError;
    for (const tabID of [...factory.stateStore.keys()])
      factory.tabCleanup.cleanupAndSave(tabID);
    const tabs = Zotero.getMainWindow().Zotero_Tabs;
    for (const tab of [...(tabs as any)._tabs]) {
      if (tab.type.startsWith("reader")) tabs.close(tab.id);
    }
    await Zotero.Promise.delay(100);
  });

  after(function () {
    factory.tabNotifier.unregister();
    for (const [name, descriptor] of Object.entries(globals)) {
      if (descriptor) Object.defineProperty(window, name, descriptor);
      else delete (window as any)[name];
    }
  });

  async function open(samePDF: boolean) {
    const reader = await Zotero.Reader.open(left.id);
    assert.ok(reader);
    await readerRuntime.waitForReaderReady(reader);
    if (samePDF) await factory.conversion.convertSamePDF(reader);
    else await factory.conversion.convertDifferentPDF(reader, right);
    const state = factory.stateStore.get(reader!.tabID);
    assert.ok(state);
    await Zotero.Promise.delay(700);
    return state;
  }

  function setPrimarySide(tabID: string, side: "left" | "right" | null) {
    factory.primaryView.setSide(tabID, side);
  }

  async function waitFor(
    check: () => boolean,
    label = "reader state",
  ): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await Zotero.Promise.delay(30);
    }
    assert.fail(`Timed out waiting for ${label}: ${errors.join("; ")}`);
  }

  function contentData(browser: XULBrowserElement, value: any): any {
    return Components.utils.cloneInto(value, browser.contentWindow!, {
      wrapReflectors: true,
    });
  }

  function addNote(state: any, side: "left" | "right") {
    const browser = state[`${side}Browser`];
    const reader = readerRuntime.getInternalReaderFromBrowser(browser);
    reader._annotationManager._skipAnnotationSavingDebounce = true;
    return reader._annotationManager.addAnnotation(
      contentData(browser, {
        type: "note",
        color: "#ffd400",
        sortIndex: "00000|000001|00000",
        pageLabel: "1",
        comment: "Initial comment",
        position: { pageIndex: 0, rects: [[72, 700, 92, 720]] },
      }),
    );
  }

  it("creates two PDF readers and keeps page positions independent without a primary side", async function () {
    const state = await open(false);
    const first = readerRuntime.getInternalReaderFromBrowser(state.leftBrowser);
    const second = readerRuntime.getInternalReaderFromBrowser(
      state.rightBrowser,
    );
    assert.equal(readerView.getPdfViewerFromReader(first).pagesCount, 2);
    assert.equal(readerView.getPdfViewerFromReader(second).pagesCount, 2);
    setPrimarySide(state.tabID, null);
    const result = await readerView.applyViewStateToReader(first, {
      pageIndex: 1,
      scale: 100,
    });
    assert.isFalse(result!.pageIndexClamped);
    await Zotero.Promise.delay(150);
    assert.equal(
      readerView.getImmediateViewStateFromReader(first).pageIndex,
      1,
    );
    assert.equal(
      readerView.getImmediateViewStateFromBrowser(state.rightBrowser).pageIndex,
      0,
      "right position remains independent before saving",
    );
    assert.equal(
      readerView.getImmediateViewStateFromReader(second).pageIndex,
      0,
    );
  });

  it("opens the same attachment twice and persists both sides in tab data", async function () {
    const state = await open(true);
    assert.isTrue(state.isSamePDF);
    assert.equal(state.leftItemID, left.id);
    assert.equal(state.rightItemID, left.id);
    const data = (Zotero.getMainWindow().Zotero_Tabs as any)._getTab(
      state.tabID,
    ).tab.data;
    assert.isTrue(data.isSplitView);
    assert.equal(data.leftItemID, data.rightItemID);
    assert.notEqual(state.leftBrowser, state.rightBrowser);
  });

  it("adds a localized close button beside each reader's find control", async function () {
    const state = await open(false);
    for (const side of ["left", "right"] as const) {
      const browser = state[`${side}Browser`];
      const document = (browser.contentWindow as any).wrappedJSObject.document;
      const findButton = document.querySelector(
        ".toolbar .end .toolbar-button.find",
      );
      const closeButton = document.getElementById(`split-view-close-${side}`);

      assert.ok(findButton);
      assert.ok(closeButton);
      assert.strictEqual(findButton.nextElementSibling, closeButton);
      assert.equal(
        closeButton.getAttribute("aria-label"),
        factory.menuPresentation.getCloseViewMenuLabel(),
      );
      assert.ok(document.getElementById("split-view-close-button-style"));
    }
  });

  it("applies the primary scrollbar color only to the selected reader", async function () {
    const state = await open(false);
    const getScrollbarStyle = (browser: XULBrowserElement) => {
      const reader = readerRuntime.getInternalReaderFromBrowser(browser);
      const win = reader._primaryView._iframe.contentWindow;
      const document = (win as any).wrappedJSObject?.document || win.document;
      return document.getElementById("split-view-scrollbar-style");
    };

    await waitFor(() => !!getScrollbarStyle(state.leftBrowser));
    assert.isNull(getScrollbarStyle(state.rightBrowser));
    setPrimarySide(state.tabID, "right");
    assert.isNull(getScrollbarStyle(state.leftBrowser));
    await waitFor(() => !!getScrollbarStyle(state.rightBrowser));
    assert.ok(getScrollbarStyle(state.rightBrowser));
    setPrimarySide(state.tabID, null);
    assert.isNull(getScrollbarStyle(state.leftBrowser));
    assert.isNull(getScrollbarStyle(state.rightBrowser));
  });

  it("updates supported reader voice settings and tolerates missing controls", async function () {
    const state = await open(false);
    const voices = { en: { voice: "test-voice", speed: 1 } };
    const supportsReadAloud = Number.parseInt(Zotero.version) >= 9;

    for (const browser of [state.leftBrowser, state.rightBrowser]) {
      const reader = readerRuntime.getInternalReaderFromBrowser(browser);
      const win = browser.contentWindow!;
      assert.equal(
        typeof reader.setReadAloudVoices,
        supportsReadAloud ? "function" : "undefined",
      );
      readerReadAloud.setVoices(reader, win, voices);
      readerReadAloud.setEnabledVoices(reader, win, {});
      readerReadAloud.togglePaused(reader, true);

      if (supportsReadAloud) {
        const selected = reader._state.readAloudVoices.get("en");
        assert.equal(selected.voice, "test-voice");
        selected.speed = 2;
        assert.equal(voices.en.speed, 1);
      }
    }
  });

  it("releases Ctrl in the reader toolbar document", async function () {
    const state = await open(false);
    for (const browser of [state.leftBrowser, state.rightBrowser]) {
      const win = (browser.contentWindow as any).wrappedJSObject;
      win.document.querySelector(".toolbar-button.find").focus();
      const input = Components.classes[
        "@mozilla.org/text-input-processor;1"
      ].createInstance(Components.interfaces.nsITextInputProcessor);
      assert.isTrue(input.beginInputTransactionForTests(browser.contentWindow));
      const control = () =>
        new KeyboardEvent("", {
          key: "Control",
          code: "ControlLeft",
          keyCode: 17,
        });
      try {
        input.keydown(control());
        assert.isTrue(state.ctrlPressed, "reader keydown records Ctrl");
      } finally {
        input.keyup(control());
      }
      assert.isFalse(state.ctrlPressed, "reader keyup releases Ctrl");
    }
  });

  describe("read aloud bridge regressions", function () {
    it("registers PDF scroll listeners without privileged option warnings", async function () {
      const warnings: string[] = [];
      const listener = {
        observe(message: any) {
          const text = String(message.message);
          if (
            text.includes("Security wrapper denied access") &&
            text.includes('"capture"')
          )
            warnings.push(text);
        },
      };
      Services.console.registerListener(listener);
      try {
        const state = await open(false);
        setPrimarySide(state.tabID, "right");
        await Zotero.Promise.delay(100);
        assert.deepEqual(warnings, []);
      } finally {
        Services.console.unregisterListener(listener);
      }
    });

    it("loads native Read Aloud text for each split attachment", async function () {
      this.timeout(60000);
      if (typeof (Zotero as any).SDT?.getPack !== "function") this.skip();
      const state = await open(false);
      for (const browser of [state.leftBrowser, state.rightBrowser]) {
        const reader = readerRuntime.getInternalReaderFromBrowser(browser);
        assert.isFunction(
          reader._getSDTPack,
          "Reader has its native text provider",
        );
        const result = await reader._getSDTPack(contentData(browser, {}));
        assert.isTrue(result.ok, JSON.stringify(result));
        assert.isAbove(result.bytes.byteLength, 0);
        readerReadAloud.setVoices(reader, browser.contentWindow!, {
          en: { voice: "test-voice", speed: 1 },
        });
        const document = (browser.contentWindow as any).wrappedJSObject
          .document;
        const button = document.getElementById("read-aloud");
        assert.ok(button);
        button.click();
        for (
          let attempt = 0;
          attempt < 500 && !reader._state.readAloudState.lang;
          attempt++
        )
          await Zotero.Promise.delay(30);
        assert.isNotEmpty(
          reader._state.readAloudState.lang,
          "Read Aloud finishes text preparation",
        );
        reader.toggleReadAloudPopup(false);
      }
    });

    it("decodes bridged audio for extracted text and pauses the other side", async function () {
      this.timeout(60000);
      if (Number.parseInt(Zotero.version) < 9) this.skip();
      const runner = (Zotero.Sync as any).Runner;
      const originalClient = runner.getAPIClient;
      const requests: { text: string; voice: string }[] = [];
      const restoreAudio: (() => void)[] = [];
      const wav = new ArrayBuffer(44 + 8000 * 2 * 4);
      const header = new DataView(wav);
      const write = (offset: number, value: string) => {
        for (let i = 0; i < value.length; i++)
          header.setUint8(offset + i, value.charCodeAt(i));
      };
      write(0, "RIFF");
      header.setUint32(4, wav.byteLength - 8, true);
      write(8, "WAVEfmt ");
      header.setUint32(16, 16, true);
      header.setUint16(20, 1, true);
      header.setUint16(22, 1, true);
      header.setUint32(24, 8000, true);
      header.setUint32(28, 16000, true);
      header.setUint16(32, 2, true);
      header.setUint16(34, 16, true);
      write(36, "data");
      header.setUint32(40, wav.byteLength - 44, true);
      const audio = new (Zotero.getMainWindow() as any).Blob([wav], {
        type: "audio/wav",
      });
      runner.getAPIClient = () => ({
        getReadAloudVoices: async () => ({
          voices: {
            standard: [
              {
                creditsPerMinute: 1,
                segmentGranularity: "paragraph",
                cacheVersion: 1,
                voices: { "split-test": { label: "Test" } },
                locales: { "en-US": { default: ["split-test"], other: [] } },
              },
            ],
          },
          standardCreditsRemaining: 100,
          premiumCreditsRemaining: 100,
          devMode: false,
        }),
        getReadAloudAudio: async (segment: any, voice: string) => {
          requests.push({ text: segment.text, voice });
          return { audio: audio.slice() };
        },
        getReadAloudCreditsRemaining: async () => ({
          standardCreditsRemaining: 100,
          premiumCreditsRemaining: 100,
        }),
      });
      try {
        const state = await open(false);
        let previous: any;
        for (const browser of [state.leftBrowser, state.rightBrowser]) {
          const reader = readerRuntime.getInternalReaderFromBrowser(browser);
          const win = (browser.contentWindow as any).wrappedJSObject;
          const originalAudioContext = win.AudioContext;
          win.AudioContext = new win.Function(`
            return class extends OfflineAudioContext {
              constructor() { super(1, 44100 * 4, 44100); }
              resume() { return Promise.resolve(); }
              close() { return Promise.resolve(); }
            };
          `)();
          restoreAudio.push(() => {
            reader.toggleReadAloudPopup(false);
            win.AudioContext = originalAudioContext;
          });
          readerReadAloud.setVoices(reader, browser.contentWindow!, {
            en: { voice: "split-test", speed: 1 },
          });
          reader._updateState(contentData(browser, { loggedIn: true }));
          const document = (browser.contentWindow as any).wrappedJSObject
            .document;
          document.getElementById("read-aloud").click();
          const playback = () => {
            const current =
              reader._readAloudManager || reader._state.readAloudState;
            return {
              active: current.active,
              paused: current.paused,
              lang: current.lang,
              voice: current.selectedVoiceID ?? current.voice,
              activeSegment: current.activeSegment,
              segments: current.segments,
              buffering: current.buffering ?? current.controller?.buffering,
              error: current.error ?? current.controller?.error ?? null,
            };
          };
          for (
            let i = 0;
            i < 500 &&
            !(playback().activeSegment && playback().buffering === false);
            i++
          )
            await Zotero.Promise.delay(30);
          const manager = playback();
          assert.isNull(manager.error);
          assert.ok(
            manager.activeSegment,
            JSON.stringify({
              message: "decoded audio starts playing",
              lang: manager.lang,
              voice: manager.voice,
              active: manager.active,
              paused: manager.paused,
              segments: manager.segments?.length,
              builtSegments: reader._readAloudSegments?.segments?.length,
              firstRun: reader._state.readAloudFirstRunPopup,
              requests,
              errors,
            }),
          );
          assert.include(
            manager.activeSegment.text,
            "Split view compatibility test",
          );
          assert.equal(manager.voice, "split-test");
          assert.isFalse(manager.paused);
          assert.isFalse(manager.buffering);
          await Zotero.Promise.delay(300);
          assert.isNull(
            document.querySelector(".read-aloud-popup .loading-spinner"),
          );
          if (previous)
            assert.isTrue(
              (previous._readAloudManager || previous._state.readAloudState)
                .paused,
            );
          previous = reader;
        }
        assert.isAbove(requests.length, 0);
        assert.isTrue(requests.every(({ voice }) => voice === "split-test"));
        const cache = await (Zotero.getMainWindow() as any).caches.open(
          "read-aloud",
        );
        assert.isAbove((await cache.keys()).length, 0, errors.join("; "));
        previous.toggleReadAloudPaused(true);
        assert.isTrue(
          (previous._readAloudManager || previous._state.readAloudState).paused,
        );
      } finally {
        for (const restore of restoreAudio) restore();
        runner.getAPIClient = originalClient;
      }
    });
  });

  describe("reader interactions", function () {
    let followFocus: boolean;

    beforeEach(function () {
      followFocus = getPref("followFocusPrimary");
      setPref("followFocusPrimary", false);
    });

    afterEach(function () {
      setPref("followFocusPrimary", followFocus);
    });

    async function prepare() {
      const state = await open(false);
      setPrimarySide(state.tabID, null);
      const readers = [state.leftBrowser, state.rightBrowser].map((browser) =>
        readerRuntime.getInternalReaderFromBrowser(browser),
      );
      for (const reader of readers)
        await readerView.applyViewStateToReader(reader, {
          pageIndex: 0,
          scale: 100,
        });
      const containers = [state.leftBrowser, state.rightBrowser].map(
        (browser) => readerView.getViewerContainerFromBrowser(browser)!,
      );
      containers[0].scrollTo(0, 100);
      containers[1].scrollTo(0, 200);
      await Zotero.Promise.delay(250);
      setPrimarySide(state.tabID, "left");
      return { state, readers, containers };
    }

    it("syncs actual scroll deltas from either primary side and stops with no primary", async function () {
      const {
        state,
        containers: [first, second],
      } = await prepare();
      const initialRight = second.scrollTop;
      const initialLeft = first.scrollTop;
      first.scrollTop += 80;
      await waitFor(() => Math.abs(second.scrollTop - initialRight - 80) <= 1);
      setPrimarySide(state.tabID, "right");
      second.scrollTop += 50;
      await waitFor(() => Math.abs(first.scrollTop - initialLeft - 130) <= 1);
      setPrimarySide(state.tabID, null);
      const independent = second.scrollTop;
      first.scrollTop += 40;
      await Zotero.Promise.delay(200);
      assert.equal(second.scrollTop, independent);
    });

    it("forwards native toolbar zoom only from the primary side", async function () {
      const { state, readers } = await prepare();
      const scale = (index: number) =>
        readerView.getPdfViewerFromReader(readers[index]).currentScale;
      const clickZoom = (browser: XULBrowserElement) => {
        const button = findReaderZoomButton(browser, "in") as HTMLElement;
        assert.ok(button);
        button.click();
      };
      const original = scale(0);
      clickZoom(state.leftBrowser);
      await waitFor(() => scale(0) > original && scale(1) > original);
      assert.closeTo(scale(0), scale(1), 0.001);
      await Zotero.Promise.delay(200);
      const leftScale = scale(0);
      const rightScale = scale(1);
      clickZoom(state.rightBrowser);
      await waitFor(() => scale(1) > rightScale);
      assert.equal(scale(0), leftScale);
      setPrimarySide(state.tabID, null);
      const independent = scale(1);
      clickZoom(state.leftBrowser);
      await waitFor(() => scale(0) > leftScale);
      assert.equal(scale(1), independent);
    });

    it("links native sidebar buttons only from the primary side", async function () {
      const { state, readers } = await prepare();
      const toggle = (browser: XULBrowserElement) => {
        const document = (browser.contentWindow as any).wrappedJSObject
          .document;
        const button = document.querySelector(".toolbar-button.sidebar-toggle");
        assert.ok(button);
        button.click();
      };
      const original = readers[0]._state.sidebarOpen;
      toggle(state.leftBrowser);
      await waitFor(() =>
        readers.every((reader) => reader._state.sidebarOpen === !original),
      );
      await waitFor(() => !state.syncPaused);
      toggle(state.rightBrowser);
      await waitFor(() => readers[1]._state.sidebarOpen === original);
      assert.equal(readers[0]._state.sidebarOpen, !original);
      setPrimarySide(state.tabID, null);
      toggle(state.leftBrowser);
      await waitFor(() => readers[0]._state.sidebarOpen === original);
      assert.equal(readers[1]._state.sidebarOpen, original);
    });

    it("follows actual reader focus only when enabled and preserves no-primary mode", async function () {
      const { state } = await prepare();
      const focus = (browser: XULBrowserElement) => {
        Zotero.getMainWindow().focus();
        browser.focus();
        const document = (browser.contentWindow as any).wrappedJSObject
          .document;
        document.querySelector(".toolbar-button.find").focus();
      };
      focus(state.rightBrowser);
      await waitFor(
        () => state.activeSide === "right",
        "right focus with following disabled",
      );
      assert.equal(state.primarySide, "left");
      setPref("followFocusPrimary", true);
      focus(state.leftBrowser);
      await waitFor(
        () => state.activeSide === "left",
        "left focus with following enabled",
      );
      focus(state.rightBrowser);
      await waitFor(
        () => state.primarySide === "right",
        "right primary from focus",
      );
      setPrimarySide(state.tabID, null);
      focus(state.leftBrowser);
      await waitFor(
        () => state.activeSide === "left",
        "left focus with no primary",
      );
      assert.isNull(state.primarySide);
    });

    it("aligns a reader's position and scale to the other pane", async function () {
      const { state, readers } = await prepare();
      setPrimarySide(state.tabID, null);
      await readerView.applyViewStateToReader(readers[1], {
        pageIndex: 1,
        scale: 125,
      });
      await factory.sync.syncPositionAndScale(state.tabID, "left");
      await waitFor(() => !state.syncPaused);
      const first = readerView.getImmediateViewStateFromReader(readers[0]);
      const second = readerView.getImmediateViewStateFromReader(readers[1]);
      assert.equal(first.pageIndex, second.pageIndex);
      assert.equal(first.scale, second.scale);
      assert.closeTo(first.top, second.top, 2);
      assert.closeTo(first.left, second.left, 2);
    });

    it("cancels a native separator drag with Escape and persists only on release", async function () {
      const { state } = await prepare();
      const win = Zotero.getMainWindow();
      const resizer = state.container.querySelector(".split-view-resizer");
      const box = resizer.parentElement.getBoundingClientRect();
      assert.isAbove(box.width, 400);
      const original = state.splitRatio;
      const tabs = win.Zotero_Tabs as any;
      const savedRatio = () => tabs._getTab(state.tabID).tab.data.splitRatio;
      const drag = (ratio: number) => {
        const rect = resizer.getBoundingClientRect();
        win.windowUtils.sendMouseEvent(
          "mousedown",
          rect.x,
          rect.y + rect.height / 2,
          0,
          1,
          0,
        );
        assert.ok(state.dragOverlay);
        win.windowUtils.sendMouseEvent(
          "mousemove",
          box.x + box.width * ratio,
          rect.y + rect.height / 2,
          0,
          0,
          0,
        );
      };
      drag(0.65);
      await waitFor(() => state.splitRatio > original);
      assert.equal(savedRatio(), original);
      const input = Components.classes[
        "@mozilla.org/text-input-processor;1"
      ].createInstance(Components.interfaces.nsITextInputProcessor);
      assert.isTrue(input.beginInputTransactionForTests(win));
      const escape = () =>
        new KeyboardEvent("", { key: "Escape", code: "Escape", keyCode: 27 });
      input.keydown(escape());
      input.keyup(escape());
      await waitFor(() => !state.dragOverlay);
      assert.equal(state.splitRatio, original);
      assert.equal(savedRatio(), original);
      drag(0.6);
      await waitFor(() => state.splitRatio > original);
      const changed = state.splitRatio;
      win.windowUtils.sendMouseEvent(
        "mouseup",
        box.x + box.width * changed,
        box.y + box.height / 2,
        0,
        1,
        0,
      );
      await waitFor(() => !state.dragOverlay);
      assert.equal(savedRatio(), changed);
    });
  });

  it("restores different positions of the same PDF and explicit primary and focus settings", async function () {
    const state = await open(true);
    setPrimarySide(state.tabID, null);
    const first = readerRuntime.getInternalReaderFromBrowser(state.leftBrowser);
    const second = readerRuntime.getInternalReaderFromBrowser(
      state.rightBrowser,
    );
    await readerView.applyViewStateToReader(second, {
      pageIndex: 0,
      scale: 100,
    });
    await readerView.applyViewStateToReader(first, {
      pageIndex: 1,
      scale: 125,
    });
    assert.equal(
      readerView.getImmediateViewStateFromReader(first).pageIndex,
      1,
    );
    state.splitRatio = 0.35;
    state.activeSide = "right";
    factory.session.writeTab(state.tabID);
    const tabs = Zotero.getMainWindow().Zotero_Tabs as any;
    const saved = JSON.parse(
      JSON.stringify(tabs._getTab(state.tabID).tab.data),
    );
    assert.equal(saved.leftViewState.pageIndex, 1, "saved left position");
    assert.equal(saved.rightViewState.pageIndex, 0, "saved right position");
    factory.tabCleanup.cleanupAndSave(state.tabID);
    tabs.close(state.tabID);
    const ordinary = await Zotero.Reader.open(left.id);
    await readerRuntime.waitForReaderReady(ordinary);
    tabs.setTabData(ordinary!.tabID, saved);
    await factory.sessionRestore.restore(ordinary!.tabID, saved);
    const restored = factory.stateStore.get(ordinary!.tabID);
    assert.strictEqual(restored.primarySide, null);
    assert.equal(restored.activeSide, "right");
    assert.equal(restored.splitRatio, 0.35);
    assert.equal(
      readerView.getImmediateViewStateFromBrowser(restored.leftBrowser)
        .pageIndex,
      1,
    );
    assert.equal(
      readerView.getImmediateViewStateFromBrowser(restored.rightBrowser)
        .pageIndex,
      0,
      "restored right position",
    );
  });

  it("mirrors same-PDF annotations and selections and persists changes from either side", async function () {
    const state = await open(true);
    const first = readerRuntime.getInternalReaderFromBrowser(state.leftBrowser);
    const second = readerRuntime.getInternalReaderFromBrowser(
      state.rightBrowser,
    );
    const note = addNote(state, "left");
    assert.ok(
      second._state.annotations.find((item: any) => item.id === note.id),
      errors.join("; "),
    );
    await waitFor(
      () => !!Zotero.Items.getByLibraryAndKey(left.libraryID, note.id),
    );
    first.setSelectedAnnotations(contentData(state.leftBrowser, [note.id]));
    assert.deepEqual(Array.from(second._state.selectedAnnotationIDs), [
      note.id,
    ]);
    second._annotationManager._skipAnnotationSavingDebounce = true;
    second._annotationManager.updateAnnotations(
      contentData(state.rightBrowser, [
        { id: note.id, comment: "Edited on right" },
      ]),
    );
    assert.equal(
      first._state.annotations.find((item: any) => item.id === note.id).comment,
      "Edited on right",
    );
    await waitFor(
      () =>
        (
          Zotero.Items.getByLibraryAndKey(
            left.libraryID,
            note.id,
          ) as Zotero.Item
        )?.annotationComment === "Edited on right",
    );
    await waitFor(() => !second._annotationManager._savingInProgress);
    second._annotationManager.deleteAnnotations(
      contentData(state.rightBrowser, [note.id]),
    );
    assert.isFalse(
      first._state.annotations.some((item: any) => item.id === note.id),
    );
    await waitFor(
      () => !Zotero.Items.getByLibraryAndKey(left.libraryID, note.id),
    );
  });

  it("does not mirror annotations between different PDFs or delete another attachment's annotation", async function () {
    const state = await open(false);
    const note = addNote(state, "left");
    const second = readerRuntime.getInternalReaderFromBrowser(
      state.rightBrowser,
    );
    assert.isFalse(
      second._state.annotations.some((item: any) => item.id === note.id),
    );
    await waitFor(
      () => !!Zotero.Items.getByLibraryAndKey(left.libraryID, note.id),
    );
    await annotationStore.remove(right.id, [note.id]);
    assert.ok(Zotero.Items.getByLibraryAndKey(left.libraryID, note.id));
  });

  it("swaps different PDFs together with their view positions and session data", async function () {
    const state = await open(false);
    setPrimarySide(state.tabID, null);
    factory.interactions.activateSide(
      state.tabID,
      "right",
      Zotero.getMainWindow(),
    );

    const oldLeft = readerRuntime.getInternalReaderFromBrowser(
      state.leftBrowser,
    );
    const oldRight = readerRuntime.getInternalReaderFromBrowser(
      state.rightBrowser,
    );
    await readerView.applyViewStateToReader(oldLeft, {
      pageIndex: 1,
      scale: 100,
    });
    await readerView.applyViewStateToReader(oldRight, {
      pageIndex: 0,
      scale: 100,
    });
    await Zotero.Promise.delay(400);

    assert.equal(
      readerView.getImmediateViewStateFromReader(oldLeft).pageIndex,
      1,
    );
    assert.equal(
      readerView.getImmediateViewStateFromReader(oldRight).pageIndex,
      0,
    );
    assert.equal(
      readerView.getCurrentViewStateFromBrowser(state.leftBrowser).pageIndex,
      1,
    );
    assert.equal(
      readerView.getCurrentViewStateFromBrowser(state.rightBrowser).pageIndex,
      0,
    );
    await factory.pdfSwap.swap(state.tabID);

    assert.equal(state.leftItemID, right.id);
    assert.equal(state.rightItemID, left.id);
    assert.strictEqual(state.primarySide, null);
    assert.equal(state.activeSide, "right");
    assert.equal(
      readerView.getImmediateViewStateFromBrowser(state.leftBrowser).pageIndex,
      0,
    );
    assert.equal(
      readerView.getImmediateViewStateFromBrowser(state.rightBrowser).pageIndex,
      1,
    );

    const data = (Zotero.getMainWindow().Zotero_Tabs as any)._getTab(
      state.tabID,
    ).tab.data;
    assert.equal(data.leftItemID, right.id);
    assert.equal(data.rightItemID, left.id);
    assert.equal(data.leftViewState.pageIndex, 0);
    assert.equal(data.rightViewState.pageIndex, 1);
    assert.strictEqual(data.primarySide, null);
    assert.equal(data.activeSide, "right");
  });

  it("closes one side and keeps the other reader position", async function () {
    const state = await open(false);
    setPrimarySide(state.tabID, null);
    const leftReader = readerRuntime.getInternalReaderFromBrowser(
      state.leftBrowser,
    );
    const rightReader = readerRuntime.getInternalReaderFromBrowser(
      state.rightBrowser,
    );
    await readerView.applyViewStateToReader(leftReader, {
      pageIndex: 0,
      scale: 100,
    });
    await readerView.applyViewStateToReader(rightReader, {
      pageIndex: 1,
      scale: 125,
    });
    assert.equal(
      readerView.getImmediateViewStateFromBrowser(state.rightBrowser).pageIndex,
      1,
      "visible right reader position before closing",
    );

    await factory.lifecycle.revertToSingleReader(state.tabID, "left");

    assert.isUndefined(factory.stateStore.get(state.tabID));
    const tabs = (Zotero.getMainWindow().Zotero_Tabs as any)._tabs;
    const readers = tabs.filter(
      (tab: any) =>
        tab.data?.itemID === left.id || tab.data?.itemID === right.id,
    );
    assert.lengthOf(readers, 1);
    assert.equal(readers[0].data.itemID, right.id);
    assert.isUndefined(readers[0].data.isSplitView);
    await waitFor(() => {
      const reader = Zotero.Reader.getByTabID(readers[0].id);
      return !!reader && !!readerView.getImmediateViewStateFromReader(reader);
    });
    const keptReader = Zotero.Reader.getByTabID(readers[0].id);
    await readerRuntime.waitForReaderReady(keptReader);
    assert.equal(
      readerView.getImmediateViewStateFromReader(keptReader).pageIndex,
      1,
    );
  });

  it("closing one same-PDF side keeps that side's independent position", async function () {
    const state = await open(true);
    setPrimarySide(state.tabID, null);
    const leftReader = readerRuntime.getInternalReaderFromBrowser(
      state.leftBrowser,
    );
    const rightReader = readerRuntime.getInternalReaderFromBrowser(
      state.rightBrowser,
    );
    await readerView.applyViewStateToReader(leftReader, {
      pageIndex: 0,
      scale: 100,
    });
    await readerView.applyViewStateToReader(rightReader, {
      pageIndex: 1,
      scale: 125,
    });

    await factory.lifecycle.revertToSingleReader(state.tabID, "left");

    assert.isUndefined(factory.stateStore.get(state.tabID));
    const tabs = (Zotero.getMainWindow().Zotero_Tabs as any)._tabs;
    const readers = tabs.filter((tab: any) => tab.data?.itemID === left.id);
    assert.lengthOf(readers, 1);
    const keptReader = Zotero.Reader.getByTabID(readers[0].id);
    assert.ok(keptReader);
    await readerRuntime.waitForReaderReady(keptReader);
    assert.equal(
      readerView.getImmediateViewStateFromReader(keptReader).pageIndex,
      1,
    );
    assert.equal(
      readerView.getImmediateViewStateFromReader(keptReader).scale,
      125,
    );
  });

  it("replaces one reader with the selected PDF and rebinds same-PDF state", async function () {
    const state = await open(false);
    const originalLeftBrowser = state.leftBrowser;
    const originalRightBrowser = state.rightBrowser;
    const selector = factory.pdfSelector;
    const originalSelect = selector.select;
    try {
      selector.select = async () => left;
      await factory.pdfReplacement.selectAndLoad(state.tabID, "right");
    } finally {
      selector.select = originalSelect;
    }

    assert.strictEqual(state.leftBrowser, originalLeftBrowser);
    assert.notStrictEqual(state.rightBrowser, originalRightBrowser);
    assert.equal(state.leftItemID, left.id);
    assert.equal(state.rightItemID, left.id);
    assert.isTrue(state.isSamePDF);
    assert.ok(readerRuntime.getInternalReaderFromBrowser(state.rightBrowser));
    assert.ok(state.disposeAnnotations);
  });

  it("separates different PDFs into their existing reader tabs with each position", async function () {
    const state = await open(false);
    setPrimarySide(state.tabID, null);
    const leftSplitReader = readerRuntime.getInternalReaderFromBrowser(
      state.leftBrowser,
    );
    const rightSplitReader = readerRuntime.getInternalReaderFromBrowser(
      state.rightBrowser,
    );
    await readerView.applyViewStateToReader(leftSplitReader, {
      pageIndex: 1,
      scale: 100,
    });
    await readerView.applyViewStateToReader(rightSplitReader, {
      pageIndex: 0,
      scale: 125,
    });

    const existingLeft = await Zotero.Reader.open(left.id, undefined, {
      allowDuplicate: true,
    });
    const existingRight = await Zotero.Reader.open(right.id, undefined, {
      allowDuplicate: true,
    });
    await readerRuntime.waitForReaderReady(existingLeft);
    await readerRuntime.waitForReaderReady(existingRight);
    await readerView.applyViewStateToReader(existingLeft, {
      pageIndex: 0,
      scale: 100,
    });
    await readerView.applyViewStateToReader(existingRight, {
      pageIndex: 1,
      scale: 100,
    });

    await factory.lifecycle.separate(state.tabID, "right");

    assert.isUndefined(factory.stateStore.get(state.tabID));
    assert.strictEqual(
      Zotero.Reader.getByTabID(existingLeft!.tabID),
      existingLeft,
    );
    assert.strictEqual(
      Zotero.Reader.getByTabID(existingRight!.tabID),
      existingRight,
    );
    assert.equal(
      readerView.getImmediateViewStateFromReader(existingLeft).pageIndex,
      1,
    );
    assert.equal(
      readerView.getImmediateViewStateFromReader(existingRight).pageIndex,
      0,
    );
    assert.isUndefined(
      (Zotero.getMainWindow().Zotero_Tabs as any)._getTab(state.tabID).tab,
    );
  });

  it("separates the selected position when both views use the same PDF", async function () {
    const state = await open(true);
    setPrimarySide(state.tabID, null);
    const leftReader = readerRuntime.getInternalReaderFromBrowser(
      state.leftBrowser,
    );
    const rightReader = readerRuntime.getInternalReaderFromBrowser(
      state.rightBrowser,
    );
    await readerView.applyViewStateToReader(leftReader, {
      pageIndex: 0,
      scale: 100,
    });
    await readerView.applyViewStateToReader(rightReader, {
      pageIndex: 1,
      scale: 125,
    });
    assert.equal(
      readerView.getImmediateViewStateFromBrowser(state.rightBrowser).pageIndex,
      1,
      "visible right reader position before separating",
    );
    assert.equal(
      readerView.getImmediateViewStateFromBrowser(state.rightBrowser).scale,
      125,
      "visible right reader scale before separating",
    );

    await factory.lifecycle.separate(state.tabID, "right");

    assert.isUndefined(factory.stateStore.get(state.tabID));
    const readers = (Zotero.getMainWindow().Zotero_Tabs as any)._tabs.filter(
      (tab: any) => tab.data?.itemID === left.id,
    );
    assert.lengthOf(readers, 1);
    await waitFor(() => !!Zotero.Reader.getByTabID(readers[0].id));
    const reader = Zotero.Reader.getByTabID(readers[0].id);
    await readerRuntime.waitForReaderReady(reader);
    assert.equal(reader.itemID, left.id);
    assert.equal(
      readerView.getImmediateViewStateFromReader(reader).pageIndex,
      1,
    );
    assert.equal(readerView.getImmediateViewStateFromReader(reader).scale, 125);
  });

  it("rebinds annotation and selection sync after replacing readers for a swap", async function () {
    const state = await open(true);
    await factory.pdfSwap.swap(state.tabID);
    const note = addNote(state, "right");
    const first = readerRuntime.getInternalReaderFromBrowser(state.leftBrowser);
    const second = readerRuntime.getInternalReaderFromBrowser(
      state.rightBrowser,
    );
    assert.ok(
      first._state.annotations.find((item: any) => item.id === note.id),
      errors.join("; "),
    );
    second.setSelectedAnnotations(contentData(state.rightBrowser, [note.id]));
    assert.deepEqual(Array.from(first._state.selectedAnnotationIDs), [note.id]);
    await waitFor(
      () => !!Zotero.Items.getByLibraryAndKey(left.libraryID, note.id),
    );
    const installed = first._updateState;
    const content = (state.leftBrowser.contentWindow as any).wrappedJSObject;
    const later = new content.Function(
      "origin",
      "return function(...args) { return origin.apply(this, args); }",
    )(installed);
    first._updateState = later;
    state.disposeAnnotations();
    state.disposeAnnotations = undefined;
    assert.strictEqual(first._updateState, later);
    first.setSelectedAnnotations(contentData(state.leftBrowser, []));
    assert.deepEqual(Array.from(second._state.selectedAnnotationIDs), [
      note.id,
    ]);
  });

  it("releases the save callback and reports a persistence failure in the reader", async function () {
    const state = await open(false);
    const first = readerRuntime.getInternalReaderFromBrowser(state.leftBrowser);
    const original = Zotero.Annotations.saveFromJSON;
    try {
      Zotero.Annotations.saveFromJSON = async () => {
        throw new Error("simulated annotation write failure");
      };
      addNote(state, "left");
      await waitFor(() => first._state.readOnly);
      await waitFor(() => !first._annotationManager._savingInProgress);
      assert.include(
        first._state.errorMessage,
        "simulated annotation write failure",
      );
    } finally {
      Zotero.Annotations.saveFromJSON = original;
    }
  });
});
