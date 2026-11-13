import { tabsForWindow } from "../../platform/tabs";
import type { SplitTabState } from "./types";
import {
  getSplitViewTabTitleForItems,
  type SplitTabsTitleMode,
} from "../../utils/splitTabTitle";
import { getPref } from "../../utils/prefs";

interface SplitTabTitleCallbacks {
  getStates: () => Iterable<SplitTabState>;
  getState: (tabID: string) => SplitTabState | undefined;
}

export class SplitTabTitleService {
  private preferenceObserverID: symbol | null = null;
  private itemNotifierID: string | null = null;

  constructor(private readonly callbacks: SplitTabTitleCallbacks) {}

  private getMode(): SplitTabsTitleMode {
    const mode = getPref("splitTabsTitle");
    if (
      mode === "titleCreatorYear" ||
      mode === "creatorYearTitle" ||
      mode === "attachmentTitle" ||
      mode === "filename"
    ) {
      return mode;
    }
    return "filename";
  }

  async renameTab(tabID: string): Promise<void> {
    const state = this.callbacks.getState(tabID);
    if (!state || state.isCleaningUp) return;

    try {
      const leftItem = Zotero.Items.get(state.leftItemID);
      const rightItem = Zotero.Items.get(state.rightItemID);
      if (!leftItem || !rightItem) return;

      const title = await getSplitViewTabTitleForItems(
        leftItem,
        rightItem,
        this.getMode(),
      );
      await tabsForWindow(Zotero.getMainWindow()).rename(tabID, title);
    } catch (error) {
      Zotero.debug(`Split view: renameSplitViewTab failed: ${error}`);
    }
  }

  async getTitleForTab(tab: any): Promise<string> {
    const leftItemID = tab?.data?.leftItemID ?? tab?.data?.itemID;
    const rightItemID =
      tab?.data?.rightItemID ?? tab?.data?.leftItemID ?? tab?.data?.itemID;
    const leftItem = leftItemID ? Zotero.Items.get(leftItemID) : null;
    const rightItem = rightItemID ? Zotero.Items.get(rightItemID) : null;
    if (!leftItem || !rightItem) return "";

    return getSplitViewTabTitleForItems(leftItem, rightItem, this.getMode());
  }

  refreshOpenTabs(): void {
    void this.renameAll();
  }

  private async renameAll(): Promise<void> {
    for (const state of this.callbacks.getStates()) {
      await this.renameTab(state.tabID);
    }
  }

  private async renameChangedItems(ids: (string | number)[]): Promise<void> {
    const changedIDs = new Set(
      ids.map((id) => Number(id)).filter((id) => Number.isInteger(id)),
    );
    if (!changedIDs.size) return;

    for (const state of this.callbacks.getStates()) {
      if (state.isCleaningUp) continue;
      if (
        changedIDs.has(state.leftItemID) ||
        changedIDs.has(state.rightItemID) ||
        changedIDs.has(state.leftParentItemID) ||
        changedIDs.has(state.rightParentItemID)
      ) {
        await this.renameTab(state.tabID);
      }
    }
  }

  registerPreferenceObserver(name: string): void {
    if (this.preferenceObserverID) return;
    this.preferenceObserverID = Zotero.Prefs.registerObserver(
      name,
      () => this.refreshOpenTabs(),
      true,
    );
  }

  registerItemNotifier(): void {
    if (this.itemNotifierID) return;
    this.itemNotifierID = Zotero.Notifier.registerObserver(
      {
        notify: (action: string, type: string, ids: (string | number)[]) => {
          if (type !== "item") return;
          if (action !== "modify" && action !== "refresh") return;
          void this.renameChangedItems(ids);
        },
      },
      ["item"],
      "splitViewTabTitle",
      30,
    );
  }

  unregister(): void {
    if (this.preferenceObserverID) {
      try {
        Zotero.Prefs.unregisterObserver(this.preferenceObserverID);
      } catch (error) {
        Zotero.logError(error as Error);
      }
      this.preferenceObserverID = null;
    }
    if (this.itemNotifierID) {
      try {
        Zotero.Notifier.unregisterObserver(this.itemNotifierID);
      } catch (error) {
        Zotero.logError(error as Error);
      }
      this.itemNotifierID = null;
    }
  }
}
