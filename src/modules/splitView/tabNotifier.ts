import type { SplitTabState } from "./types";

export interface SplitTabNotifierDependencies {
  getState(tabID: string): SplitTabState | null;
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

  ensureRegistered(win: Window): void {
    if (this.id) return;
    this.id = this.deps.registerNotifier({
      notify: (action, type, ids) => {
        if (type !== "tab") return;
        const tabID = String(ids[0]);
        const state = this.deps.getState(tabID);

        if (action === "select") {
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
    const leftBrowser = state.leftBrowser;
    const rightBrowser = state.rightBrowser;
    const leftItemID = state.leftItemID;
    const rightItemID = state.rightItemID;
    const leftFallback = state.leftViewState;
    const rightFallback = state.rightViewState;
    let leftViewState: any = null;
    let rightViewState: any = null;
    try {
      leftViewState = this.deps.captureViewState(leftBrowser);
    } catch {
      // Browser may be dead.
    }
    try {
      rightViewState = this.deps.captureViewState(rightBrowser);
    } catch {
      // Browser may be dead.
    }
    try {
      const entries: [number, any][] =
        leftItemID === rightItemID
          ? [
              [
                leftItemID,
                state.activeSide === "right"
                  ? rightViewState || rightFallback
                  : leftViewState || leftFallback,
              ],
            ]
          : [
              [leftItemID, leftViewState || leftFallback],
              [rightItemID, rightViewState || rightFallback],
            ];
      void Promise.all(
        entries.map(([itemID, view]) => this.deps.saveViewState(itemID, view)),
      ).catch(() => {
        // Ignore save errors while tabs or the application are closing.
      });
    } catch {
      // Ignore synchronous save errors while tabs are closing.
    }
  }
}
