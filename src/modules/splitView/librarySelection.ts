import type { SplitTabState } from "./types";

interface LibrarySelectionCallbacks {
  getState: (tabID: string) => SplitTabState | null;
  getParentItemID: (itemID: number) => number | null;
  selectItem: (win: Window, itemID: number) => void;
}

export class SplitLibrarySelection {
  constructor(private readonly callbacks: LibrarySelectionCallbacks) {}

  showActiveItem(tabID: string, win: Window): void {
    const state = this.callbacks.getState(tabID);
    if (!state || state.isCleaningUp) return;

    const itemID =
      state.activeSide === "left" ? state.leftItemID : state.rightItemID;
    const parentItemID = this.callbacks.getParentItemID(itemID);
    this.callbacks.selectItem(win, parentItemID || itemID);
  }
}
