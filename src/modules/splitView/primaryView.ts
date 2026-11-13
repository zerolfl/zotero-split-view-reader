import type { SplitSide, SplitTabState } from "./types";

export interface PrimaryViewMenuConfig {
  menuState: "current" | "other" | "none";
  disabled: boolean;
  isCurrentPrimary: boolean;
  targetPrimarySide: SplitSide | null;
}

export interface PrimaryViewDependencies {
  getState(tabID: string): SplitTabState | null;
  stopSyncPolling(tabID: string): void;
  updateScrollbarColors(tabID: string): void;
  initSyncState(tabID: string): void;
  startSyncPolling(tabID: string): void;
  updateSession(tabID: string): void;
}

export class SplitPrimaryView {
  constructor(private readonly deps: PrimaryViewDependencies) {}

  getDefaultSide(): SplitSide {
    return "left";
  }

  getEffectiveSide(
    state: Pick<SplitTabState, "primarySide">,
  ): SplitSide | null {
    return state.primarySide;
  }

  getMenuConfig(
    state: SplitTabState,
    side: SplitSide | null,
  ): PrimaryViewMenuConfig {
    const primarySide = this.getEffectiveSide(state);
    const isCurrentPrimary = !!side && primarySide === side;
    const menuState = !primarySide
      ? "none"
      : isCurrentPrimary
        ? "current"
        : "other";

    return {
      menuState,
      disabled: false,
      isCurrentPrimary,
      targetPrimarySide: menuState === "current" ? null : side,
    };
  }

  setSide(tabID: string, side: SplitSide | null): void {
    const state = this.deps.getState(tabID);
    if (!state || state.isCleaningUp) return;

    this.deps.stopSyncPolling(tabID);
    state.primarySide = side;
    state.lastPrimaryScroll = null;
    this.deps.updateScrollbarColors(tabID);
    if (side) {
      this.deps.initSyncState(tabID);
      this.deps.startSyncPolling(tabID);
    }
    this.deps.updateSession(tabID);
  }
}
