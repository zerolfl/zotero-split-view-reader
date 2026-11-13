import type { SplitSide, SplitTabState, TrackedEventListener } from "./types";

export interface SplitTabStateOptions {
  tabID: string;
  container: XUL.Box;
  leftBrowser: XULBrowserElement;
  rightBrowser: XULBrowserElement;
  leftPopupset: XULElement;
  rightPopupset: XULElement;
  leftItemID: number;
  rightItemID: number;
  leftParentItemID: number;
  rightParentItemID: number;
  primarySide: SplitSide | null;
  leftViewState: any;
  rightViewState: any;
  eventListeners: TrackedEventListener[];
  originalTitle?: string;
  isSamePDF: boolean;
}

export function createSplitTabState(
  options: SplitTabStateOptions,
): SplitTabState {
  return {
    ...options,
    activeSide: "left",
    readAloudSide: null,
    readAloudStatuses: {
      left: null,
      right: null,
    },
    scrollHandler: null,
    scrollHandlerBrowser: null,
    lastPrimaryScroll: null,
    syncPaused: false,
    sidebarToggleTimers: [],
    ctrlPressed: false,
    zoomingCount: 0,
    timeoutIds: [],
    toolbarCloseObservers: [],
    contextPaneObserver: null,
    leftViewerContainer: null,
    rightViewerContainer: null,
    splitRatio: 0.5,
    isCleaningUp: false,
    scrollSyncRAFPending: false,
    lastScrollSyncTime: 0,
    resizeTimerId: null,
  };
}
