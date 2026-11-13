import { assert } from "chai";
import { TabHooks } from "../src/platform/tabHooks";

describe("tab hooks", function () {
  it("shares lookup and audio hooks and disables itself below a later patch", async function () {
    const split = { id: "split", data: { isSplitView: true } };
    const ordinary = { id: "normal", data: {} };
    let pauses = 0;
    let toggles = 0;
    const tabs = {
      _getTab: (id: string) => ({ tab: id === "split" ? split : ordinary }),
      getTabIDByItemID(id: number) {
        return id === 1 ? "normal" : null;
      },
      setAudioStatus(_id: string, status: any) {
        return status;
      },
      tabHooks: {
        getTitle: { reader: async () => "ordinary title" },
        toggleAudio: { reader: () => "ordinary audio" },
      },
    };
    const hooks = new TabHooks({
      hasSplit: (id) => id === "split",
      findRightItem: (id) => (id === 2 ? "split" : null),
      getTitle: async () => "split title",
      toggleAudio: () => {
        toggles++;
      },
      pauseSplitAudio: () => {
        pauses++;
      },
    });
    const owner = { Zotero_Tabs: tabs } as unknown as Window;
    try {
      hooks.register(owner);
      const installed = tabs.getTabIDByItemID;
      hooks.register(owner);
      assert.strictEqual(tabs.getTabIDByItemID, installed);
      assert.equal(tabs.getTabIDByItemID(1), "normal");
      assert.equal(tabs.getTabIDByItemID(2), "split");
      assert.equal(await tabs.tabHooks.getTitle.reader(split), "split title");
      assert.equal(
        await tabs.tabHooks.getTitle.reader(ordinary),
        "ordinary title",
      );
      tabs.setAudioStatus("normal", { active: true, paused: false });
      tabs.setAudioStatus("split", { active: true, paused: false });
      assert.equal(pauses, 1);
      tabs.tabHooks.toggleAudio.reader(split);
      assert.equal(toggles, 1);
      const later = (id: number) => installed.call(tabs, id);
      tabs.getTabIDByItemID = later;
      hooks.unregister();
      assert.strictEqual(tabs.getTabIDByItemID, later);
      assert.isNull(tabs.getTabIDByItemID(2));
      assert.equal(
        await tabs.tabHooks.getTitle.reader(split),
        "ordinary title",
      );
      tabs.setAudioStatus("normal", { active: true, paused: false });
      assert.equal(pauses, 1);
    } finally {
      hooks.unregister();
    }
  });
});
