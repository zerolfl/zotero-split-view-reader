import type { SplitSide, SplitTabState } from "./types";
import { readerView } from "../../platform/readerView";
import { readerRuntime } from "../../platform/readerRuntime";

type ZoomDirection = "in" | "out" | "reset";

interface SplitSyncOptions {
  getState: (tabID: string) => SplitTabState | undefined;
  getEffectivePrimarySide: (state: SplitTabState) => SplitSide | null;
  getMainWindow: () => Window;
  trackEventListener: (
    state: SplitTabState,
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  trackTimeout: (
    state: SplitTabState,
    callback: () => void,
    delay: number,
  ) => number;
  onPositionSynced: (
    side: SplitSide,
    result: { pageIndexClamped?: boolean } | null,
  ) => void;
}

export class SplitSync {
  private readonly syncThreshold = 1;

  constructor(private readonly options: SplitSyncOptions) {}

  cacheViewerContainers(tabID: string): void {
    const state = this.options.getState(tabID);
    if (!state || state.isCleaningUp) return;
    try {
      state.leftViewerContainer = readerView.getViewerContainerFromBrowser(
        state.leftBrowser,
      );
      state.rightViewerContainer = readerView.getViewerContainerFromBrowser(
        state.rightBrowser,
      );
    } catch (error) {
      Zotero.debug(
        `Split view: cacheViewerContainers error (browsers may be dead): ${error}`,
      );
    }
  }

  initSyncState(tabID: string): void {
    const state = this.options.getState(tabID);
    if (!state || state.isCleaningUp) return;
    const primarySide = this.options.getEffectivePrimarySide(state);
    if (!primarySide) {
      state.lastPrimaryScroll = null;
      return;
    }

    try {
      this.cacheViewerContainers(tabID);
      const primaryContainer =
        primarySide === "left"
          ? state.leftViewerContainer
          : state.rightViewerContainer;
      if (primaryContainer) {
        state.lastPrimaryScroll = {
          top: primaryContainer.scrollTop,
          left: primaryContainer.scrollLeft,
        };
      }
    } catch (error) {
      Zotero.debug(
        `Split view: initSyncState error (browser may be dead): ${error}`,
      );
    }
  }

  startSyncPolling(tabID: string): void {
    const state = this.options.getState(tabID);
    if (!state || state.isCleaningUp) return;
    const primarySide = this.options.getEffectivePrimarySide(state);
    if (!primarySide) return;

    try {
      const primaryBrowser =
        primarySide === "left" ? state.leftBrowser : state.rightBrowser;
      const primaryContainer =
        readerView.getViewerContainerFromBrowser(primaryBrowser);
      if (!primaryContainer) return;

      const win = this.options.getMainWindow();
      state.scrollHandler = () => {
        const current = this.options.getState(tabID);
        if (!current || current.isCleaningUp || current.scrollSyncRAFPending)
          return;
        if (Date.now() - current.lastScrollSyncTime < 16) return;

        current.scrollSyncRAFPending = true;
        win.requestAnimationFrame(() => {
          const latest = this.options.getState(tabID);
          if (!latest || latest.isCleaningUp) return;
          latest.scrollSyncRAFPending = false;
          latest.lastScrollSyncTime = Date.now();
          this.syncViews(tabID);
        });
      };
      primaryContainer.addEventListener("scroll", state.scrollHandler, {
        passive: true,
      });
      state.scrollHandlerBrowser = primaryBrowser;
    } catch (error) {
      Zotero.debug(
        `Split view: startSyncPolling error (browser may be dead): ${error}`,
      );
    }
  }

  stopSyncPolling(tabID: string): void {
    const state = this.options.getState(tabID);
    if (!state) return;
    if (state.scrollHandler) {
      try {
        const container = state.scrollHandlerBrowser
          ? readerView.getViewerContainerFromBrowser(state.scrollHandlerBrowser)
          : null;
        container?.removeEventListener("scroll", state.scrollHandler);
      } catch {
        // The browser may already be destroyed.
      }
      state.scrollHandler = null;
      state.scrollHandlerBrowser = null;
    }
    state.scrollSyncRAFPending = false;
  }

  syncViews(tabID: string): void {
    const state = this.options.getState(tabID);
    if (!state || state.isCleaningUp) return;
    const primarySide = this.options.getEffectivePrimarySide(state);
    if (!primarySide || !state.lastPrimaryScroll || state.syncPaused) return;

    try {
      const primaryContainer =
        primarySide === "left"
          ? state.leftViewerContainer
          : state.rightViewerContainer;
      const secondaryContainer =
        primarySide === "left"
          ? state.rightViewerContainer
          : state.leftViewerContainer;
      if (!primaryContainer || !secondaryContainer) return;

      const primaryTop = primaryContainer.scrollTop;
      const primaryLeft = primaryContainer.scrollLeft;
      if (state.ctrlPressed || state.zoomingCount > 0) {
        state.lastPrimaryScroll = { top: primaryTop, left: primaryLeft };
        return;
      }
      const deltaTop = primaryTop - state.lastPrimaryScroll.top;
      const deltaLeft = primaryLeft - state.lastPrimaryScroll.left;
      if (
        Math.abs(deltaTop) >= this.syncThreshold ||
        Math.abs(deltaLeft) >= this.syncThreshold
      ) {
        secondaryContainer.scrollTo(
          Math.max(0, secondaryContainer.scrollLeft + deltaLeft),
          Math.max(0, secondaryContainer.scrollTop + deltaTop),
        );
        state.lastPrimaryScroll = { top: primaryTop, left: primaryLeft };
      }
    } catch (error) {
      Zotero.debug(`Split view: syncViews error: ${error}`);
    }
  }

  handleSidebarToggle(
    tabID: string,
    sourceBrowser: XULBrowserElement,
    open: boolean,
  ): void {
    const state = this.options.getState(tabID);
    if (!state || state.isCleaningUp) return;
    const primarySide = this.options.getEffectivePrimarySide(state);
    if (!primarySide) return;

    const isLeft = sourceBrowser === state.leftBrowser;
    const isPrimary =
      (isLeft && primarySide === "left") ||
      (!isLeft && primarySide === "right");
    if (!isPrimary) return;

    const win = this.options.getMainWindow();
    for (const timerID of state.sidebarToggleTimers) win.clearTimeout(timerID);
    state.sidebarToggleTimers = [];
    state.syncPaused = true;

    const secondaryBrowser = isLeft ? state.rightBrowser : state.leftBrowser;
    try {
      readerRuntime.setSidebarOpen(secondaryBrowser, open);
    } catch {
      // Ignore errors from an unloading reader.
    }

    const timerID = win.setTimeout(() => {
      const current = this.options.getState(tabID);
      if (!current) return;
      this.initSyncState(tabID);
      current.syncPaused = false;
      current.sidebarToggleTimers = [];
    }, 200);
    state.sidebarToggleTimers.push(timerID);
  }

  async syncPositionAndScale(
    tabID: string,
    currentSide: SplitSide,
  ): Promise<void> {
    const state = this.options.getState(tabID);
    if (!state || state.isCleaningUp) return;
    state.syncPaused = true;

    try {
      const targetSide = currentSide === "left" ? "right" : "left";
      const sourceBrowser =
        targetSide === "left" ? state.leftBrowser : state.rightBrowser;
      const currentBrowser =
        currentSide === "left" ? state.leftBrowser : state.rightBrowser;
      const currentReader =
        readerRuntime.getInternalReaderFromBrowser(currentBrowser);
      if (!currentReader) {
        Zotero.debug(
          "Split view: syncPositionAndScale - current reader not found",
        );
        return;
      }

      const fallbackState =
        targetSide === "left" ? state.leftViewState : state.rightViewState;
      const viewState =
        readerView.getImmediateViewStateFromBrowser(sourceBrowser) ||
        readerView.getCurrentViewStateFromBrowser(sourceBrowser) ||
        (fallbackState ? JSON.parse(JSON.stringify(fallbackState)) : null);
      if (!viewState) {
        Zotero.debug("Split view: syncPositionAndScale - viewState not found");
        return;
      }

      const result = await readerView.applyViewStateToReader(
        currentReader,
        viewState,
      );
      Zotero.debug(
        `Split view: synced ${currentSide} view to ${targetSide} view state ` +
          `(page ${viewState.pageIndex}, top=${viewState.top}, ` +
          `left=${viewState.left}, scale=${viewState.scale})`,
      );
      this.options.onPositionSynced(currentSide, result);
    } catch (error) {
      Zotero.debug(`Split view: syncPositionAndScale error: ${error}`);
    } finally {
      this.options.trackTimeout(
        state,
        () => {
          const current = this.options.getState(tabID);
          if (!current) return;
          current.syncPaused = false;
          this.initSyncState(tabID);
        },
        400,
      );
    }
  }

  setupZoomButtonListeners(tabID: string, browser: XULBrowserElement): void {
    const state = this.options.getState(tabID);
    if (!state) return;

    try {
      const contentWindow = browser.contentWindow;
      if (!contentWindow) return;
      const wrappedWindow =
        (contentWindow as any).wrappedJSObject || contentWindow;
      const doc = wrappedWindow.document;
      if (!doc) return;

      const findButton = (direction: ZoomDirection): Element | null => {
        const selectors =
          direction === "in"
            ? [
                '[data-l10n-id="pdfjs-zoom-in-button"]',
                "#zoomIn",
                ".zoomIn",
                'button[class*="zoomIn"]',
                'button[class*="zoom-in"]',
                '[title*="Zoom In"]',
                '[title*="zoom in"]',
                '[aria-label*="Zoom In"]',
                '[aria-label*="zoom in"]',
                'button[data-tabstop="1"][class*="zoom"]',
              ]
            : direction === "out"
              ? [
                  '[data-l10n-id="pdfjs-zoom-out-button"]',
                  "#zoomOut",
                  ".zoomOut",
                  'button[class*="zoomOut"]',
                  'button[class*="zoom-out"]',
                  '[title*="Zoom Out"]',
                  '[title*="zoom out"]',
                  '[aria-label*="Zoom Out"]',
                  '[aria-label*="zoom out"]',
                ]
              : [
                  "#zoomAuto",
                  ".zoomAuto",
                  'button[class*="zoomAuto"]',
                  'button[class*="zoom-auto"]',
                  '[title*="Zoom Reset"]',
                  '[title*="zoom reset"]',
                  '[title*="Reset Zoom"]',
                  '[title*="reset zoom"]',
                  '[aria-label*="Zoom Reset"]',
                  '[aria-label*="Reset Zoom"]',
                ];
        for (const selector of selectors) {
          try {
            const button = doc.querySelector(selector);
            if (button) return button;
          } catch {
            // Skip selectors unsupported by the embedded document.
          }
        }

        for (const button of doc.querySelectorAll('button, [role="button"]')) {
          const className = (button.className || "").toLowerCase();
          const title = (button.getAttribute("title") || "").toLowerCase();
          const label = (button.getAttribute("aria-label") || "").toLowerCase();
          const values = `${className} ${title} ${label}`;
          if (
            direction === "in" &&
            ["zoomin", "zoom-in", "zoom in", "放大"].some((value) =>
              values.includes(value),
            )
          )
            return button;
          if (
            direction === "out" &&
            ["zoomout", "zoom-out", "zoom out", "缩小"].some((value) =>
              values.includes(value),
            )
          )
            return button;
          if (
            direction === "reset" &&
            [
              "zoomauto",
              "zoom-auto",
              "zoomreset",
              "zoom-reset",
              "zoom reset",
              "reset zoom",
              "重置",
            ].some((value) => values.includes(value))
          )
            return button;
        }
        return null;
      };

      const isLeft = browser === state.leftBrowser;
      for (const direction of ["in", "out", "reset"] as const) {
        const button = findButton(direction);
        if (!button) continue;
        const listener = () =>
          this.handleZoomButtonClick(tabID, isLeft, direction);
        this.options.trackEventListener(
          state,
          button,
          "click",
          listener as EventListener,
          true,
        );
      }
    } catch {
      // The reader toolbar may not be ready or accessible yet.
    }
  }

  handleKeyboardZoom(
    tabID: string,
    isLeft: boolean,
    direction: "in" | "out",
  ): void {
    const state = this.options.getState(tabID);
    if (!state || state.isCleaningUp) return;
    const primarySide = this.options.getEffectivePrimarySide(state);
    if (!primarySide) return;
    const secondaryBrowser =
      primarySide === "left" ? state.rightBrowser : state.leftBrowser;
    state.zoomingCount++;
    this.zoomForBrowser(secondaryBrowser, direction);
    this.resumeAfterZoom(tabID, state, 150);
  }

  private handleZoomButtonClick(
    tabID: string,
    isLeft: boolean,
    direction: ZoomDirection,
  ): void {
    const state = this.options.getState(tabID);
    if (!state || state.isCleaningUp) return;
    const primarySide = this.options.getEffectivePrimarySide(state);
    if (!primarySide) return;
    const isPrimary =
      (isLeft && primarySide === "left") ||
      (!isLeft && primarySide === "right");
    if (!isPrimary || state.ctrlPressed) return;

    const secondaryBrowser =
      primarySide === "left" ? state.rightBrowser : state.leftBrowser;
    state.zoomingCount++;
    this.zoomForBrowser(secondaryBrowser, direction);
    this.resumeAfterZoom(tabID, state, 150);
  }

  private resumeAfterZoom(
    tabID: string,
    state: SplitTabState,
    delay: number,
  ): void {
    this.options.trackTimeout(
      state,
      () => {
        const current = this.options.getState(tabID);
        if (!current) return;
        current.zoomingCount = Math.max(0, current.zoomingCount - 1);
        if (current.zoomingCount === 0) this.initSyncState(tabID);
      },
      delay,
    );
  }

  private zoomForBrowser(
    browser: XULBrowserElement,
    direction: ZoomDirection,
  ): void {
    if (!readerRuntime.isBrowserAlive(browser)) return;
    try {
      const reader = readerRuntime.getInternalReaderFromBrowser(browser);
      const method =
        direction === "in"
          ? "zoomIn"
          : direction === "out"
            ? "zoomOut"
            : "zoomReset";
      if (typeof reader?.[method] === "function") reader[method]();
    } catch (error) {
      Zotero.debug(`Split view: zoom ${direction} error: ${error}`);
    }
  }
}
