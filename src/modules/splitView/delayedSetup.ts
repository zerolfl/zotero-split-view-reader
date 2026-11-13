import type { SplitTabState } from "./types";

export interface SplitViewDelayedSetupDependencies {
  getState(tabID: string): SplitTabState | undefined;
  trackTimeout(
    state: SplitTabState,
    callback: () => void,
    delay: number,
  ): number;
  setupResizeListener(tabID: string, win: Window): void;
  setupCtrlKeyListener(tabID: string, browser: XULBrowserElement): void;
  setupMainWindowKeyboardListener(tabID: string, win: Window): void;
  setupZoomButtonListeners(tabID: string, browser: XULBrowserElement): void;
  setupContextPaneObserver(tabID: string, win: Window): void;
  cacheViewerContainers(tabID: string): void;
  initSyncState(tabID: string): void;
  startSyncPolling(tabID: string): void;
  updateScrollbar(tabID: string): void;
}

export class SplitViewDelayedSetup {
  constructor(private readonly deps: SplitViewDelayedSetupDependencies) {}

  restartSync(tabID: string, state: SplitTabState): void {
    this.deps.trackTimeout(
      state,
      () => {
        const current = this.deps.getState(tabID);
        if (!current?.primarySide) return;
        this.deps.cacheViewerContainers(tabID);
        this.deps.initSyncState(tabID);
        this.deps.startSyncPolling(tabID);
      },
      500,
    );
  }

  schedule(
    tabID: string,
    state: SplitTabState,
    win: Window,
    leftBrowser: XULBrowserElement,
    rightBrowser: XULBrowserElement,
  ): void {
    this.deps.trackTimeout(
      state,
      () => {
        const current = this.deps.getState(tabID);
        if (!current) return;

        this.deps.setupResizeListener(tabID, win);
        this.deps.setupCtrlKeyListener(tabID, leftBrowser);
        this.deps.setupCtrlKeyListener(tabID, rightBrowser);
        this.deps.setupMainWindowKeyboardListener(tabID, win);
        this.deps.setupZoomButtonListeners(tabID, leftBrowser);
        this.deps.setupZoomButtonListeners(tabID, rightBrowser);
        this.deps.setupContextPaneObserver(tabID, win);
        if (current.primarySide) {
          this.deps.cacheViewerContainers(tabID);
          this.deps.initSyncState(tabID);
          this.deps.startSyncPolling(tabID);
        }
        this.deps.updateScrollbar(tabID);
      },
      500,
    );
  }
}
