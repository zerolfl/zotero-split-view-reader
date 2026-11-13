import type { SplitTabState } from "./types";

export interface SplitTabCleanupDependencies {
  getState(tabID: string): SplitTabState | null;
  removeState(tabID: string): void;
  hasState(tabID: string): boolean;
  hasAnyState(): boolean;
  saveState(state: SplitTabState): void;
  pauseReader(browser: XULBrowserElement): void;
  setAudioStatus(tabID: string): void;
  unloadBrowser(browser: XULBrowserElement): void;
  stopSyncPolling(tabID: string): void;
  getMainWindow(): Window;
  getSelectedTabID(win: Window): string | null;
  disconnectContextPaneObserver(observer: MutationObserver | null): void;
  unregisterTabNotifier(): void;
  debug(message: string): void;
}

export class SplitTabCleanup {
  constructor(private readonly deps: SplitTabCleanupDependencies) {}

  cleanupAndSave(tabID: string): void {
    const state = this.deps.getState(tabID);
    if (!state || state.isCleaningUp) return;

    state.isCleaningUp = true;
    this.deps.saveState(state);
    state.isCleaningUp = false;
    this.cleanup(tabID);
  }

  cleanup(tabID: string): void {
    const state = this.deps.getState(tabID);
    if (!state) return;
    state.isCleaningUp = true;

    const leftBrowser = state.leftBrowser;
    const rightBrowser = state.rightBrowser;
    state.disposeAnnotations?.();
    state.disposeAnnotations = undefined;
    this.deps.pauseReader(leftBrowser);
    this.deps.pauseReader(rightBrowser);
    this.deps.setAudioStatus(tabID);
    this.deps.unloadBrowser(leftBrowser);
    this.deps.unloadBrowser(rightBrowser);

    const eventListeners = [...state.eventListeners];
    const timeoutIds = [...state.timeoutIds];
    const toolbarCloseObservers = [...state.toolbarCloseObservers];
    const sidebarToggleTimers = [...state.sidebarToggleTimers];
    const resizeTimerId = state.resizeTimerId;
    const contextPaneObserver = state.contextPaneObserver;
    const dragOverlay = state.dragOverlay;

    state.eventListeners = [];
    state.timeoutIds = [];
    state.toolbarCloseObservers = [];
    state.sidebarToggleTimers = [];
    state.leftViewerContainer = null;
    state.rightViewerContainer = null;
    state.resizeTimerId = null;
    state.dragOverlay = null;
    state.contextPaneObserver = null;

    this.deps.stopSyncPolling(tabID);
    this.deps.removeState(tabID);

    let win: Window | null = null;
    try {
      win = this.deps.getMainWindow();
    } catch (error) {
      this.deps.debug(
        `Split view: cleanup ${tabID} - getMainWindow failed: ${error}`,
      );
    }

    if (win) this.removeActiveClass(tabID, win);
    this.removeEventListeners(tabID, eventListeners);
    this.disconnectToolbarObservers(tabID, toolbarCloseObservers);
    this.removeDragOverlay(tabID, dragOverlay);
    if (win)
      this.clearTimers(
        tabID,
        win,
        timeoutIds,
        sidebarToggleTimers,
        resizeTimerId,
      );
    this.deps.disconnectContextPaneObserver(contextPaneObserver);
    if (!this.deps.hasAnyState()) this.deps.unregisterTabNotifier();
  }

  private removeActiveClass(tabID: string, win: Window): void {
    try {
      const selectedTabID = this.deps.getSelectedTabID(win);
      if (!selectedTabID || !this.deps.hasState(selectedTabID)) {
        win.document.documentElement?.classList.remove("split-view-active");
      }
    } catch (error) {
      this.deps.debug(
        `Split view: cleanup ${tabID} - remove class failed: ${error}`,
      );
    }
  }

  private removeEventListeners(
    tabID: string,
    entries: SplitTabState["eventListeners"],
  ): void {
    for (const { target, type, listener, options } of entries) {
      try {
        target.removeEventListener(type, listener, options);
      } catch (error) {
        this.deps.debug(
          `Split view: cleanup ${tabID} - removeEventListener(${type}) failed: ${error}`,
        );
      }
    }
  }

  private disconnectToolbarObservers(
    tabID: string,
    entries: SplitTabState["toolbarCloseObservers"],
  ): void {
    for (const { observer } of entries) {
      try {
        observer.disconnect();
      } catch (error) {
        this.deps.debug(
          `Split view: cleanup ${tabID} - toolbar observer disconnect failed: ${error}`,
        );
      }
    }
  }

  private removeDragOverlay(
    tabID: string,
    overlay: HTMLElement | null | undefined,
  ): void {
    if (!overlay?.parentNode) return;
    try {
      overlay.remove();
    } catch (error) {
      this.deps.debug(
        `Split view: cleanup ${tabID} - dragOverlay.remove failed: ${error}`,
      );
    }
  }

  private clearTimers(
    tabID: string,
    win: Window,
    timeoutIds: number[],
    sidebarToggleTimers: number[],
    resizeTimerId: number | null,
  ): void {
    for (const id of [...timeoutIds, ...sidebarToggleTimers]) {
      try {
        win.clearTimeout(id);
      } catch (error) {
        this.deps.debug(
          `Split view: cleanup ${tabID} - clearTimeout failed: ${error}`,
        );
      }
    }
    if (resizeTimerId === null) return;
    try {
      win.clearTimeout(resizeTimerId);
    } catch (error) {
      this.deps.debug(
        `Split view: cleanup ${tabID} - clearTimeout(resize) failed: ${error}`,
      );
    }
  }
}
