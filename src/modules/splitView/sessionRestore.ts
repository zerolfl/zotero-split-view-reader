import type { SplitTabState } from "./types";

export interface SplitSessionRestoreDependencies {
  getReader(tabID: string): any | null;
  getInitializationPromise(reader: any): Promise<void> | null;
  hasState(tabID: string): boolean;
  itemExists(itemID: number): boolean;
  getItem(itemID: number): Zotero.Item | null;
  convertSamePDF(reader: any, savedData: any): Promise<void>;
  convertDifferentPDF(
    reader: any,
    item: Zotero.Item,
    savedData: any,
  ): Promise<void>;
  getState(tabID: string): SplitTabState | null;
  updateBrowserFlex(state: SplitTabState, ratio: number): void;
  updateScrollbarColors(tabID: string): void;
  writeSession(tabID: string): void;
  debug(message: string): void;
}

export class SplitSessionRestore {
  constructor(private readonly deps: SplitSessionRestoreDependencies) {}

  async restore(tabID: string, savedData: any): Promise<void> {
    const reader = this.deps.getReader(tabID);
    if (!reader) {
      this.deps.debug(
        `Split view: Cannot restore - reader not found for tab ${tabID}`,
      );
      return;
    }

    const initialization = this.deps.getInitializationPromise(reader);
    if (initialization) await initialization;
    if (this.deps.hasState(tabID)) {
      this.deps.debug(
        `Split view: Tab ${tabID} already has split view, skipping restore`,
      );
      return;
    }

    const restoredData = { ...savedData };
    const { leftItemID, rightItemID, isSamePDF } = restoredData;
    if (
      !this.deps.itemExists(leftItemID) ||
      !this.deps.itemExists(rightItemID)
    ) {
      this.deps.debug(
        "Split view: Cannot restore - one or both items no longer exist",
      );
      return;
    }

    const leftItem = this.deps.getItem(leftItemID);
    const rightItem = this.deps.getItem(rightItemID);
    if (!leftItem || !rightItem) {
      this.deps.debug("Split view: Cannot restore - failed to get items");
      return;
    }

    this.deps.debug(
      `Split view: Restoring split view for tab ${tabID} (isSamePDF: ${isSamePDF})`,
    );
    if (isSamePDF) {
      await this.deps.convertSamePDF(reader, restoredData);
    } else {
      await this.deps.convertDifferentPDF(reader, rightItem, restoredData);
    }

    const state = this.deps.getState(tabID);
    if (state) this.restoreSettings(tabID, state, restoredData);
    this.deps.debug(
      `Split view: Successfully restored split view for tab ${tabID}`,
    );
  }

  private restoreSettings(
    tabID: string,
    state: SplitTabState,
    savedData: any,
  ): void {
    const { splitRatio, primarySide, activeSide, syncEnabled } = savedData;
    if (typeof splitRatio === "number" && splitRatio > 0 && splitRatio < 1) {
      state.splitRatio = splitRatio;
      this.deps.updateBrowserFlex(state, splitRatio);
    }

    let restoredPrimarySide: "left" | "right" | null | undefined;
    if (primarySide === "left" || primarySide === "right") {
      restoredPrimarySide = primarySide;
    } else if (
      Object.prototype.hasOwnProperty.call(savedData, "primarySide") &&
      primarySide === null
    ) {
      restoredPrimarySide = null;
    }
    if (syncEnabled === false) restoredPrimarySide = null;
    if (restoredPrimarySide !== undefined) {
      state.primarySide = restoredPrimarySide;
    }

    this.deps.updateScrollbarColors(tabID);
    if (activeSide === "left" || activeSide === "right") {
      state.activeSide = activeSide;
    }
    this.deps.writeSession(tabID);
  }
}
