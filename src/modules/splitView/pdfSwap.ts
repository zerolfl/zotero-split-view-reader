import type { SplitSide, SplitTabState } from "./types";

export interface PDFSwapDependencies {
  getState(tabID: string): SplitTabState | null;
  captureViewState(browser: XULBrowserElement): any;
  replaceBrowser(
    tabID: string,
    side: SplitSide,
  ): Promise<XULBrowserElement | null>;
  getItem(itemID: number): Zotero.Item | undefined;
  getMainWindow(): Window;
  initializeReader(
    tabID: string,
    browser: XULBrowserElement,
    item: Zotero.Item,
    popupset: XULElement,
    viewState: any,
    isRight: boolean,
  ): Promise<void>;
  setupFocusListeners(
    tabID: string,
    leftBrowser: XULBrowserElement,
    rightBrowser: XULBrowserElement,
    win: Window,
  ): void;
  setupCtrlKeyListener(tabID: string, browser: XULBrowserElement): void;
  setupZoomButtonListeners(tabID: string, browser: XULBrowserElement): void;
  stopSyncPolling(tabID: string): void;
  updateScrollbarColors(tabID: string): void;
  updateContextPane(tabID: string, win: Window, itemID: number): void;
  bindAnnotations(state: SplitTabState): void;
  updateSession(tabID: string): void;
  renameTab(tabID: string): Promise<void>;
  scheduleSyncRestart(tabID: string, state: SplitTabState): void;
  showSwapped(): void;
  debug(message: string): void;
}

export class PDFSwapService {
  constructor(private readonly deps: PDFSwapDependencies) {}

  async swap(tabID: string): Promise<void> {
    const state = this.deps.getState(tabID);
    if (!state || state.isCleaningUp) return;

    try {
      const leftViewState =
        this.capture(state.leftBrowser) || state.leftViewState;
      const rightViewState =
        this.capture(state.rightBrowser) || state.rightViewState;
      const oldLeftItemID = state.leftItemID;
      const oldRightItemID = state.rightItemID;
      const oldLeftParentItemID = state.leftParentItemID;
      const oldRightParentItemID = state.rightParentItemID;
      const hadPrimary = !!state.primarySide;
      if (hadPrimary) this.deps.stopSyncPolling(tabID);

      const leftBrowser = await this.deps.replaceBrowser(tabID, "left");
      const rightBrowser = await this.deps.replaceBrowser(tabID, "right");
      if (!leftBrowser || !rightBrowser)
        throw new Error("Failed to replace browser elements for swap");

      state.leftItemID = oldRightItemID;
      state.rightItemID = oldLeftItemID;
      state.leftParentItemID = oldRightParentItemID;
      state.rightParentItemID = oldLeftParentItemID;
      state.leftViewState = rightViewState;
      state.rightViewState = leftViewState;

      const leftItem = this.deps.getItem(state.leftItemID);
      const rightItem = this.deps.getItem(state.rightItemID);
      if (!leftItem || !rightItem)
        throw new Error("Failed to get items for swap");

      const win = this.deps.getMainWindow();
      await Promise.all([
        this.deps.initializeReader(
          tabID,
          leftBrowser,
          leftItem,
          state.leftPopupset,
          rightViewState,
          false,
        ),
        this.deps.initializeReader(
          tabID,
          rightBrowser,
          rightItem,
          state.rightPopupset,
          leftViewState,
          true,
        ),
      ]);

      this.deps.setupFocusListeners(tabID, leftBrowser, rightBrowser, win);
      this.deps.setupCtrlKeyListener(tabID, leftBrowser);
      this.deps.setupCtrlKeyListener(tabID, rightBrowser);
      this.deps.setupZoomButtonListeners(tabID, leftBrowser);
      this.deps.setupZoomButtonListeners(tabID, rightBrowser);
      this.deps.updateScrollbarColors(tabID);

      const activeParentItemID =
        state.activeSide === "left"
          ? state.leftParentItemID
          : state.rightParentItemID;
      this.deps.updateContextPane(tabID, win, activeParentItemID);
      if (state.isSamePDF) this.deps.bindAnnotations(state);

      this.deps.updateSession(tabID);
      await this.deps.renameTab(tabID);
      if (hadPrimary) this.deps.scheduleSyncRestart(tabID, state);
      this.deps.showSwapped();
    } catch (error) {
      this.deps.debug(`Split view: Error swapping PDFs: ${error}`);
    }
  }

  private capture(browser: XULBrowserElement): any {
    try {
      return this.deps.captureViewState(browser);
    } catch {
      return null;
    }
  }
}
