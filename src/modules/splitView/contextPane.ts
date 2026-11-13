import type { SplitTabState } from "./types";

export interface SplitViewContextPaneDependencies {
  getState(tabID: string): SplitTabState | undefined;
  getMainWindow(): Window;
  showForSplitView(win: Window): void;
  toggleMainPane(win: Window): boolean;
  isMainPaneOpen(win: Window): boolean;
  setReaderOpen(browser: XULBrowserElement, open: boolean): void;
  trackTimeout(
    state: SplitTabState,
    callback: () => void,
    delay: number,
  ): number;
}

export class SplitViewContextPane {
  constructor(private readonly deps: SplitViewContextPaneDependencies) {}

  setupForCreatedTab(tabID: string, win: Window): void {
    const state = this.deps.getState(tabID);
    if (!state) return;

    this.deps.showForSplitView(win);
    this.deps.trackTimeout(state, () => this.deps.showForSplitView(win), 300);
  }

  toggleForReader(tabID: string): void {
    const win = this.deps.getMainWindow();
    if (!this.deps.toggleMainPane(win)) return;

    const state = this.deps.getState(tabID);
    if (!state) return;

    this.deps.trackTimeout(
      state,
      () => {
        if (this.deps.getState(tabID) !== state) return;
        if (!state?.rightBrowser) return;
        this.deps.setReaderOpen(
          state.rightBrowser,
          this.deps.isMainPaneOpen(win),
        );
      },
      50,
    );
  }
}
