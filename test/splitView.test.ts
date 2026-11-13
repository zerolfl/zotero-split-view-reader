import { assert } from "chai";
import { config } from "../package.json";
import { SplitViewFactory } from "../src/modules/splitView";
import { readerRuntime } from "../src/platform/readerRuntime";
import { readerView } from "../src/platform/readerView";
import { createPDFAttachment } from "./fixtures/pdf";

describe("split reader integration", function () {
  this.timeout(30000);
  const factory = SplitViewFactory as any;
  let left: Zotero.Item;
  let right: Zotero.Item;
  let globals: Record<string, PropertyDescriptor | undefined>;

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

  afterEach(async function () {
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
});
