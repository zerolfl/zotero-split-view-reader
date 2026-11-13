import type { SplitSide, SplitTabState } from "./types";

interface ReadAloudCoordinatorCallbacks {
  states: () => Iterable<SplitTabState>;
  getState: (tabID: string) => SplitTabState | undefined;
  getReader: (browser: XULBrowserElement) => any;
  setAudioStatus: (tabID: string, status: any) => void;
  pauseOtherReaders: () => void;
}

export class SplitReadAloudCoordinator {
  constructor(private readonly callbacks: ReadAloudCoordinatorCallbacks) {}

  getReaderSide(tabID: string, reader: any): SplitSide | null {
    const state = this.callbacks.getState(tabID);
    if (!state || state.leftItemID === state.rightItemID) return null;

    try {
      if (reader.itemID === state.leftItemID) return "left";
      if (reader.itemID === state.rightItemID) return "right";
    } catch (error) {
      Zotero.debug(`Split view: getReaderSide error: ${error}`);
    }
    return null;
  }

  getActiveReaderInfoByBrowser(
    browser: XULBrowserElement,
  ): { state: SplitTabState; side: SplitSide } | null {
    for (const state of this.callbacks.states()) {
      if (state.isCleaningUp) continue;
      if (browser === state.leftBrowser) return { state, side: "left" };
      if (browser === state.rightBrowser) return { state, side: "right" };
    }
    return null;
  }

  getReaderSideByBrowser(
    tabID: string,
    browser: XULBrowserElement,
  ): SplitSide | null {
    const state = this.callbacks.getState(tabID);
    if (!state) return null;
    if (browser === state.leftBrowser) return "left";
    if (browser === state.rightBrowser) return "right";
    return null;
  }

  shouldSyncLastPosition(
    state: SplitTabState,
    browser: XULBrowserElement,
    viewState: any,
  ): boolean {
    if (!viewState || !("lastReadAloudPosition" in viewState)) return false;
    const side = this.getReaderSideByBrowser(state.tabID, browser);
    if (!side) return false;
    const status = state.readAloudStatuses[side];
    return state.readAloudSide === side && !!status?.active && !status.paused;
  }

  pauseBrowser(browser: XULBrowserElement, paused = true): void {
    try {
      this.callbacks.getReader(browser)?.toggleReadAloudPaused?.(paused);
    } catch (error) {
      Zotero.debug(`Split view: pauseReadAloudInBrowser failed: ${error}`);
    }
  }

  pauseAll(): void {
    for (const state of this.callbacks.states()) {
      if (state.isCleaningUp) continue;
      this.pauseBrowser(state.leftBrowser);
      this.pauseBrowser(state.rightBrowser);
    }
  }

  private pauseExcept(tabID: string, activeBrowser: XULBrowserElement): void {
    const activeState = this.callbacks.getState(tabID);
    if (!activeState || activeState.isCleaningUp) return;

    for (const state of this.callbacks.states()) {
      if (state.isCleaningUp) continue;
      for (const browser of [state.leftBrowser, state.rightBrowser]) {
        if (browser !== activeBrowser) this.pauseBrowser(browser);
      }
    }
    this.callbacks.pauseOtherReaders();
  }

  handleStatus(tabID: string, browser: XULBrowserElement, status: any): void {
    const state = this.callbacks.getState(tabID);
    if (!state || state.isCleaningUp) return;

    const side = this.getReaderSideByBrowser(tabID, browser);
    if (side) {
      state.readAloudStatuses[side] = status || null;
      const otherSide: SplitSide = side === "left" ? "right" : "left";
      const otherStatus = state.readAloudStatuses[otherSide];
      const sidePlaying = !!status?.active && !status.paused;
      const otherPlaying = !!otherStatus?.active && !otherStatus.paused;

      if (sidePlaying) state.readAloudSide = side;
      else if (!status?.active) {
        if (state.readAloudSide === side) {
          state.readAloudSide = otherStatus?.active ? otherSide : null;
        }
      } else if (!otherPlaying && !state.readAloudSide) {
        state.readAloudSide = side;
      } else if (otherPlaying && state.readAloudSide === side) {
        state.readAloudSide = otherSide;
      }
    }

    if (status?.active && !status.paused) {
      try {
        browser.docShellIsActive = true;
      } catch {
        // Ignore browser activation errors.
      }
      this.pauseExcept(tabID, browser);
    }

    this.callbacks.setAudioStatus(tabID, this.getTabStatus(state, status));
  }

  clearSide(state: SplitTabState, side: SplitSide): void {
    state.readAloudStatuses[side] = null;
    if (state.readAloudSide === side) {
      const otherSide: SplitSide = side === "left" ? "right" : "left";
      state.readAloudSide = state.readAloudStatuses[otherSide]?.active
        ? otherSide
        : null;
    }
    this.callbacks.setAudioStatus(
      state.tabID,
      this.getTabStatus(state, { active: false, paused: false }),
    );
  }

  private getTabStatus(state: SplitTabState, fallback: any): any {
    const sides: SplitSide[] = ["left", "right"];
    const playingSide = sides.find((side) => {
      const status = state.readAloudStatuses[side];
      return !!status?.active && !status.paused;
    });
    if (playingSide) return state.readAloudStatuses[playingSide];

    if (state.readAloudSide) {
      const status = state.readAloudStatuses[state.readAloudSide];
      if (status?.active) return status;
    }
    const activeSide = sides.find(
      (side) => !!state.readAloudStatuses[side]?.active,
    );
    return activeSide
      ? state.readAloudStatuses[activeSide]
      : (fallback ?? { active: false, paused: false });
  }

  toggleActive(tabID: string): void {
    const state = this.callbacks.getState(tabID);
    if (!state || state.isCleaningUp) return;

    const sides: SplitSide[] = ["left", "right"];
    const targetSide =
      sides.find((side) => {
        const status = state.readAloudStatuses[side];
        return !!status?.active && !status.paused;
      }) ??
      state.readAloudSide ??
      sides.find((side) => !!state.readAloudStatuses[side]?.active) ??
      state.activeSide;
    const browser =
      targetSide === "left" ? state.leftBrowser : state.rightBrowser;
    try {
      this.callbacks.getReader(browser)?.toggleReadAloudPaused?.();
    } catch (error) {
      Zotero.debug(`Split view: toggleActiveReadAloud failed: ${error}`);
    }
  }
}
