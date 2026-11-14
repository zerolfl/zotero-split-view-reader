import type { SplitTabState } from "./types";

export interface SplitTabNotifierDependencies {
  getState(tabID: string): SplitTabState | null;
  getWindowForTab(tabID: string): Window | null;
  getActiveParentItemID(state: SplitTabState): number;
  showForSplitView(win: Window): void;
  updateContextPane(tabID: string, win: Window, itemID: number): void;
  captureViewState(browser: XULBrowserElement): any;
  saveViewState(itemID: number, viewState: any): Promise<void>;
  cleanupResources(tabID: string): void;
  registerNotifier(callback: {
    notify(
      action: string,
      type: string,
      ids: (string | number)[],
      extraData: any,
    ): void;
  }): string;
  unregisterNotifier(id: string): void;
  debug(message: string): void;
}

export class SplitTabNotifier {
  private id: string | null = null;

  constructor(private readonly deps: SplitTabNotifierDependencies) {}

  ensureRegistered(): void {
    if (this.id) return;
    this.id = this.deps.registerNotifier({
      notify: (action, type, ids) => {
        if (type !== "tab") return;
        const tabID = String(ids[0]);
        const state = this.deps.getState(tabID);

        if (action === "select") {
          const win = state?.ownerWindow || this.deps.getWindowForTab(tabID);
          if (!win) return;
          if (state && !state.isCleaningUp) {
            win.document.documentElement?.classList.add("split-view-active");
            this.deps.showForSplitView(win);
            this.deps.updateContextPane(
              tabID,
              win,
              this.deps.getActiveParentItemID(state),
            );
          } else {
            win.document.documentElement?.classList.remove("split-view-active");
          }
        } else if (action === "close" && state && !state.isCleaningUp) {
          this.saveState(state);
          this.deps.cleanupResources(tabID);
        }
      },
    });
  }

  saveAll(states: Iterable<SplitTabState>): void {
    for (const state of states) {
      if (state.isCleaningUp) continue;
      try {
        this.save(state);
      } catch {
        // Continue saving the remaining tabs during shutdown.
      }
    }
  }

  save(state: SplitTabState): void {
    this.saveState(state);
  }

  async saveStateAndWait(state: SplitTabState): Promise<void> {
    const leftViewState = this.captureViewState(state.leftBrowser);
    const rightViewState = this.captureViewState(state.rightBrowser);
    const entries: [number, any][] =
      state.leftItemID === state.rightItemID
        ? [
            [
              state.leftItemID,
              state.activeSide === "right"
                ? rightViewState || state.rightViewState
                : leftViewState || state.leftViewState,
            ],
          ]
        : [
            [state.leftItemID, leftViewState || state.leftViewState],
            [state.rightItemID, rightViewState || state.rightViewState],
          ];

    state.leftViewState = leftViewState || state.leftViewState;
    state.rightViewState = rightViewState || state.rightViewState;
    await Promise.all(
      entries.map(([itemID, viewState]) =>
        this.deps.saveViewState(itemID, viewState),
      ),
    );
  }

  unregister(): void {
    if (!this.id) return;
    try {
      this.deps.unregisterNotifier(this.id);
    } catch (error) {
      this.deps.debug(`Split view: unregister tab notifier failed: ${error}`);
    }
    this.id = null;
  }

  private saveState(state: SplitTabState): void {
    void this.saveStateAndWait(state).catch(() => {
      // Ignore save errors while tabs or the application are closing.
    });
  }

  private captureViewState(browser: XULBrowserElement): any {
    try {
      return this.deps.captureViewState(browser);
    } catch {
      return null;
    }
  }
}
