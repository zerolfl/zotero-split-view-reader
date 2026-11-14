import { assert } from "chai";
import { config } from "../package.json";
import { SplitViewFactory } from "../src/modules/splitView";
import { readerRuntime } from "../src/platform/readerRuntime";
import { readerView } from "../src/platform/readerView";
import { createPDFAttachment } from "./fixtures/pdf";

describe(`process restart (Zotero ${Zotero.version})`, function () {
  this.timeout(90000);
  const factory = SplitViewFactory as any;
  const expectedPath = PathUtils.join(
    Zotero.DataDirectory.dir,
    "restart-expected.json",
  );
  const phase = Zotero.Prefs.get(
    "extensions.zotero.splitReaderRestartPhase",
    true,
  );
  const tabs = Zotero.getMainWindow().Zotero_Tabs as any;

  async function waitFor(
    check: () => boolean | Promise<boolean>,
    label: string,
  ) {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (await check()) return;
      await Zotero.Promise.delay(50);
    }
    assert.fail(`Timed out waiting for ${label}`);
  }

  if (phase === "prepare") {
    it("leaves same-PDF, different-PDF and ordinary readers for shutdown", async function () {
      const instance = Zotero[config.addonInstance];
      for (const [name, value] of Object.entries({
        addon: instance,
        ztoolkit: instance.data.ztoolkit,
      }))
        Object.defineProperty(window, name, { configurable: true, value });
      Zotero.Prefs.set(`${config.prefsPrefix}.followFocusPrimary`, false, true);

      const expected = [];
      for (const samePDF of [true, false]) {
        const left = await createPDFAttachment(`Restart left ${samePDF}`);
        const right = samePDF
          ? left
          : await createPDFAttachment("Restart right");
        const reader = await Zotero.Reader.open(left.id);
        await readerRuntime.waitForReaderReady(reader);
        if (samePDF) await factory.conversion.convertSamePDF(reader);
        else await factory.conversion.convertDifferentPDF(reader, right);
        const state = factory.stateStore.get(reader!.tabID);
        await Zotero.Promise.delay(700);
        factory.primaryView.setSide(state.tabID, null);
        for (const side of ["left", "right"] as const) {
          const internal = readerRuntime.getInternalReaderFromBrowser(
            state[`${side}Browser`],
          );
          await readerView.applyViewStateToReader(internal, {
            pageIndex: side === "left" ? 1 : 0,
            scale: side === "left" ? 125 : 100,
          });
        }
        state.splitRatio = samePDF ? 0.35 : 0.6;
        factory.layout.updateBrowserFlex(
          state.leftBrowser,
          state.rightBrowser,
          state.splitRatio,
        );
        state.activeSide = "right";
        factory.primaryView.setSide(state.tabID, samePDF ? null : "right");
        factory.session.writeTab(state.tabID);
        expected.push(
          JSON.parse(JSON.stringify(tabs._getTab(state.tabID).tab.data)),
        );
      }
      const ordinary = await createPDFAttachment("Restart ordinary");
      const reader = await Zotero.Reader.open(ordinary.id);
      await readerRuntime.waitForReaderReady(reader);
      await readerView.applyViewStateToReader(reader, {
        pageIndex: 1,
        scale: 100,
      });
      readerView.getViewerContainerFromBrowser(reader!._iframe!)!.scrollTop +=
        10;
      const ordinaryState = PathUtils.join(
        Zotero.Attachments.getStorageDirectory(ordinary).path,
        ".zotero-reader-state",
      );
      await waitFor(
        async () =>
          (await IOUtils.exists(ordinaryState)) &&
          ((await IOUtils.readJSON(ordinaryState)) as any).pageIndex === 1,
        "native ordinary position persistence",
      );
      await IOUtils.writeUTF8(
        expectedPath,
        JSON.stringify({
          version: Zotero.version,
          splits: expected,
          ordinaryID: ordinary.id,
        }),
      );
      assert.lengthOf(expected, 2);
    });
  } else {
    it("automatically restores both split readers from the previous process", async function () {
      assert.equal(phase, "restore");
      const expected = JSON.parse(await IOUtils.readUTF8(expectedPath));
      assert.equal(expected.version, Zotero.version);
      for (const saved of expected.splits) {
        const tab = tabs._tabs.find(
          (tab: any) => tab.data?.leftItemID === saved.leftItemID,
        );
        assert.ok(tab, "native session restores the split tab");
        tabs.select(tab.id);
        const container = () =>
          Zotero.getMainWindow().document.getElementById(tab.id)!;
        await waitFor(
          () => container()?.querySelectorAll("browser").length === 2,
          "automatic split conversion",
        );
        const browsers = [
          ...container().querySelectorAll("browser"),
        ] as XULBrowserElement[];
        await waitFor(
          () =>
            browsers.every(
              (browser) =>
                !!readerView.getImmediateViewStateFromBrowser(browser),
            ),
          "both restored PDF views",
        );
        await Zotero.Promise.delay(700);
        const data = tabs._getTab(tab.id).tab.data;
        for (const field of [
          "leftItemID",
          "rightItemID",
          "isSamePDF",
          "splitRatio",
          "primarySide",
          "activeSide",
        ])
          assert.strictEqual(data[field], saved[field], field);
        for (const [index, side] of ["left", "right"].entries()) {
          const visible = readerView.getImmediateViewStateFromBrowser(
            browsers[index],
          );
          assert.equal(
            visible.pageIndex,
            saved[`${side}ViewState`].pageIndex,
            `${side} page`,
          );
          assert.equal(
            visible.scale,
            saved[`${side}ViewState`].scale,
            `${side} scale`,
          );
          const style = readerView
            .getPrimaryViewWindowFromBrowser(browsers[index])!
            .document.getElementById("split-view-scrollbar-style");
          assert.equal(
            !!style,
            saved.primarySide === side,
            `${side} primary indicator`,
          );
          const expectedFlex = Math.round(
            (index === 0 ? saved.splitRatio : 1 - saved.splitRatio) * 1000,
          );
          assert.equal(Number(browsers[index].style.flexGrow), expectedFlex);
        }
      }
    });

    it("preserves the ordinary attachment's independent reading state", async function () {
      const { ordinaryID } = JSON.parse(await IOUtils.readUTF8(expectedPath));
      const tab = tabs._tabs.find(
        (tab: any) => tab.data?.itemID === ordinaryID,
      );
      assert.ok(tab);
      assert.isNotTrue(tab.data.isSplitView);
      tabs.select(tab.id);
      await waitFor(
        () => !!Zotero.Reader.getByTabID(tab.id),
        "ordinary reader",
      );
      const reader = Zotero.Reader.getByTabID(tab.id);
      await readerRuntime.waitForReaderReady(reader);
      const visible = readerView.getImmediateViewStateFromReader(reader);
      assert.equal(visible.pageIndex, 1);
      assert.equal(visible.scale, 100);
    });
  }
});
