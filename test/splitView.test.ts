import { assert } from "chai";
import { config } from "../package.json";
import { SplitViewFactory } from "../src/modules/splitView";
import { readerRuntime } from "../src/platform/readerRuntime";
import { readerView } from "../src/platform/readerView";
import { annotationStore } from "../src/platform/annotationStore";
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
    for (const tabID of [...factory.stateMap.keys()])
      factory.closeSplitTab(tabID);
    const tabs = Zotero.getMainWindow().Zotero_Tabs;
    for (const tab of [...(tabs as any)._tabs]) {
      if (tab.type.startsWith("reader")) tabs.close(tab.id);
    }
    await Zotero.Promise.delay(100);
  });

  after(function () {
    if (factory.globalTabNotifierID) {
      Zotero.Notifier.unregisterObserver(factory.globalTabNotifierID);
      factory.globalTabNotifierID = null;
    }
    for (const [name, descriptor] of Object.entries(globals)) {
      if (descriptor) Object.defineProperty(window, name, descriptor);
      else delete (window as any)[name];
    }
  });

  async function open(samePDF: boolean) {
    const reader = await Zotero.Reader.open(left.id);
    assert.ok(reader);
    await readerRuntime.waitForReaderReady(reader);
    if (samePDF) await factory.convertToSamePDFSplitView(reader);
    else await factory.convertToSplitView(reader, right);
    const state = factory.stateMap.get(reader!.tabID);
    assert.ok(state);
    await Zotero.Promise.delay(700);
    return state;
  }

  async function waitFor(check: () => boolean): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await Zotero.Promise.delay(30);
    }
    assert.fail(
      `Timed out waiting for annotation persistence: ${errors.join("; ")}`,
    );
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
    factory.setPrimarySide(state.tabID, null);
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
        factory.getCloseViewMenuLabel(),
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

    assert.ok(getScrollbarStyle(state.leftBrowser));
    assert.isNull(getScrollbarStyle(state.rightBrowser));
    factory.setPrimarySide(state.tabID, "right");
    assert.isNull(getScrollbarStyle(state.leftBrowser));
    assert.ok(getScrollbarStyle(state.rightBrowser));
    factory.setPrimarySide(state.tabID, null);
    assert.isNull(getScrollbarStyle(state.leftBrowser));
    assert.isNull(getScrollbarStyle(state.rightBrowser));
  });

  it("restores different positions of the same PDF and explicit primary and focus settings", async function () {
    const state = await open(true);
    factory.setPrimarySide(state.tabID, null);
    const first = readerRuntime.getInternalReaderFromBrowser(state.leftBrowser);
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
    factory.updateTabDataForSession(state.tabID);
    const tabs = Zotero.getMainWindow().Zotero_Tabs as any;
    const saved = JSON.parse(
      JSON.stringify(tabs._getTab(state.tabID).tab.data),
    );
    assert.equal(saved.leftViewState.pageIndex, 1, "saved left position");
    assert.equal(saved.rightViewState.pageIndex, 0, "saved right position");
    factory.closeSplitTab(state.tabID);
    const ordinary = await Zotero.Reader.open(left.id);
    await readerRuntime.waitForReaderReady(ordinary);
    tabs.setTabData(ordinary!.tabID, saved);
    await factory.restoreSplitViewFromSession(ordinary!.tabID, saved);
    const restored = factory.stateMap.get(ordinary!.tabID);
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
    factory.setPrimarySide(state.tabID, null);
    factory.activateSide(state.tabID, "right", Zotero.getMainWindow());

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
    await factory.swapPDFs(state.tabID);

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

  it("rebinds annotation and selection sync after replacing readers for a swap", async function () {
    const state = await open(true);
    await factory.swapPDFs(state.tabID);
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
