import { PatchHelper } from "zotero-plugin-toolkit";

interface SplitTabHooks {
  hasSplit: (tabID: string) => boolean;
  findRightItem: (itemID: number) => string | null;
  getTitle: (tab: any) => Promise<string>;
  toggleAudio: (tabID: string) => void;
  pauseSplitAudio: () => void;
}

export class TabHooks {
  private windows = new Map<Window, PatchHelper[]>();

  constructor(private readonly handlers: SplitTabHooks) {}

  register(win: Window): void {
    if (this.windows.has(win)) return;
    const tabs = (win as any).Zotero_Tabs;
    if (!tabs) return;
    const patches: PatchHelper[] = [];
    this.windows.set(win, patches);
    const handlers = this.handlers;
    const patch = (target: any, key: string, patcher: (origin: any) => any) => {
      if (typeof target?.[key] !== "function") return;
      patches.push(
        new PatchHelper().setData({
          target,
          funcSign: key,
          patcher,
          enabled: true,
        }),
      );
    };
    const owns = (tab: any) =>
      tab?.data?.isSplitView && handlers.hasSplit(tab.id);
    patch(
      tabs,
      "getTabIDByItemID",
      (origin) =>
        function (this: any, itemID: number) {
          const found = origin.call(this, itemID);
          if (found) return found;
          const id = handlers.findRightItem(itemID);
          return id && this._getTab(id)?.tab ? id : null;
        },
    );
    patch(
      tabs,
      "setAudioStatus",
      (origin) =>
        function (this: any, id: string, status: any) {
          if (status?.active && !status.paused && !owns(this._getTab(id)?.tab))
            handlers.pauseSplitAudio();
          return origin.call(this, id, status);
        },
    );
    patch(
      tabs.tabHooks?.getTitle,
      "reader",
      (origin) =>
        async function (this: any, tab: any) {
          return owns(tab) ? handlers.getTitle(tab) : origin.call(this, tab);
        },
    );
    patch(
      tabs.tabHooks?.toggleAudio,
      "reader",
      (origin) =>
        function (this: any, tab: any) {
          if (owns(tab)) return handlers.toggleAudio(tab.id);
          return origin.call(this, tab);
        },
    );
  }

  unregister(win?: Window): void {
    for (const [owner, patches] of this.windows) {
      if (win && owner !== win) continue;
      for (const patch of patches) patch.unpatch();
      this.windows.delete(owner);
    }
  }
}
