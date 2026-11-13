import type { SplitSide, SplitTabState } from "./types";

export interface PDFReplacementDependencies {
  getState(tabID: string): SplitTabState | null;
  getItem(itemID: number): Zotero.Item | undefined;
  selectPDF(libraryID: number): Promise<Zotero.Item | null>;
  getStoredViewState(item: Zotero.Item): Promise<any>;
  replaceBrowser(
    tabID: string,
    side: SplitSide,
  ): Promise<XULBrowserElement | null>;
  getMainWindow(): Window;
  initializeReader(
    tabID: string,
    browser: XULBrowserElement,
    item: Zotero.Item,
    popupset: XULElement,
    viewState: any,
    isRight: boolean,
  ): Promise<void>;
  setupBrowserFocusListeners(
    tabID: string,
    browser: XULBrowserElement,
    side: SplitSide,
    win: Window,
  ): void;
  setupCtrlKeyListener(tabID: string, browser: XULBrowserElement): void;
  setupZoomButtonListeners(tabID: string, browser: XULBrowserElement): void;
  stopSyncPolling(tabID: string): void;
  updateScrollbarColors(tabID: string): void;
  bindAnnotations(state: SplitTabState): void;
  updateSession(tabID: string): void;
  renameTab(tabID: string): Promise<void>;
  scheduleSyncRestart(tabID: string, state: SplitTabState): void;
  showLoaded(): void;
  showFailure(): void;
  debug(message: string): void;
}

export class PDFReplacementService {
  constructor(private readonly deps: PDFReplacementDependencies) {}

  async selectAndLoad(tabID: string, side: SplitSide): Promise<void> {
    const state = this.deps.getState(tabID);
    if (!state || state.isCleaningUp) return;

    const currentItemID =
      side === "left" ? state.leftItemID : state.rightItemID;
    const currentItem = this.deps.getItem(currentItemID);
    if (!currentItem) return;

    const selectedPDF = await this.deps.selectPDF(currentItem.libraryID);
    if (!selectedPDF) return;
    if (selectedPDF.id === currentItemID) {
      this.deps.showLoaded();
      return;
    }

    try {
      const hadPrimary = !!state.primarySide;
      if (hadPrimary) this.deps.stopSyncPolling(tabID);

      const viewState = await this.deps.getStoredViewState(selectedPDF);
      const popupset =
        side === "left" ? state.leftPopupset : state.rightPopupset;
      const browser = await this.deps.replaceBrowser(tabID, side);
      if (!browser) throw new Error("Failed to replace browser element");

      const win = this.deps.getMainWindow();
      await this.deps.initializeReader(
        tabID,
        browser,
        selectedPDF,
        popupset,
        viewState,
        side === "right",
      );
      this.deps.setupBrowserFocusListeners(tabID, browser, side, win);
      this.deps.setupCtrlKeyListener(tabID, browser);
      this.deps.setupZoomButtonListeners(tabID, browser);

      if (side === "left") {
        state.leftItemID = selectedPDF.id;
        state.leftParentItemID = selectedPDF.parentItemID || selectedPDF.id;
      } else {
        state.rightItemID = selectedPDF.id;
        state.rightParentItemID = selectedPDF.parentItemID || selectedPDF.id;
      }
      state.isSamePDF = state.leftItemID === state.rightItemID;
      if (state.isSamePDF) this.deps.bindAnnotations(state);

      this.deps.updateScrollbarColors(tabID);
      this.deps.updateSession(tabID);
      await this.deps.renameTab(tabID);
      if (hadPrimary) this.deps.scheduleSyncRestart(tabID, state);
      this.deps.showLoaded();
    } catch (error) {
      this.deps.debug(
        `Split view: Error loading PDF on ${side} side: ${error}`,
      );
      this.deps.showFailure();
    }
  }
}
