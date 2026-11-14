export type SplitSide = "left" | "right";

export interface TrackedEventListener {
  target: EventTarget;
  type: string;
  listener: EventListener;
  options?: boolean | AddEventListenerOptions;
}

export interface ToolbarCloseObserver {
  side: SplitSide;
  observer: MutationObserver;
}

export interface SplitTabState {
  tabID: string;
  ownerWindow: Window;
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
  activeSide: SplitSide;
  readAloudSide: SplitSide | null;
  readAloudStatuses: {
    left: any | null;
    right: any | null;
  };
  scrollHandler: (() => void) | null;
  scrollHandlerBrowser: XULBrowserElement | null;
  lastPrimaryScroll: { top: number; left: number } | null;
  syncPaused: boolean;
  sidebarToggleTimers: number[];
  ctrlPressed: boolean;
  zoomingCount: number;
  eventListeners: TrackedEventListener[];
  timeoutIds: number[];
  toolbarCloseObservers: ToolbarCloseObserver[];
  contextPaneObserver: MutationObserver | null;
  leftViewerContainer: Element | null;
  rightViewerContainer: Element | null;
  splitRatio: number;
  leftViewState: any;
  rightViewState: any;
  originalTitle?: string;
  isCleaningUp: boolean;
  isSamePDF: boolean;
  disposeAnnotations?: () => void;
  scrollSyncRAFPending: boolean;
  lastScrollSyncTime: number;
  resizeTimerId: number | null;
  dragOverlay?: HTMLElement | null;
}

export interface SeparateViewTarget {
  itemID: number;
  tabID: string | null;
  viewState: any;
  side: SplitSide;
}
