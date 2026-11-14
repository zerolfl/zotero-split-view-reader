import { createSplitTabState } from "./state";
import type { SplitReaderTabShell } from "../../platform/splitReaderTab";
import type { SplitTabState } from "./types";

export interface SplitViewCreationDependencies {
  getDefaultPrimarySide(): "left" | "right" | null;
  setState(tabID: string, state: SplitTabState): void;
  setupShell(
    tabID: string,
    state: SplitTabState,
    shell: SplitReaderTabShell,
    win: Window,
  ): void;
  initializeReader(
    tabID: string,
    browser: XULBrowserElement,
    item: Zotero.Item,
    popupset: XULElement,
    viewState: any,
    isRight: boolean,
  ): Promise<void>;
  showLoaded(isSamePDF: boolean): void;
  updateContextPane(tabID: string, win: Window, itemID: number): void;
  setupFocusListeners(
    tabID: string,
    leftBrowser: XULBrowserElement,
    rightBrowser: XULBrowserElement,
    win: Window,
  ): void;
  bindAnnotations(state: SplitTabState): void;
  scheduleDelayedSetup(
    tabID: string,
    state: SplitTabState,
    win: Window,
    leftBrowser: XULBrowserElement,
    rightBrowser: XULBrowserElement,
  ): void;
  writeSession(state: SplitTabState): void;
  renameTab(tabID: string): Promise<void>;
  cleanup(tabID: string): void;
}

export interface SplitViewCreationOptions {
  win: Window;
  tabID: string;
  shell: SplitReaderTabShell;
  leftItem: Zotero.Item;
  rightItem: Zotero.Item;
  leftViewState: any;
  rightViewState: any;
  isSamePDF: boolean;
}

export class SplitViewCreationService {
  constructor(private readonly deps: SplitViewCreationDependencies) {}

  async createAndInitialize(options: SplitViewCreationOptions): Promise<void> {
    const {
      win,
      tabID,
      shell,
      leftItem,
      rightItem,
      leftViewState,
      rightViewState,
      isSamePDF,
    } = options;
    const leftParentItemID = leftItem.parentItemID || leftItem.id;
    const rightParentItemID = rightItem.parentItemID || rightItem.id;
    const state = createSplitTabState({
      tabID,
      ownerWindow: win,
      container: shell.container as unknown as XUL.Box,
      originalReaderContainer: shell.originalContainer,
      leftBrowser: shell.leftBrowser,
      rightBrowser: shell.rightBrowser,
      leftPopupset: shell.leftPopupset,
      rightPopupset: shell.rightPopupset,
      leftItemID: leftItem.id,
      rightItemID: rightItem.id,
      leftParentItemID,
      rightParentItemID,
      primarySide: this.deps.getDefaultPrimarySide(),
      eventListeners: shell.eventListeners,
      leftViewState,
      rightViewState,
      isSamePDF,
    });
    this.deps.setState(tabID, state);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      this.deps.setupShell(tabID, state, shell, win);
      const initialized = Promise.all([
        this.deps.initializeReader(
          tabID,
          shell.leftBrowser,
          leftItem,
          shell.leftPopupset,
          leftViewState,
          false,
        ),
        this.deps.initializeReader(
          tabID,
          shell.rightBrowser,
          rightItem,
          shell.rightPopupset,
          rightViewState,
          true,
        ),
      ]);
      await Promise.race([
        initialized,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Split reader initialization timed out")),
            30000,
          );
        }),
      ]);
      if (state.isCleaningUp)
        throw new Error("Split reader initialization cancelled");

      this.deps.showLoaded(isSamePDF);
      state.activeSide = "left";
      this.deps.updateContextPane(tabID, win, state.leftParentItemID);
      this.deps.setupFocusListeners(
        tabID,
        shell.leftBrowser,
        shell.rightBrowser,
        win,
      );
      if (isSamePDF) this.deps.bindAnnotations(state);
      this.deps.scheduleDelayedSetup(
        tabID,
        state,
        win,
        shell.leftBrowser,
        shell.rightBrowser,
      );
      this.deps.writeSession(state);
      await this.deps.renameTab(tabID);
    } catch (error) {
      this.deps.cleanup(tabID);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
