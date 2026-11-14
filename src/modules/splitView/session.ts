import { observeReaderLoads, tabsForWindow } from "../../platform/tabs";
import { readerView } from "../../platform/readerView";
import type { SplitTabState } from "./types";

export class SplitSession {
  private unsubscribe: (() => void) | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private restoring = new Set<string>();
  private revision = 0;

  constructor(
    private readonly restore: (id: string, data: any) => Promise<void>,
    private readonly isActive: (id: string) => boolean,
    private readonly getState: (id: string) => SplitTabState | undefined,
  ) {}

  register(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = observeReaderLoads((id, data) =>
      this.schedule(id, data, 500),
    );
    this.later(() => {
      for (const tab of tabsForWindow().list()) {
        if (tab.type === "reader") this.schedule(tab.id, tab.data, 0);
      }
    }, 100);
  }

  private later(callback: () => void, delay: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delay);
    this.timers.add(timer);
  }

  private schedule(id: string, data: any, delay: number): void {
    if (!data?.isSplitView) return;
    const revision = this.revision;
    this.later(() => {
      if (
        revision !== this.revision ||
        this.isActive(id) ||
        this.restoring.has(id)
      )
        return;
      if (!tabsForWindow().lookup(id)?.tab?.data?.isSplitView) return;
      this.restoring.add(id);
      void this.restore(id, data)
        .catch((error) => Zotero.logError(error))
        .finally(() => {
          if (revision === this.revision) this.restoring.delete(id);
        });
    }, delay);
  }

  unregister(): void {
    this.revision++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.restoring.clear();
  }

  writeTab(tabID: string): void {
    const state = this.getState(tabID);
    if (state) this.write(state);
  }

  write(state: SplitTabState, itemID = state.leftItemID): void {
    if (state.isCleaningUp) return;
    for (const side of ["left", "right"] as const) {
      const visible = readerView.getImmediateViewStateFromBrowser(
        state[`${side}Browser`],
      );
      if (visible) {
        state[`${side}ViewState`] = {
          ...state[`${side}ViewState`],
          ...visible,
        };
      }
    }
    this.writeSavedState(state, itemID);
  }

  writeSavedState(state: SplitTabState, itemID = state.leftItemID): void {
    const tabs = tabsForWindow(state.container.ownerGlobal || undefined);
    tabs.clearDataFields(state.tabID, ["syncEnabled"]);
    tabs.setTabData(state.tabID, {
      itemID,
      leftItemID: state.leftItemID,
      rightItemID: state.rightItemID,
      isSplitView: true,
      isSamePDF: state.isSamePDF,
      splitRatio: state.splitRatio,
      primarySide: state.primarySide,
      activeSide: state.activeSide,
      leftViewState:
        state.leftViewState && JSON.parse(JSON.stringify(state.leftViewState)),
      rightViewState:
        state.rightViewState &&
        JSON.parse(JSON.stringify(state.rightViewState)),
    });
  }

  prepareClose(tabID: string, itemID: number, win?: Window): void {
    const tabs = tabsForWindow(win);
    tabs.clearDataFields(tabID, [
      "leftItemID",
      "rightItemID",
      "isSplitView",
      "isSamePDF",
      "splitRatio",
      "primarySide",
      "activeSide",
      "syncEnabled",
      "leftViewState",
      "rightViewState",
    ]);
    tabs.setTabData(tabID, { itemID });
  }
}
