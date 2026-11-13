import type { SeparateViewTarget } from "./types";

export interface SeparateViewTargetsDependencies {
  getTabs(): any;
  getReader(tabID: string): any;
  openReader(itemID: number, options: Record<string, any>): Promise<any>;
  waitForReaderReady(reader: any, maxWaitMs?: number): Promise<void>;
  applyViewState(reader: any, viewState: any): Promise<any>;
  delay(milliseconds: number): Promise<void>;
  debug(message: string): void;
}

export class SeparateViewTargets {
  constructor(private readonly deps: SeparateViewTargetsDependencies) {}

  findReusableReaderTabID(
    itemID: number,
    excludedTabIDs: Set<string> = new Set(),
  ): string | null {
    try {
      for (const tab of this.deps.getTabs().list()) {
        if (!tab?.id || excludedTabIDs.has(tab.id)) continue;
        if (tab.data?.isSplitView) continue;
        const isReaderTab =
          tab.type === "reader" ||
          tab.type === "reader-unloaded" ||
          tab.type === "reader-loading" ||
          tab.type?.startsWith("reader") ||
          tab.mode === "reader";
        if (isReaderTab && tab.data?.itemID === itemID) return tab.id;
      }
    } catch (error) {
      this.deps.debug(`Split view: findReusableReaderTabID error: ${error}`);
    }
    return null;
  }

  async waitForReaderByTabID(
    tabID: string,
    maxWaitMs = 10000,
  ): Promise<any | null> {
    const start = Date.now();
    let reader = this.deps.getReader(tabID);
    while (!reader && Date.now() - start < maxWaitMs) {
      await this.deps.delay(50);
      reader = this.deps.getReader(tabID);
    }
    if (!reader) return null;
    await this.deps.waitForReaderReady(reader, maxWaitMs);
    return reader;
  }

  async waitForTabClosed(tabID: string, maxWaitMs = 3000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const tabs = this.deps.getTabs();
      const reader = this.deps.getReader(tabID);
      let tab: any;
      try {
        tab = tabs.lookup(tabID)?.tab || null;
      } catch {
        tab = null;
      }
      if (!reader && !tab) return;
      await this.deps.delay(25);
    }
  }

  async waitForSplitViewToSettle(): Promise<void> {
    await this.deps.delay(350);
  }

  async restore(tabID: string, viewState: any): Promise<void> {
    try {
      const reader = await this.waitForReaderByTabID(tabID);
      if (reader) await this.deps.applyViewState(reader, viewState);
    } catch (error) {
      this.deps.debug(`Split view: restoreSeparateViewTarget failed: ${error}`);
    }
  }

  async prepare(
    target: SeparateViewTarget,
    tabIndex: number,
    activate = false,
    deferRestore = false,
  ): Promise<void> {
    const tabs = this.deps.getTabs();
    const selectTargetIfNeeded = () => {
      if (!activate || !target.tabID) return;
      if (tabs.selectedID !== target.tabID) tabs.select(target.tabID);
    };
    const openTarget = async (title?: string): Promise<void> => {
      const reader = await this.deps.openReader(target.itemID, {
        title,
        tabIndex,
        openInBackground: !activate,
        allowDuplicate: true,
      });
      target.tabID = reader?.tabID || null;
      if (!target.tabID) return;
      selectTargetIfNeeded();
      if (!deferRestore && target.tabID)
        await this.restore(target.tabID, target.viewState);
    };

    if (!target.tabID) {
      await openTarget();
      return;
    }

    let tab: any = null;
    try {
      ({ tab } = tabs.lookup(target.tabID));
    } catch (error) {
      this.deps.debug(
        `Split view: prepareSeparateViewTarget get tab failed: ${error}`,
      );
    }
    if (!tab) {
      target.tabID = null;
      await openTarget();
      return;
    }

    const existingTabID = target.tabID;
    const existingTitle = tab.title;
    try {
      tabs.move(existingTabID, tabIndex);
    } catch (error) {
      this.deps.debug(`Split view: separateViews move tab failed: ${error}`);
    }

    const liveReader = this.deps.getReader(existingTabID);
    if (liveReader) {
      target.tabID = existingTabID;
      selectTargetIfNeeded();
      if (deferRestore) return;
      await this.deps.waitForReaderReady(liveReader);
      await this.deps.applyViewState(liveReader, target.viewState);
      return;
    }

    let refreshedTab = tab;
    try {
      refreshedTab = tabs.lookup(existingTabID).tab || tab;
    } catch (error) {
      this.deps.debug(
        `Split view: prepareSeparateViewTarget refresh tab failed: ${error}`,
      );
    }

    if (refreshedTab?.type === "reader-unloaded") {
      try {
        tabs.close(existingTabID);
        await this.waitForTabClosed(existingTabID);
      } catch (error) {
        this.deps.debug(
          `Split view: prepareSeparateViewTarget close unloaded tab failed: ${error}`,
        );
      }
      target.tabID = null;
      await openTarget(refreshedTab.title || existingTitle);
      return;
    }

    if (refreshedTab?.type === "reader-loading") {
      target.tabID = existingTabID;
      selectTargetIfNeeded();
      if (deferRestore) return;
      const reader = await this.waitForReaderByTabID(existingTabID);
      if (reader) await this.deps.applyViewState(reader, target.viewState);
      return;
    }

    target.tabID = null;
    await openTarget(existingTitle);
  }
}
