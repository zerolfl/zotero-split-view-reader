import type { SplitSide, SplitTabState } from "./types";
import { readerView } from "../../platform/readerView";
import { contextPane as splitContextPane } from "../../platform/contextPane";
import { getPref } from "../../utils/prefs";

interface SplitInteractionSync {
  initSyncState(tabID: string): void;
  startSyncPolling(tabID: string): void;
  stopSyncPolling(tabID: string): void;
  handleKeyboardZoom(
    tabID: string,
    isLeft: boolean,
    direction: "in" | "out",
  ): void;
}

export interface SplitInteractionsDependencies {
  getState(tabID: string): SplitTabState | undefined;
  getEffectivePrimarySide(state: SplitTabState): SplitSide | null;
  sync: SplitInteractionSync;
  trackEventListener(
    state: SplitTabState,
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ): void;
  updateScrollbarColors(tabID: string): void;
}

export class SplitInteractions {
  constructor(private readonly deps: SplitInteractionsDependencies) {}

  setupContextPaneObserver(tabID: string, win: Window): void {
    const state = this.deps.getState(tabID);
    if (!state) return;
    splitContextPane.disconnectObserver(state.contextPaneObserver);
    state.contextPaneObserver = splitContextPane.observeCollapsed(
      win,
      (isOpen) => {
        const currentState = this.deps.getState(tabID);
        if (currentState?.rightBrowser) {
          splitContextPane.setReaderOpen(currentState.rightBrowser, isOpen);
        }
      },
    );
  }

  setupCtrlKeyListener(tabID: string, browser: XULBrowserElement): void {
    const state = this.deps.getState(tabID);
    if (!state) return;

    try {
      const wrappedWin = readerView.getPrimaryViewWindowFromBrowser(browser);
      if (!wrappedWin) return;
      const doc = wrappedWin.document;
      if (!doc) return;

      const readerWin = browser.contentWindow;
      const wrappedReaderWin = readerWin
        ? (readerWin as any).wrappedJSObject || readerWin
        : null;

      const keydownHandler = (event: KeyboardEvent) => {
        const current = this.deps.getState(tabID);
        if (!current) return;
        if (event.key === "Control") current.ctrlPressed = true;
      };
      this.deps.trackEventListener(
        state,
        doc,
        "keydown",
        keydownHandler as EventListener,
        true,
      );
      if (wrappedReaderWin?.document) {
        this.deps.trackEventListener(
          state,
          wrappedReaderWin.document,
          "keydown",
          keydownHandler as EventListener,
          true,
        );
      }

      const resetCtrlState = () => {
        const current = this.deps.getState(tabID);
        if (!current) return;
        current.ctrlPressed = false;
        this.deps.sync.initSyncState(tabID);
      };
      const keyupHandler = (event: KeyboardEvent) => {
        if (event.key === "Control") resetCtrlState();
      };
      for (const document of [doc, wrappedReaderWin?.document]) {
        if (!document) continue;
        this.deps.trackEventListener(
          state,
          document,
          "keyup",
          keyupHandler as EventListener,
          true,
        );
      }
      for (const win of [wrappedWin, wrappedReaderWin]) {
        if (!win) continue;
        this.deps.trackEventListener(
          state,
          win,
          "blur",
          resetCtrlState as EventListener,
        );
      }
    } catch {
      // Ignore errors from unloaded reader documents.
    }
  }

  setupResizeListener(tabID: string, win: Window): void {
    const state = this.deps.getState(tabID);
    if (!state) return;

    const resizeHandler = () => {
      const current = this.deps.getState(tabID);
      if (!current) return;
      current.syncPaused = true;
      if (current.resizeTimerId !== null) {
        win.clearTimeout(current.resizeTimerId);
      }
      current.resizeTimerId = win.setTimeout(() => {
        const latest = this.deps.getState(tabID);
        if (!latest) return;
        this.deps.sync.initSyncState(tabID);
        latest.syncPaused = false;
        latest.resizeTimerId = null;
      }, 200);
    };

    this.deps.trackEventListener(
      state,
      win,
      "resize",
      resizeHandler as EventListener,
    );
  }

  setupMainWindowKeyboardListener(tabID: string, win: Window): void {
    const state = this.deps.getState(tabID);
    if (!state) return;

    const keydownHandler = (event: KeyboardEvent) => {
      const current = this.deps.getState(tabID);
      if (!current || !event.ctrlKey || event.altKey || event.metaKey) return;

      const isZoomIn =
        event.key === "+" ||
        event.key === "=" ||
        event.code === "Equal" ||
        event.code === "NumpadAdd";
      const isZoomOut =
        event.key === "-" ||
        event.key === "_" ||
        event.code === "Minus" ||
        event.code === "NumpadSubtract";
      if (!isZoomIn && !isZoomOut) return;

      const activeElement = win.document.activeElement;
      const leftBrowserFocused =
        current.leftBrowser.contains(activeElement) ||
        current.leftBrowser === activeElement;
      const rightBrowserFocused =
        current.rightBrowser.contains(activeElement) ||
        current.rightBrowser === activeElement;
      const isLeft = leftBrowserFocused
        ? true
        : rightBrowserFocused
          ? false
          : current.activeSide === "left";

      const primarySide = this.deps.getEffectivePrimarySide(current);
      if (!primarySide) return;
      if (
        (isLeft && primarySide !== "left") ||
        (!isLeft && primarySide !== "right")
      )
        return;

      this.deps.sync.handleKeyboardZoom(tabID, isLeft, isZoomIn ? "in" : "out");
    };

    this.deps.trackEventListener(
      state,
      win,
      "keydown",
      keydownHandler as EventListener,
      true,
    );
  }

  activateSide(tabID: string, side: SplitSide, win: Window): void {
    const state = this.deps.getState(tabID);
    if (!state || state.isCleaningUp) return;
    const shouldPromotePrimary =
      getPref("followFocusPrimary") &&
      state.primarySide !== null &&
      state.primarySide !== side;
    if (state.activeSide === side && !shouldPromotePrimary) return;

    state.activeSide = side;
    if (shouldPromotePrimary) {
      state.primarySide = side;
      this.deps.sync.stopSyncPolling(tabID);
      this.deps.sync.initSyncState(tabID);
      this.deps.sync.startSyncPolling(tabID);
    }

    this.deps.updateScrollbarColors(tabID);
    if (state.leftParentItemID === state.rightParentItemID) return;
    const parentItemID =
      side === "left" ? state.leftParentItemID : state.rightParentItemID;
    splitContextPane.updateItem(tabID, win, parentItemID);
  }

  setupBrowserFocusListeners(
    tabID: string,
    browser: XULBrowserElement,
    side: SplitSide,
    win: Window,
  ): void {
    const state = this.deps.getState(tabID);
    if (!state) return;
    const scheduleActivation = () =>
      win.setTimeout(() => this.activateSide(tabID, side, win), 0);
    this.deps.trackEventListener(
      state,
      browser,
      "click",
      scheduleActivation as EventListener,
      true,
    );
    this.deps.trackEventListener(
      state,
      browser,
      "focus",
      scheduleActivation as EventListener,
      true,
    );
  }

  setupFocusListeners(
    tabID: string,
    leftBrowser: XULBrowserElement,
    rightBrowser: XULBrowserElement,
    win: Window,
  ): void {
    this.setupBrowserFocusListeners(tabID, leftBrowser, "left", win);
    this.setupBrowserFocusListeners(tabID, rightBrowser, "right", win);
  }
}
