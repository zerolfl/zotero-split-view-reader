import type { SplitSide, SplitTabState } from "./types";
import type { SplitReaderHost } from "./readerHost";

export interface SplitReaderInitializationDependencies {
  getState(tabID: string): SplitTabState | null;
  getReadAloudConfig(
    browser: XULBrowserElement,
    ftl: string[],
    onStatus: (status: any) => void,
  ): Promise<Record<string, any>>;
  handleReadAloudStatus(
    tabID: string,
    browser: XULBrowserElement,
    status: any,
  ): void;
  openContextMenu(
    browser: XULBrowserElement,
    popupset: XULElement,
    params: any,
  ): void;
  toggleSidebar(tabID: string, browser: XULBrowserElement, open: boolean): void;
  shouldSyncLastReadAloudPosition(
    state: SplitTabState,
    browser: XULBrowserElement,
    viewState: any,
  ): boolean;
  syncLastReadAloudPosition(item: Zotero.Item, viewState: any): void;
  writeSession(state: SplitTabState): void;
  saveAnnotations(
    item: Zotero.Item,
    browser: XULBrowserElement,
    annotations: any[],
    readerWindow: Window,
  ): Promise<void>;
  deleteAnnotations(itemID: number, ids: string[]): Promise<void>;
  reportAnnotationFailure(browser: XULBrowserElement, error: unknown): void;
  toggleContextPane(tabID: string): void;
  afterReady(tabID: string, browser: XULBrowserElement, side: SplitSide): void;
}

export class SplitReaderInitialization {
  constructor(
    private readonly host: SplitReaderHost,
    private readonly deps: SplitReaderInitializationDependencies,
  ) {}

  initialize(
    tabID: string,
    browser: XULBrowserElement,
    item: Zotero.Item,
    popupset: XULElement,
    viewState?: any,
    isRight = false,
  ): Promise<void> {
    return this.host.initialize({
      browser,
      item,
      viewState,
      isRight,
      getReadAloudConfig: (ftl, onStatus) =>
        this.deps.getReadAloudConfig(browser, ftl, onStatus),
      callbacks: {
        onReadAloudStatus: (status) =>
          this.deps.handleReadAloudStatus(tabID, browser, status),
        openContextMenu: (params) =>
          this.deps.openContextMenu(browser, popupset, params),
        toggleSidebar: (open) => this.deps.toggleSidebar(tabID, browser, open),
        onViewStateChange: (viewState) =>
          this.updateViewState(tabID, browser, item, viewState),
        saveAnnotations: async (annotations, callback, readerWindow) => {
          try {
            await this.deps.saveAnnotations(
              item,
              browser,
              annotations,
              readerWindow,
            );
          } catch (error) {
            this.deps.reportAnnotationFailure(browser, error);
          } finally {
            callback?.();
          }
        },
        deleteAnnotations: (ids) => {
          void this.deps
            .deleteAnnotations(item.id, ids)
            .catch((error) =>
              this.deps.reportAnnotationFailure(browser, error),
            );
        },
        toggleContextPane: () => this.deps.toggleContextPane(tabID),
        afterReady: () =>
          this.deps.afterReady(tabID, browser, isRight ? "right" : "left"),
      },
    });
  }

  private updateViewState(
    tabID: string,
    browser: XULBrowserElement,
    item: Zotero.Item,
    viewState: any,
  ): void {
    const state = this.deps.getState(tabID);
    if (
      !state ||
      state.isCleaningUp ||
      (browser !== state.leftBrowser && browser !== state.rightBrowser)
    )
      return;

    const copy = JSON.parse(JSON.stringify(viewState));
    if (browser === state.leftBrowser) state.leftViewState = copy;
    else state.rightViewState = copy;
    this.deps.writeSession(state);
    if (this.deps.shouldSyncLastReadAloudPosition(state, browser, viewState)) {
      this.deps.syncLastReadAloudPosition(item, viewState);
    }
  }
}
