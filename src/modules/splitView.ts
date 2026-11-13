import { attachmentState } from "../platform/attachmentState";
import { readerView } from "../platform/readerView";
import { readerRuntime } from "../platform/readerRuntime";
import { commandPalette } from "../ui/commandPalette";
import { PDFSelector } from "./pdfSelector";
import type { SeparateViewTarget, SplitTabState } from "./splitView/types";
import { SplitReadAloudService } from "./splitView/readAloud";
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { clearPref, getPref } from "../utils/prefs";
import {
  getSplitViewTabTitleForItems,
  type SplitTabsTitleMode,
} from "../utils/splitTabTitle";

export class SplitViewFactory {
  /** Per-tab split view states. Each tab can independently have its own split view. */
  private static stateMap: Map<string, SplitTabState> = new Map();
  private static pdfSelector = new PDFSelector();
  private static readAloud = new SplitReadAloudService({
    states: () => this.stateMap.values(),
    getReader: (browser) => readerRuntime.getInternalReaderFromBrowser(browser),
    isActive: (browser) => !!this.getActiveSplitReaderInfoByBrowser(browser),
  });
  /** Global tab notifier ID - shared across all split view tabs */
  private static globalTabNotifierID: string | null = null;
  /** Session restore notifier ID - for detecting tabs that need split view restoration */
  private static sessionRestoreNotifierID: string | null = null;
  /** Preference observer IDs for scrollbar RGB - apply new color to open split view tabs */
  private static scrollbarPrefObserverIDs: (symbol | null)[] = [
    null,
    null,
    null,
  ];
  /** Preference observer ID for split tab titles - renames open split view tabs */
  private static splitTabsTitlePrefObserverID: symbol | null = null;
  /** Item notifier ID for split tab title updates when either side's item changes */
  private static splitTabTitleItemNotifierID: string | null = null;
  /** Last tab that opened Zotero's tab context menu. */
  private static tabShowInLibraryContext: {
    tabID: string;
    openedAt: number;
    popup?: Element;
  } | null = null;
  private static tabShowInLibraryHandlers: {
    contextmenu: EventListener;
    popupshowing: EventListener;
    popuphidden: EventListener;
  } | null = null;
  private static tabShowInLibraryDocument: Document | null = null;

  /**
   * Look up state for a specific tab
   */
  private static getState(tabID: string): SplitTabState | null {
    return this.stateMap.get(tabID) ?? null;
  }

  private static hasActiveSplitState(
    tabID: string | null | undefined,
  ): boolean {
    if (!tabID) return false;
    const state = this.stateMap.get(tabID);
    return !!state && !state.isCleaningUp;
  }

  private static getActiveParentItemID(state: SplitTabState): number {
    return state.activeSide === "left"
      ? state.leftParentItemID
      : state.rightParentItemID;
  }

  private static getActiveItemID(state: SplitTabState): number {
    return state.activeSide === "left" ? state.leftItemID : state.rightItemID;
  }

  private static installTabShowInLibraryHandler(win: Window): void {
    if (this.tabShowInLibraryHandlers) return;

    const document = win.document;
    const showInLibraryLabel = Zotero.getString("general.showInLibrary");
    const moveTabLabel = Zotero.getString("tabs.move");

    const contextmenu = ((event: Event) => {
      const target = event.target as Element | null;
      const tab = target?.closest?.(
        "#tab-bar-container .tab[data-id]",
      ) as Element | null;
      const tabID = tab?.getAttribute("data-id");
      this.tabShowInLibraryContext = tabID
        ? { tabID, openedAt: Date.now() }
        : null;
    }) as EventListener;

    const popupshowing = ((event: Event) => {
      const popup = event.target as Element | null;
      if (!popup || popup.localName !== "menupopup") return;

      try {
        const context = this.tabShowInLibraryContext;
        if (!context || Date.now() - context.openedAt >= 5000) return;

        const state = this.stateMap.get(context.tabID);
        if (!state || state.isCleaningUp) return;
        const tab = (win as any).Zotero_Tabs?._getTab?.(context.tabID)?.tab;
        if (!tab?.data?.isSplitView) return;

        // Zotero's tab context menu is a temporary top-level popup whose direct
        // children start with “Show in Library” and the “Move Tab” submenu. Avoid
        // scanning descendants or unrelated popups that may contain the same label.
        const popupset = document.querySelector("popupset");
        if (popup.parentElement !== popupset) return;

        const children = Array.from(popup.children) as Element[];
        const showInLibraryItem = children.find(
          (child) =>
            child.localName === "menuitem" &&
            child.getAttribute("label") === showInLibraryLabel,
        );
        const hasMoveTabMenu = children.some(
          (child) =>
            child.localName === "menu" &&
            child.getAttribute("label") === moveTabLabel,
        );
        if (!showInLibraryItem || !hasMoveTabMenu) return;

        const contextTabID = context.tabID;
        context.popup = popup;

        const replacement = showInLibraryItem.cloneNode(true) as Element;
        replacement.addEventListener("command", (commandEvent: Event) => {
          commandEvent.preventDefault();
          commandEvent.stopPropagation();
          commandEvent.stopImmediatePropagation();

          const currentState = this.stateMap.get(contextTabID);
          if (!currentState || currentState.isCleaningUp) return;
          const currentTab = (win as any).Zotero_Tabs?._getTab?.(
            contextTabID,
          )?.tab;
          if (!currentTab?.data?.isSplitView) return;

          let itemID = this.getActiveItemID(currentState);
          const item = Zotero.Items.get(itemID);
          if (item && item.parentItemID) {
            itemID = item.parentItemID;
          }
          const pane = (win as any).ZoteroPane_Local || (win as any).ZoteroPane;
          if (typeof pane?.selectItem === "function") {
            void pane.selectItem(itemID);
          }
        });
        showInLibraryItem.replaceWith(replacement);
      } catch {
        // Ignore popup decoration errors
      }
    }) as EventListener;

    const popuphidden = ((event: Event) => {
      const target = event.target as Element | null;
      const context = this.tabShowInLibraryContext;
      if (target?.localName === "menupopup" && context?.popup === target) {
        this.tabShowInLibraryContext = null;
      }
    }) as EventListener;

    document.addEventListener("contextmenu", contextmenu, true);
    document.addEventListener("popupshowing", popupshowing, true);
    document.addEventListener("popuphidden", popuphidden, true);
    this.tabShowInLibraryDocument = document;
    this.tabShowInLibraryHandlers = {
      contextmenu,
      popupshowing,
      popuphidden,
    };
  }

  private static uninstallTabShowInLibraryHandler(): void {
    try {
      const document = this.tabShowInLibraryDocument;
      if (document && this.tabShowInLibraryHandlers) {
        document.removeEventListener(
          "contextmenu",
          this.tabShowInLibraryHandlers.contextmenu,
          true,
        );
        document.removeEventListener(
          "popupshowing",
          this.tabShowInLibraryHandlers.popupshowing,
          true,
        );
        document.removeEventListener(
          "popuphidden",
          this.tabShowInLibraryHandlers.popuphidden,
          true,
        );
      }
    } catch (e) {
      Zotero.debug(`Split view: uninstallTabShowInLibraryHandler failed: ${e}`);
    } finally {
      this.tabShowInLibraryContext = null;
      this.tabShowInLibraryHandlers = null;
      this.tabShowInLibraryDocument = null;
    }
  }

  /**
   * Get the state for the currently selected Zotero tab (if it has split view)
   */
  private static getActiveTabState(): SplitTabState | null {
    try {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = (win as any).Zotero_Tabs;
      const selectedTabID = Zotero_Tabs?.selectedID;
      if (selectedTabID) {
        return this.stateMap.get(selectedTabID) ?? null;
      }
    } catch {
      // Ignore errors
    }
    return null;
  }

  /**
   * Get the configured split tab title mode.
   */
  private static getSplitTabsTitleMode(): SplitTabsTitleMode {
    const mode = getPref("splitTabsTitle");
    if (
      mode === "titleCreatorYear" ||
      mode === "creatorYearTitle" ||
      mode === "attachmentTitle" ||
      mode === "filename"
    ) {
      return mode;
    }
    return "filename";
  }

  /**
   * Rename a split-view tab using the plugin-specific tab title mode.
   */
  private static async renameSplitViewTab(tabID: string): Promise<void> {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    try {
      const leftItem = Zotero.Items.get(state.leftItemID);
      const rightItem = Zotero.Items.get(state.rightItemID);
      if (!leftItem || !rightItem) return;

      const title = await getSplitViewTabTitleForItems(
        leftItem,
        rightItem,
        this.getSplitTabsTitleMode(),
      );
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = (win as any).Zotero_Tabs;
      await Zotero_Tabs.rename(tabID, title);
    } catch (e) {
      Zotero.debug(`Split view: renameSplitViewTab failed: ${e}`);
    }
  }

  /**
   * Rename all currently open split-view tabs.
   */
  private static async renameAllSplitViewTabs(): Promise<void> {
    for (const tabID of this.stateMap.keys()) {
      await this.renameSplitViewTab(tabID);
    }
  }

  /**
   * Build the title for a split-view tab from stored tab data.
   */
  private static async getSplitViewTitleForTab(tab: any): Promise<string> {
    const leftItemID = tab?.data?.leftItemID ?? tab?.data?.itemID;
    const rightItemID =
      tab?.data?.rightItemID ?? tab?.data?.leftItemID ?? tab?.data?.itemID;
    const leftItem = leftItemID ? Zotero.Items.get(leftItemID) : null;
    const rightItem = rightItemID ? Zotero.Items.get(rightItemID) : null;
    if (!leftItem || !rightItem) {
      return "";
    }

    return getSplitViewTabTitleForItems(
      leftItem,
      rightItem,
      this.getSplitTabsTitleMode(),
    );
  }

  /**
   * Refresh titles of all open split-view tabs.
   * Mirrors Zotero's native reader tab-title refresh behavior.
   */
  static refreshOpenSplitViewTabTitles(): void {
    void this.renameAllSplitViewTabs();
  }

  /**
   * Refresh split-view tab titles affected by item changes.
   * Zotero's native tab title observer only checks tab.data.itemID, which is
   * the left-side item for split tabs, so right-side attachment/parent changes
   * need to be handled by this plugin.
   */
  private static async renameSplitViewTabsForChangedItems(
    ids: (string | number)[],
  ): Promise<void> {
    const changedItemIDs = new Set(
      ids.map((id) => Number(id)).filter((id) => Number.isInteger(id)),
    );
    if (!changedItemIDs.size) return;

    for (const [tabID, state] of this.stateMap.entries()) {
      if (state.isCleaningUp) continue;
      if (
        changedItemIDs.has(state.leftItemID) ||
        changedItemIDs.has(state.rightItemID) ||
        changedItemIDs.has(state.leftParentItemID) ||
        changedItemIDs.has(state.rightParentItemID)
      ) {
        await this.renameSplitViewTab(tabID);
      }
    }
  }

  /**
   * Register an item observer to keep split tab titles in sync for both panes.
   */
  static registerSplitTabTitleItemNotifier() {
    if (this.splitTabTitleItemNotifierID) return;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const notifierCallback = {
      notify: (
        action: string,
        type: string,
        ids: (string | number)[],
        _extraData: any,
      ) => {
        if (type !== "item") return;
        if (action !== "modify" && action !== "refresh") return;

        void self.renameSplitViewTabsForChangedItems(ids);
      },
    };

    this.splitTabTitleItemNotifierID = Zotero.Notifier.registerObserver(
      notifierCallback,
      ["item"],
      "splitViewTabTitle",
      30,
    );
  }

  /**
   * Build a chrome:// URI for an icon bundled with this addon
   */
  private static getIconURI(name: string): string {
    return `chrome://${addon.data.config.addonRef}/content/icons/${name}`;
  }

  /**
   * Apply an icon to a XUL menuitem element (menuitem-iconic style)
   */
  private static setMenuItemIcon(menuitem: Element, iconURI: string) {
    menuitem.classList.add("menuitem-iconic");
    menuitem.setAttribute("image", iconURI);
    menuitem.setAttribute(
      "style",
      "-moz-context-properties: fill; fill: currentColor;",
    );
  }

  private static getCloseViewMenuLabel(): string {
    return getString("splitview-close-menu-label");
  }

  private static getOpenAnotherPDFMenuLabel(): string {
    return getString("splitview-open-another");
  }

  private static getSyncPositionMenuLabel(
    currentSide: "left" | "right" | null,
  ): string {
    if (!currentSide) {
      return getString("splitview-sync-position");
    }
    return getString("splitview-sync-position", {
      args: {
        side: currentSide === "left" ? "right" : "left",
      },
    });
  }

  private static getSetPrimaryMenuLabel(
    state: "current" | "other" | "none",
  ): string {
    return getString("splitview-set-primary", {
      args: { state },
    });
  }

  private static getEffectivePrimarySide(
    state: Pick<SplitTabState, "primarySide">,
  ): "left" | "right" | null {
    return state.primarySide;
  }

  private static clearLegacySyncEnabledPref(): void {
    // The standalone syncEnabled pref was removed. Existing tabs restore their
    // old sync state from session data, so new split views should no longer
    // consult this hidden pref as a long-term default.
    clearPref("syncEnabled");
  }

  private static getDefaultPrimarySide(): "left" | "right" | null {
    return "left";
  }

  private static getPrimaryMenuConfig(
    state: SplitTabState,
    side: "left" | "right" | null,
  ): {
    menuState: "current" | "other" | "none";
    disabled: boolean;
    isCurrentPrimary: boolean;
    targetPrimarySide: "left" | "right" | null;
  } {
    const primarySide = this.getEffectivePrimarySide(state);
    const isCurrentPrimary = !!side && primarySide === side;
    const hasPrimary = !!primarySide;
    const menuState = !hasPrimary
      ? "none"
      : isCurrentPrimary
        ? "current"
        : "other";

    return {
      menuState,
      disabled: false,
      isCurrentPrimary,
      targetPrimarySide: menuState === "current" ? null : side,
    };
  }

  private static refreshPrimaryMenuItemElement(
    menuitem: Element,
    tabID: string,
    side: "left" | "right" | null,
  ) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return null;

    const config = this.getPrimaryMenuConfig(state, side);
    menuitem.setAttribute(
      "label",
      this.getSetPrimaryMenuLabel(config.menuState),
    );
    if (config.disabled) {
      menuitem.setAttribute("disabled", "true");
    } else {
      menuitem.removeAttribute("disabled");
    }
    this.setMenuItemIcon(
      menuitem,
      this.getIconURI(
        config.isCurrentPrimary
          ? "primary_window_24dp.svg"
          : "standby_24dp.svg",
      ),
    );
    return config;
  }

  /**
   * Register an event listener and track it for cleanup
   */
  private static trackEventListener(
    state: SplitTabState,
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ) {
    target.addEventListener(type, listener, options);
    state.eventListeners.push({ target, type, listener, options });
  }

  /**
   * Register a timeout and track it for cleanup
   */
  private static trackTimeout(
    state: SplitTabState,
    callback: () => void,
    delay: number,
  ): number {
    const win = Zotero.getMainWindow();
    const id = win.setTimeout(callback, delay);
    state.timeoutIds.push(id);
    return id;
  }

  /**
   * Create a browser element for the reader
   * Uses CSS flex layout for automatic proportional resizing
   */
  private static createReaderBrowser(win: Window): XULBrowserElement {
    const browser = win.document.createXULElement("browser");
    // Don't set XUL flex attribute - use CSS flex instead
    browser.setAttribute("type", "content");
    browser.setAttribute("transparent", "true");
    browser.setAttribute("src", "resource://zotero/reader/reader.html");
    // Initial flex: equal distribution, will be updated by updateBrowserFlex
    // Use flex-basis: 0 (not 0%) to ensure proportional sizing regardless of content
    (browser as any).style.flex = "1 1 0";
    (browser as any).style.minWidth = "200px";
    (browser as any).style.maxWidth = "none";
    (browser as any).style.overflow = "hidden";
    (browser as any).style.boxSizing = "border-box";
    return browser;
  }

  /**
   * Update browser flex values to achieve the desired split ratio
   * Uses flex layout for automatic proportional resizing when window changes
   */
  private static updateBrowserFlex(
    leftBrowser: XULBrowserElement,
    rightBrowser: XULBrowserElement,
    splitRatio: number,
  ) {
    // Use flex-grow to control proportions (flex-shrink=1, flex-basis=0)
    // flex-basis: 0 (not 0%) ensures both browsers start at exactly 0 and grow proportionally
    // Using integer flex-grow values to avoid floating point issues
    const leftFlex = Math.round(splitRatio * 1000);
    const rightFlex = Math.round((1 - splitRatio) * 1000);
    (leftBrowser as any).style.flex = `${leftFlex} 1 0`;
    (rightBrowser as any).style.flex = `${rightFlex} 1 0`;
  }

  /**
   * Set up drag functionality for the resizer
   * - Uses requestAnimationFrame for smooth performance
   * - Uses flex layout for automatic proportional resizing
   * - PDF scale is preserved (PDF.js handles relative vs absolute scaling)
   */
  private static setupResizerDrag(
    tabID: string,
    resizer: XULElement | HTMLElement,
    leftBrowser: XULBrowserElement,
    rightBrowser: XULBrowserElement,
    mainHbox: XULElement,
    win: Window,
  ) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    let isDragging = false;
    let startX = 0;
    let startRatio = 0;
    let overlay: HTMLElement | null = null;
    let rafPending = false;
    let onKeyDown: ((e: KeyboardEvent) => void) | null = null;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const removeOverlay = () => {
      isDragging = false;
      if (overlay) {
        overlay.remove();
        overlay = null;
      }
      const s = self.stateMap.get(tabID);
      if (s) s.dragOverlay = null;
      win.removeEventListener("mouseup", onMouseUp);
      win.removeEventListener("blur", onMouseUp);
      win.document.removeEventListener("mouseleave", onMouseUp);
      if (onKeyDown) {
        win.removeEventListener("keydown", onKeyDown);
        onKeyDown = null;
      }
    };

    const createOverlay = () => {
      // Remove any existing overlay first (but don't reset isDragging)
      if (overlay) {
        overlay.remove();
        overlay = null;
      }
      state.dragOverlay = null;
      win.removeEventListener("mouseup", onMouseUp);
      win.removeEventListener("blur", onMouseUp);
      win.document.removeEventListener("mouseleave", onMouseUp);
      if (onKeyDown) {
        win.removeEventListener("keydown", onKeyDown);
      }

      overlay = win.document.createElement("div");
      overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 99999;
        cursor: ew-resize;
        background: transparent;
      `;
      const target = win.document.documentElement || win.document.body;
      if (target) target.appendChild(overlay);
      state.dragOverlay = overlay;
      overlay.addEventListener("mousemove", onMouseMove);
      overlay.addEventListener("mouseup", onMouseUp);
      state.eventListeners.push(
        {
          target: overlay,
          type: "mousemove",
          listener: onMouseMove as EventListener,
        },
        {
          target: overlay,
          type: "mouseup",
          listener: onMouseUp as EventListener,
        },
      );

      // Also listen on window in case mouseup happens outside overlay
      win.addEventListener("mouseup", onMouseUp);
      win.addEventListener("blur", onMouseUp);
      win.document.addEventListener("mouseleave", onMouseUp);
      state.eventListeners.push(
        { target: win, type: "mouseup", listener: onMouseUp as EventListener },
        { target: win, type: "blur", listener: onMouseUp as EventListener },
        {
          target: win.document,
          type: "mouseleave",
          listener: onMouseUp as EventListener,
        },
      );

      // Escape key to cancel drag and restore original ratio
      onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          // Restore original ratio
          const s = self.stateMap.get(tabID);
          if (s) {
            s.splitRatio = startRatio;
            self.updateBrowserFlex(leftBrowser, rightBrowser, startRatio);
          }
          removeOverlay();
        }
      };
      win.addEventListener("keydown", onKeyDown);
      state.eventListeners.push({
        target: win,
        type: "keydown",
        listener: onKeyDown as EventListener,
        options: true,
      });
    };

    const onMouseDown = (e: MouseEvent) => {
      isDragging = true;
      startX = e.clientX;
      // Store the starting ratio for Escape key restoration
      const s = self.stateMap.get(tabID);
      startRatio = s?.splitRatio ?? 0.5;

      createOverlay();
      e.preventDefault();
      e.stopPropagation();
    };

    const onWindowMouseDown = (e: MouseEvent) => {
      if (isDragging) return;
      const s = self.stateMap.get(tabID);
      if (!s) return;

      // Only handle when our tab is visible (resizer has non-zero dimensions)
      const resizerRect = resizer.getBoundingClientRect();
      if (resizerRect.width === 0 || resizerRect.height === 0) return;

      const leftBrowserRect = leftBrowser.getBoundingClientRect();

      const edgeX = leftBrowserRect.right;
      const isNearEdge =
        Math.abs(e.clientX - edgeX) <= 15 &&
        e.clientY >= resizerRect.top &&
        e.clientY <= resizerRect.bottom;

      if (isNearEdge) {
        onMouseDown(e);
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      const s = self.stateMap.get(tabID);
      if (!isDragging || !s) return;
      if (rafPending) return;

      rafPending = true;
      win.requestAnimationFrame(() => {
        rafPending = false;
        const s2 = self.stateMap.get(tabID);
        if (!isDragging || !s2) return;

        // Use real-time container width instead of cached start widths
        // This ensures correct ratio calculation even if window is resized during drag
        const containerWidth = mainHbox.getBoundingClientRect().width;
        const resizerWidth = 1;
        const availableWidth = containerWidth - resizerWidth;

        // Calculate new left width based on mouse position
        // Use Math.floor with integer percentage like Zotero's split-view-resizer.js:
        // let p = Math.floor((br.width - (x - br.left)) / br.width * 100);
        const containerRect = mainHbox.getBoundingClientRect();
        const relativeX = e.clientX - containerRect.left;

        // Calculate percentage and floor to integer (1% step, matching Zotero)
        let percent = Math.floor((relativeX / availableWidth) * 100);

        // Apply min/max constraints (20-80% like Zotero's VIEW_MIN_SIZE)
        const minPercent = Math.ceil((200 / availableWidth) * 100); // At least 200px
        const maxPercent = 100 - minPercent;
        percent = Math.max(minPercent, Math.min(maxPercent, percent));

        // Update split ratio and flex values
        s2.splitRatio = percent / 100;
        self.updateBrowserFlex(leftBrowser, rightBrowser, s2.splitRatio);
      });
    };

    const onMouseUp = () => {
      // Save the new split ratio to tab data for session restore
      const s = self.stateMap.get(tabID);
      if (s && !s.isCleaningUp) {
        self.updateTabDataForSession(tabID);
      }
      removeOverlay();
    };

    // Track resizer mousedown listener for proper cleanup
    resizer.addEventListener("mousedown", onMouseDown);
    state.eventListeners.push({
      target: resizer,
      type: "mousedown",
      listener: onMouseDown as EventListener,
      options: undefined,
    });

    this.trackEventListener(
      state,
      win,
      "mousedown",
      onWindowMouseDown as EventListener,
      true,
    );
  }

  /**
   * Cache viewer container references to avoid repeated DOM queries during scroll sync
   */
  private static cacheViewerContainers(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;
    try {
      state.leftViewerContainer = readerView.getViewerContainerFromBrowser(
        state.leftBrowser,
      );
      state.rightViewerContainer = readerView.getViewerContainerFromBrowser(
        state.rightBrowser,
      );
    } catch (e) {
      Zotero.debug(
        `Split view: cacheViewerContainers error (browsers may be dead): ${e}`,
      );
    }
  }

  static registerContextMenu() {
    Zotero.Reader.registerEventListener(
      "createViewContextMenu",
      (event) => {
        // Guard: skip if plugin has been unloaded
        if (!addon.data.alive) return;

        const { reader, append } = event;
        const mainWindow = Zotero.getMainWindow();
        const readerTabID = reader.tabID;

        // Check if THIS tab has an active split view (not cleaning up)
        const tabState = this.stateMap.get(readerTabID);
        const isInSplitView = !!tabState && !tabState.isCleaningUp;
        const getContextMenuSide = () => {
          const s = this.stateMap.get(readerTabID);
          if (!s || s.isCleaningUp) return null;
          const readerSide = this.getReaderSide(readerTabID, reader as any);
          return readerSide || s.activeSide || null;
        };
        const contextMenuSide = isInSplitView ? getContextMenuSide() : null;

        // Determine icon for the Split-View Reader toggle
        const splitViewIcon = isInSplitView
          ? this.getIconURI("do_not_splitscreen_vertical_24dp.svg")
          : this.getIconURI("splitscreen_vertical_add_24dp.svg");

        // Build a label-to-icon map for post-processing
        // Use the actual label that will be shown (close or open)
        const menuLabel = isInSplitView
          ? this.getCloseViewMenuLabel()
          : getString("splitview-menu-label");
        const iconMap: Record<string, string> = {
          [menuLabel]: splitViewIcon,
        };

        if (contextMenuSide && tabState) {
          const { menuState, isCurrentPrimary } = this.getPrimaryMenuConfig(
            tabState,
            contextMenuSide,
          );
          const primaryLabel = this.getSetPrimaryMenuLabel(menuState);
          iconMap[primaryLabel] = isCurrentPrimary
            ? this.getIconURI("primary_window_24dp.svg")
            : this.getIconURI("standby_24dp.svg");
        } else if (isInSplitView) {
          iconMap[this.getSetPrimaryMenuLabel("none")] =
            this.getIconURI("standby_24dp.svg");
        }

        const menuItems: any[] = [];

        // If we have an active split view, add additional options
        if (isInSplitView && tabState) {
          const getClickedSide = () => {
            const s = this.stateMap.get(readerTabID);
            if (!s || s.isCleaningUp) return null;
            return (
              this.getReaderSide(readerTabID, reader as any) || s.activeSide
            );
          };

          menuItems.push({
            label: getString("splitview-swap-pdf"),
            onCommand: async () => {
              await this.swapPDFs(readerTabID);
            },
          });
          iconMap[getString("splitview-swap-pdf")] = this.getIconURI(
            "swap_horiz_24dp.svg",
          );

          menuItems.push({
            label: getString("splitview-separate-views"),
            onCommand: () => {
              const clickedSide = getClickedSide();
              if (clickedSide) {
                this.separateViews(readerTabID, clickedSide);
              }
            },
          });
          iconMap[getString("splitview-separate-views")] =
            this.getIconURI("separate_24dp.svg");

          menuItems.push({
            label: menuLabel,
            onCommand: () => {
              // Re-check state at command time to avoid stale references
              const currentTabState = this.stateMap.get(readerTabID);
              const currentlyInSplitView =
                !!currentTabState && !currentTabState.isCleaningUp;

              if (currentlyInSplitView) {
                const clickedSide =
                  this.getReaderSide(readerTabID, reader as any) ||
                  currentTabState?.activeSide ||
                  "right";
                // Pass the side to close (the one we clicked on)
                this.revertToSingleReader(readerTabID, clickedSide);
              } else {
                this.handleSplitView(reader);
              }
            },
          });

          const primaryMenuConfig = this.getPrimaryMenuConfig(
            tabState,
            contextMenuSide,
          );
          menuItems.push({
            label: this.getSetPrimaryMenuLabel(primaryMenuConfig.menuState),
            disabled: primaryMenuConfig.disabled,
            onCommand: () => {
              const s = this.stateMap.get(readerTabID);
              const clickedSide = getClickedSide();
              if (s && !s.isCleaningUp && clickedSide) {
                const currentConfig = this.getPrimaryMenuConfig(s, clickedSide);
                this.setPrimarySide(
                  readerTabID,
                  currentConfig.targetPrimarySide,
                );
              }
            },
          });

          menuItems.push({
            label: getString("splitview-open-another"),
            onCommand: async () => {
              const clickedSide = getClickedSide();
              if (clickedSide) {
                await this.selectAndLoadPDF(readerTabID, clickedSide);
              }
            },
          });
          iconMap[getString("splitview-open-another")] =
            this.getIconURI("file_open_24dp.svg");

          menuItems.push({
            label: getString("splitview-sync-position"),
            onCommand: () => {
              const clickedSide = getClickedSide();
              if (clickedSide) {
                this.syncPositionAndScale(readerTabID, clickedSide);
              }
            },
          });
          iconMap[getString("splitview-sync-position")] =
            this.getIconURI("sync_24dp.svg");
        } else {
          // First item outside split view: "Split-View Reader" open action
          menuItems.push({
            label: menuLabel,
            onCommand: () => {
              this.handleSplitView(reader);
            },
          });
        }

        (append as any)(...menuItems);

        // Post-process: Zotero's _openContextMenu doesn't support custom icon
        // properties, so we add a one-time popupshowing listener to find the
        // menuitems by label and apply our icon attributes after they are
        // rendered into the DOM.
        if (mainWindow) {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          const self = this;
          const onPopupShowing = (e: Event) => {
            const popup = e.target as Element;
            if (!popup || popup.tagName?.toLowerCase() !== "menupopup") return;
            const items = popup.querySelectorAll("menuitem");
            let found = false;
            let primaryItem: Element | null = null;
            for (const item of items) {
              const label = item.getAttribute("label");
              if (label && iconMap[label]) {
                found = true;
                // Remove checkbox type if Zotero added one (from checked property)
                item.removeAttribute("type");
                item.removeAttribute("checked");
                self.setMenuItemIcon(item, iconMap[label]);
              }
              if (
                label &&
                [
                  self.getSetPrimaryMenuLabel("current"),
                  self.getSetPrimaryMenuLabel("none"),
                  self.getSetPrimaryMenuLabel("other"),
                ].includes(label)
              ) {
                primaryItem = item;
              }
            }
            if (primaryItem && contextMenuSide) {
              popup.addEventListener(
                "popupshown",
                () => {
                  mainWindow.setTimeout(() => {
                    const s = self.stateMap.get(readerTabID);
                    if (!s || s.isCleaningUp) return;
                    self.activateSide(readerTabID, contextMenuSide, mainWindow);
                    self.refreshPrimaryMenuItemElement(
                      primaryItem as Element,
                      readerTabID,
                      contextMenuSide,
                    );
                  }, 0);
                },
                { once: true },
              );
            }
            if (!found) {
              // Not our popup — re-listen for the next one
              mainWindow.document.addEventListener(
                "popupshowing",
                onPopupShowing,
                { once: true },
              );
            }
          };
          mainWindow.document.addEventListener("popupshowing", onPopupShowing, {
            once: true,
          });
        }
      },
      addon.data.config.addonID,
    );
  }

  /**
   * Hook into Zotero_Tabs.getTabIDByItemID to support finding tabs by right-side itemID
   */
  static registerTabLookup() {
    const win = Zotero.getMainWindow();
    const Zotero_Tabs = (win as any).Zotero_Tabs;

    if (!Zotero_Tabs) return;

    // Store original method if not already stored
    if (!(Zotero_Tabs as any)._originalGetTabIDByItemID) {
      (Zotero_Tabs as any)._originalGetTabIDByItemID =
        Zotero_Tabs.getTabIDByItemID;
    }
    if (!(Zotero_Tabs as any)._originalReaderGetTitleHook) {
      (Zotero_Tabs as any)._originalReaderGetTitleHook =
        Zotero_Tabs.tabHooks?.getTitle?.reader;
    }
    if (!(Zotero_Tabs as any)._originalReaderToggleAudioHook) {
      (Zotero_Tabs as any)._originalReaderToggleAudioHook =
        Zotero_Tabs.tabHooks?.toggleAudio?.reader;
    }
    if (
      !(Zotero_Tabs as any)._originalSetAudioStatusForSplitView &&
      typeof Zotero_Tabs.setAudioStatus === "function"
    ) {
      (Zotero_Tabs as any)._originalSetAudioStatusForSplitView =
        Zotero_Tabs.setAudioStatus;
    }
    this.installTabShowInLibraryHandler(win);

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const originalSetAudioStatus = (Zotero_Tabs as any)
      ._originalSetAudioStatusForSplitView;
    if (typeof originalSetAudioStatus === "function") {
      Zotero_Tabs.setAudioStatus = function (id: string, status: any) {
        if (status?.active && !status.paused) {
          try {
            const { tab } = this._getTab(id);
            if (!tab?.data?.isSplitView || !self.hasActiveSplitState(tab.id)) {
              self.pauseAllSplitReadAloud();
            }
          } catch (e) {
            Zotero.debug(
              `Split view: pausing split Read Aloud from normal reader failed: ${e}`,
            );
          }
        }
        return originalSetAudioStatus.call(this, id, status);
      };
    }

    // Override method
    Zotero_Tabs.getTabIDByItemID = function (itemID: number) {
      // 1. Try original method first
      const tabID = this._originalGetTabIDByItemID.call(this, itemID);
      if (tabID) return tabID;

      // 2. If not found, check our split view states for right-side items
      for (const state of self.stateMap.values()) {
        if (state.rightItemID === itemID && !state.isCleaningUp) {
          // Verify the tab still exists in Zotero's _tabs array before returning.
          // The tab may have been closed (removed from _tabs) but our cleanup
          // notifier hasn't fired yet, leaving stale state in stateMap.
          const { tab } = this._getTab(state.tabID);
          if (tab) {
            return state.tabID;
          }
        }
      }

      return null;
    };

    if (Zotero_Tabs.tabHooks?.getTitle?.reader) {
      Zotero_Tabs.tabHooks.getTitle.reader = async function (tab: any) {
        if (tab?.data?.isSplitView && self.hasActiveSplitState(tab.id)) {
          return self.getSplitViewTitleForTab(tab);
        }

        const original = (Zotero_Tabs as any)._originalReaderGetTitleHook;
        return typeof original === "function" ? original.call(this, tab) : "";
      };
    }

    if (Zotero_Tabs.tabHooks?.toggleAudio?.reader) {
      Zotero_Tabs.tabHooks.toggleAudio.reader = function (tab: any) {
        if (tab?.data?.isSplitView && self.hasActiveSplitState(tab.id)) {
          self.toggleActiveReadAloud(tab.id);
          return;
        }

        const original = (Zotero_Tabs as any)._originalReaderToggleAudioHook;
        if (typeof original === "function") {
          return original.call(this, tab);
        }
      };
    }
  }

  /**
   * Register session restore handler to restore split view tabs after Zotero restart.
   * This should be called once during plugin initialization.
   */
  static registerSessionRestore() {
    // Already registered
    if (this.sessionRestoreNotifierID) return;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const notifierCallback = {
      notify: async (
        action: string,
        type: string,
        ids: (string | number)[],
        extraData: any,
      ) => {
        if (type !== "tab") return;

        // When a reader tab finishes loading, check if it should be a split view
        if (action === "load") {
          const tabID = String(ids[0]);
          const tabData = extraData?.[tabID];

          // Check if this tab has split view data saved
          if (tabData?.data?.isSplitView) {
            // Small delay to ensure the reader is fully initialized
            setTimeout(async () => {
              try {
                await self.restoreSplitViewFromSession(tabID, tabData.data);
              } catch (e) {
                Zotero.debug(
                  `Split view: Failed to restore split view for tab ${tabID}: ${e}`,
                );
              }
            }, 500);
          }
        }
      },
    };

    this.sessionRestoreNotifierID = Zotero.Notifier.registerObserver(
      notifierCallback,
      ["tab"],
      "splitViewSessionRestore",
      25,
    );

    // Check for already-loaded split view tabs that may have been missed
    // because they loaded before this listener was registered.
    // This handles the case where a split view tab was selected when Zotero closed,
    // causing it to load before the plugin's uiReadyPromise completed.
    setTimeout(() => {
      self.checkAlreadyLoadedSplitViewTabs();
    }, 100);
  }

  /**
   * Check for already-loaded split view tabs that may have been missed
   * because they loaded before the session restore listener was registered.
   */
  private static async checkAlreadyLoadedSplitViewTabs() {
    try {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = (win as any).Zotero_Tabs;

      for (const tab of Zotero_Tabs._tabs) {
        // Check loaded reader tabs (not unloaded) that have split view data
        if (tab.type === "reader" && tab.data?.isSplitView) {
          // Skip if already converted to split view
          if (this.stateMap.has(tab.id)) continue;

          Zotero.debug(
            `Split view: Found already-loaded split view tab ${tab.id}, restoring...`,
          );

          try {
            await this.restoreSplitViewFromSession(tab.id, tab.data);
          } catch (e) {
            Zotero.debug(
              `Split view: Failed to restore split view for tab ${tab.id}: ${e}`,
            );
          }
        }
      }
    } catch (e) {
      Zotero.debug(`Split view: checkAlreadyLoadedSplitViewTabs failed: ${e}`);
    }
  }

  /**
   * Register preference observers so that changes in the preference panel
   * take effect immediately on all existing split view tabs.
   */
  static registerPrefObservers() {
    const prefix = config.prefsPrefix;
    this.clearLegacySyncEnabledPref();

    // primaryScrollbarR/G/B: re-apply scrollbar color to all split view tabs
    const scrollbarPrefKeys: (keyof _ZoteroTypes.Prefs["PluginPrefsMap"])[] = [
      "primaryScrollbarR",
      "primaryScrollbarG",
      "primaryScrollbarB",
    ];
    const onScrollbarPrefChange = () => {
      for (const tabID of this.stateMap.keys()) {
        this.updateScrollbarColors(tabID);
      }
    };
    scrollbarPrefKeys.forEach((key, i) => {
      const id = Zotero.Prefs.registerObserver(
        `${prefix}.${key}`,
        onScrollbarPrefChange,
        true,
      );
      this.scrollbarPrefObserverIDs[i] = id;
    });

    this.splitTabsTitlePrefObserverID = Zotero.Prefs.registerObserver(
      `${prefix}.splitTabsTitle`,
      () => {
        this.refreshOpenSplitViewTabTitles();
      },
      true,
    );

    this.readAloud.register();
  }

  /**
   * Register a named command in the Shift+P command palette.
   * Context-aware: in a reader tab it starts the split view flow immediately;
   * in the library or any other tab it enters the two-step PDF selection flow.
   */
  static registerPromptCommands(win: Window) {
    commandPalette.register(win, async () => {
      const tabs = (win as any).Zotero_Tabs;
      const reader = tabs?.selectedID
        ? Zotero.Reader.getByTabID(tabs.selectedID)
        : null;
      if (reader) await this.handleSplitView(reader);
      else await this.openSplitViewFromLibrary();
    });
  }

  /**
   * Unregister all split view notifiers and cleanup.
   * This should be called during plugin shutdown.
   */
  static unregisterAll() {
    this.pdfSelector.dispose();
    // Save view states for all active split views before cleanup.
    // This ensures PDF page/zoom positions are preserved when Zotero closes.
    for (const [_tabID, state] of this.stateMap.entries()) {
      if (state.isCleaningUp) continue;
      try {
        let leftCurrentState: any = null;
        let rightCurrentState: any = null;
        try {
          leftCurrentState = readerView.getCurrentViewStateFromBrowser(
            state.leftBrowser,
          );
        } catch {
          // Browser may be dead
        }
        try {
          rightCurrentState = readerView.getCurrentViewStateFromBrowser(
            state.rightBrowser,
          );
        } catch {
          // Browser may be dead
        }
        // Fire and forget - async save
        Promise.all([
          attachmentState.saveViewStateToDisk(
            state.leftItemID,
            leftCurrentState || state.leftViewState,
          ),
          attachmentState.saveViewStateToDisk(
            state.rightItemID,
            rightCurrentState || state.rightViewState,
          ),
        ]).catch(() => {
          /* Ignore save errors during shutdown */
        });
      } catch {
        // Ignore errors during shutdown
      }
    }

    // Clean up all active split views
    for (const tabID of this.stateMap.keys()) {
      try {
        this.cleanupTabResources(tabID);
      } catch (e) {
        Zotero.debug(
          `Split view: unregisterAll - cleanupTabResources(${tabID}) failed: ${e}`,
        );
      }
    }
    this.stateMap.clear();

    // Unregister session restore notifier
    if (this.sessionRestoreNotifierID) {
      try {
        Zotero.Notifier.unregisterObserver(this.sessionRestoreNotifierID);
      } catch (e) {
        Zotero.debug(
          `Split view: unregisterAll - unregisterObserver(session) failed: ${e}`,
        );
      }
      this.sessionRestoreNotifierID = null;
    }

    // Unregister global tab notifier
    if (this.globalTabNotifierID) {
      try {
        Zotero.Notifier.unregisterObserver(this.globalTabNotifierID);
      } catch (e) {
        Zotero.debug(
          `Split view: unregisterAll - unregisterObserver(globalTab) failed: ${e}`,
        );
      }
      this.globalTabNotifierID = null;
    }

    // Unregister preference observers
    this.scrollbarPrefObserverIDs.forEach((id, i) => {
      if (id) {
        try {
          Zotero.Prefs.unregisterObserver(id);
        } catch (e) {
          Zotero.debug(
            `Split view: unregisterAll - unregisterObserver(scrollbarPref[${i}]) failed: ${e}`,
          );
        }
        this.scrollbarPrefObserverIDs[i] = null;
      }
    });
    if (this.splitTabsTitlePrefObserverID) {
      try {
        Zotero.Prefs.unregisterObserver(this.splitTabsTitlePrefObserverID);
      } catch (e) {
        Zotero.debug(
          `Split view: unregisterAll - unregisterObserver(splitTabsTitle) failed: ${e}`,
        );
      }
      this.splitTabsTitlePrefObserverID = null;
    }
    if (this.splitTabTitleItemNotifierID) {
      try {
        Zotero.Notifier.unregisterObserver(this.splitTabTitleItemNotifierID);
      } catch (e) {
        Zotero.debug(
          `Split view: unregisterAll - unregisterObserver(splitTabTitleItem) failed: ${e}`,
        );
      }
      this.splitTabTitleItemNotifierID = null;
    }
    this.readAloud.unregister();

    // Restore Zotero_Tabs.getTabIDByItemID to avoid holding references and stale tab IDs
    this.unregisterTabLookup();

    commandPalette.unregister();
  }

  /**
   * Restore original Zotero_Tabs.getTabIDByItemID. Call on plugin unload to avoid
   * holding references to stateMap and to prevent returning stale tab IDs.
   */
  private static unregisterTabLookup() {
    try {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = (win as any).Zotero_Tabs;
      if (!Zotero_Tabs) return;
      const original = (Zotero_Tabs as any)._originalGetTabIDByItemID;
      if (typeof original === "function") {
        Zotero_Tabs.getTabIDByItemID = original;
        (Zotero_Tabs as any)._originalGetTabIDByItemID = undefined;
      }
      const originalGetTitle = (Zotero_Tabs as any)._originalReaderGetTitleHook;
      if (
        typeof originalGetTitle === "function" &&
        Zotero_Tabs.tabHooks?.getTitle
      ) {
        Zotero_Tabs.tabHooks.getTitle.reader = originalGetTitle;
        (Zotero_Tabs as any)._originalReaderGetTitleHook = undefined;
      }
      const originalToggleAudio = (Zotero_Tabs as any)
        ._originalReaderToggleAudioHook;
      if (
        typeof originalToggleAudio === "function" &&
        Zotero_Tabs.tabHooks?.toggleAudio
      ) {
        Zotero_Tabs.tabHooks.toggleAudio.reader = originalToggleAudio;
        (Zotero_Tabs as any)._originalReaderToggleAudioHook = undefined;
      }
      const originalSetAudioStatus = (Zotero_Tabs as any)
        ._originalSetAudioStatusForSplitView;
      if (typeof originalSetAudioStatus === "function") {
        Zotero_Tabs.setAudioStatus = originalSetAudioStatus;
        (Zotero_Tabs as any)._originalSetAudioStatusForSplitView = undefined;
      }
    } catch (e) {
      Zotero.debug(`Split view: unregisterTabLookup failed: ${e}`);
    } finally {
      this.uninstallTabShowInLibraryHandler();
    }
  }

  /**
   * Restore split view from saved session data
   */
  private static async restoreSplitViewFromSession(
    tabID: string,
    savedData: any,
  ) {
    const win = Zotero.getMainWindow();
    const Zotero_Tabs = (win as any).Zotero_Tabs;

    // Get the reader that was just loaded
    const reader = Zotero.Reader.getByTabID(tabID);
    if (!reader) {
      Zotero.debug(
        `Split view: Cannot restore - reader not found for tab ${tabID}`,
      );
      return;
    }

    // Wait for reader to be fully initialized
    if (reader._initPromise) {
      await reader._initPromise;
    }

    // Check if already converted (e.g., user manually enabled split view)
    if (this.stateMap.has(tabID)) {
      Zotero.debug(
        `Split view: Tab ${tabID} already has split view, skipping restore`,
      );
      return;
    }

    const {
      leftItemID,
      rightItemID,
      isSamePDF,
      splitRatio,
      syncEnabled: legacySyncEnabled,
      primarySide,
      activeSide,
    } = savedData;

    // Validate items still exist
    if (!Zotero.Items.exists(leftItemID) || !Zotero.Items.exists(rightItemID)) {
      Zotero.debug(
        `Split view: Cannot restore - one or both items no longer exist`,
      );
      return;
    }

    const leftItem = Zotero.Items.get(leftItemID);
    const rightItem = Zotero.Items.get(rightItemID);

    if (!leftItem || !rightItem) {
      Zotero.debug(`Split view: Cannot restore - failed to get items`);
      return;
    }

    Zotero.debug(
      `Split view: Restoring split view for tab ${tabID} (isSamePDF: ${isSamePDF})`,
    );

    if (isSamePDF) {
      // Restore same-PDF split view
      await this.convertToSamePDFSplitView(reader);
    } else {
      // Restore different-PDF split view
      await this.convertToSplitView(reader, rightItem);
    }

    // Restore saved settings
    const state = this.stateMap.get(tabID);
    if (state) {
      // Restore split ratio
      if (typeof splitRatio === "number" && splitRatio > 0 && splitRatio < 1) {
        state.splitRatio = splitRatio;
        this.updateBrowserFlex(
          state.leftBrowser,
          state.rightBrowser,
          splitRatio,
        );
      }

      // Restore primary side setting (directly set state to avoid
      // notification popup that setPrimarySide shows)
      let restoredPrimarySide: "left" | "right" | null | undefined;
      if (primarySide === "left" || primarySide === "right") {
        restoredPrimarySide = primarySide;
      } else if (
        Object.prototype.hasOwnProperty.call(savedData, "primarySide") &&
        primarySide === null
      ) {
        restoredPrimarySide = null;
      }

      // Legacy migration: old versions persisted a standalone syncEnabled flag.
      // In the new model, sync is off when no primary view exists.
      if (legacySyncEnabled === false) {
        restoredPrimarySide = null;
      }
      if (restoredPrimarySide !== undefined) {
        state.primarySide = restoredPrimarySide;
      }
      this.updateScrollbarColors(tabID);
      // Sync polling will be started by convertToSplitView's delay timer if a
      // primary side is available.

      // Restore active side
      if (activeSide === "left" || activeSide === "right") {
        state.activeSide = activeSide;
      }

      // Persist the restored state back into the tab session data so an
      // explicit `primarySide: null` survives the next Zotero restart.
      this.updateTabDataForSession(tabID);
    }

    Zotero.debug(
      `Split view: Successfully restored split view for tab ${tabID}`,
    );
  }

  /**
   * Update tab data with current split view state for session persistence.
   * Called when split ratio or primary state changes.
   */
  private static updateTabDataForSession(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    try {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = (win as any).Zotero_Tabs;
      const currentTab = Zotero_Tabs._getTab(tabID)?.tab;

      // Legacy cleanup: old versions persisted a standalone syncEnabled flag.
      // Remove it explicitly because setTabData() merges into existing tab.data.
      if (currentTab?.data && "syncEnabled" in currentTab.data) {
        delete currentTab.data.syncEnabled;
      }

      Zotero_Tabs.setTabData(tabID, {
        itemID: state.leftItemID,
        leftItemID: state.leftItemID,
        rightItemID: state.rightItemID,
        isSplitView: true,
        isSamePDF: state.isSamePDF,
        splitRatio: state.splitRatio,
        primarySide: state.primarySide,
        activeSide: state.activeSide,
      });
    } catch (e) {
      Zotero.debug(`Split view: Failed to update tab data: ${e}`);
    }
  }

  /**
   * Rewrite a split tab's transient tab data so closing it records a normal
   * reader tab for the side that is actually being closed. This keeps
   * Ctrl+Shift+T aligned with the user's intent.
   */
  private static prepareTabDataForSingleReaderClose(
    tabID: string,
    itemID: number,
  ) {
    try {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = (win as any).Zotero_Tabs;
      const currentTab = Zotero_Tabs._getTab(tabID)?.tab;

      // setTabData() merges, so remove split-view-only fields first.
      if (currentTab?.data) {
        delete currentTab.data.leftItemID;
        delete currentTab.data.rightItemID;
        delete currentTab.data.isSplitView;
        delete currentTab.data.isSamePDF;
        delete currentTab.data.splitRatio;
        delete currentTab.data.primarySide;
        delete currentTab.data.activeSide;
        delete currentTab.data.syncEnabled;
      }

      Zotero_Tabs.setTabData(tabID, {
        itemID,
      });
    } catch (e) {
      Zotero.debug(
        `Split view: Failed to prepare normal reader tab data for close: ${e}`,
      );
    }
  }

  /**
   * Determine which side (left/right) a reader belongs to based on itemID
   */
  private static getReaderSide(
    tabID: string,
    reader: any,
  ): "left" | "right" | null {
    const state = this.stateMap.get(tabID);
    if (!state) return null;

    try {
      // Same-PDF split views expose the same itemID on both embedded readers,
      // so itemID-based side detection is ambiguous there.
      if (state.leftItemID === state.rightItemID) {
        return null;
      }
      if (reader.itemID === state.leftItemID) {
        return "left";
      }
      if (reader.itemID === state.rightItemID) {
        return "right";
      }
    } catch (e) {
      Zotero.debug(`Split view: getReaderSide error: ${e}`);
      return null;
    }

    return null;
  }

  private static getReaderSideByBrowser(
    tabID: string,
    browser: XULBrowserElement,
  ): "left" | "right" | null {
    const state = this.stateMap.get(tabID);
    if (!state) return null;
    if (browser === state.leftBrowser) return "left";
    if (browser === state.rightBrowser) return "right";
    return null;
  }

  private static getActiveSplitReaderInfoByBrowser(
    browser: XULBrowserElement,
  ): { state: SplitTabState; side: "left" | "right" } | null {
    for (const state of this.stateMap.values()) {
      if (state.isCleaningUp) continue;
      if (browser === state.leftBrowser) {
        return { state, side: "left" };
      }
      if (browser === state.rightBrowser) {
        return { state, side: "right" };
      }
    }
    return null;
  }

  private static getBrowserBySide(
    state: SplitTabState,
    side: "left" | "right",
  ): XULBrowserElement {
    return side === "left" ? state.leftBrowser : state.rightBrowser;
  }

  private static setSplitTabAudioStatus(tabID: string, status: any): void {
    try {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = (win as any).Zotero_Tabs;
      if (typeof Zotero_Tabs?.setAudioStatus === "function") {
        Zotero_Tabs.setAudioStatus(tabID, status);
      }
    } catch (e) {
      Zotero.debug(`Split view: setSplitTabAudioStatus failed: ${e}`);
    }
  }

  private static pauseReadAloudInBrowser(
    browser: XULBrowserElement,
    paused = true,
  ): void {
    try {
      const reader = readerRuntime.getInternalReaderFromBrowser(browser);
      reader?.toggleReadAloudPaused?.(paused);
    } catch (e) {
      Zotero.debug(`Split view: pauseReadAloudInBrowser failed: ${e}`);
    }
  }

  private static pauseAllSplitReadAloud(): void {
    for (const state of this.stateMap.values()) {
      if (state.isCleaningUp) continue;
      for (const browser of [state.leftBrowser, state.rightBrowser]) {
        this.pauseReadAloudInBrowser(browser, true);
      }
    }
  }

  private static pauseReadAloudExcept(
    tabID: string,
    activeBrowser: XULBrowserElement,
  ): void {
    const activeState = this.stateMap.get(tabID);
    if (!activeState || activeState.isCleaningUp) return;

    for (const state of this.stateMap.values()) {
      if (state.isCleaningUp) continue;
      for (const browser of [state.leftBrowser, state.rightBrowser]) {
        if (browser !== activeBrowser) {
          this.pauseReadAloudInBrowser(browser, true);
        }
      }
    }

    try {
      const readers = (Zotero.Reader as any)._readers || [];
      for (const reader of readers) {
        try {
          reader?.toggleReadAloudPaused?.(true);
        } catch (e) {
          Zotero.logError(e as Error);
        }
      }
    } catch {
      // Ignore if Zotero.Reader internals are unavailable
    }
  }

  private static handleReadAloudStatus(
    tabID: string,
    browser: XULBrowserElement,
    status: any,
  ): void {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    const side = this.getReaderSideByBrowser(tabID, browser);
    if (side) {
      state.readAloudStatuses[side] = status || null;

      const otherSide = side === "left" ? "right" : "left";
      const otherStatus = state.readAloudStatuses[otherSide];
      const sidePlaying = !!status?.active && !status.paused;
      const otherPlaying = !!otherStatus?.active && !otherStatus.paused;

      if (sidePlaying) {
        state.readAloudSide = side;
      } else if (!status?.active) {
        if (state.readAloudSide === side) {
          state.readAloudSide = otherStatus?.active ? otherSide : null;
        }
      } else if (!otherPlaying && !state.readAloudSide) {
        state.readAloudSide = side;
      } else if (otherPlaying && state.readAloudSide === side) {
        state.readAloudSide = otherSide;
      }
    }

    if (status?.active && !status.paused) {
      try {
        browser.docShellIsActive = true;
      } catch {
        // Ignore browser activation errors
      }
      this.pauseReadAloudExcept(tabID, browser);
    }

    this.setSplitTabAudioStatus(
      tabID,
      this.getSplitTabReadAloudStatus(state, status),
    );
  }

  private static clearReadAloudStateForSide(
    state: SplitTabState,
    side: "left" | "right",
  ): void {
    state.readAloudStatuses[side] = null;

    if (state.readAloudSide === side) {
      const otherSide = side === "left" ? "right" : "left";
      state.readAloudSide = state.readAloudStatuses[otherSide]?.active
        ? otherSide
        : null;
    }

    this.setSplitTabAudioStatus(
      state.tabID,
      this.getSplitTabReadAloudStatus(state, {
        active: false,
        paused: false,
      }),
    );
  }

  private static getSplitTabReadAloudStatus(
    state: SplitTabState,
    fallbackStatus: any,
  ): any {
    const sides: ("left" | "right")[] = ["left", "right"];
    const playingSide = sides.find((side) => {
      const status = state.readAloudStatuses[side];
      return !!status?.active && !status.paused;
    });
    if (playingSide) return state.readAloudStatuses[playingSide];

    if (state.readAloudSide) {
      const status = state.readAloudStatuses[state.readAloudSide];
      if (status?.active) return status;
    }

    const activeReadAloudSide = sides.find((side) => {
      const status = state.readAloudStatuses[side];
      return !!status?.active;
    });
    if (activeReadAloudSide) {
      return state.readAloudStatuses[activeReadAloudSide];
    }

    return fallbackStatus ?? { active: false, paused: false };
  }

  private static getReadAloudTargetSide(
    state: SplitTabState,
  ): "left" | "right" {
    const sides: ("left" | "right")[] = ["left", "right"];
    const playingSide = sides.find((side) => {
      const status = state.readAloudStatuses[side];
      return !!status?.active && !status.paused;
    });
    if (playingSide) return playingSide;
    if (state.readAloudSide) return state.readAloudSide;

    const activeReadAloudSide = sides.find((side) => {
      const status = state.readAloudStatuses[side];
      return !!status?.active;
    });
    return activeReadAloudSide ?? state.activeSide;
  }

  private static toggleActiveReadAloud(tabID: string): void {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    const browser = this.getBrowserBySide(
      state,
      this.getReadAloudTargetSide(state),
    );
    try {
      readerRuntime
        .getInternalReaderFromBrowser(browser)
        ?.toggleReadAloudPaused?.();
    } catch (e) {
      Zotero.debug(`Split view: toggleActiveReadAloud failed: ${e}`);
    }
  }

  /**
   * Set which side is the primary (controller)
   */
  private static setPrimarySide(tabID: string, side: "left" | "right" | null) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    // Stop current sync before changing
    this.stopSyncPolling(tabID);

    state.primarySide = side;
    state.lastPrimaryScroll = null;

    // Update scrollbar colors to reflect new primary side
    this.updateScrollbarColors(tabID);

    // Restart sync with new primary
    if (side) {
      this.initSyncState(tabID);
      this.startSyncPolling(tabID);
    }

    this.updateTabDataForSession(tabID);
  }

  /**
   * Replace the browser element for a side to ensure fresh state
   * @param tabID Tab ID
   * @param side 'left' or 'right'
   * @returns The new browser element
   */
  private static async replaceBrowser(
    tabID: string,
    side: "left" | "right",
  ): Promise<XULBrowserElement | null> {
    const state = this.stateMap.get(tabID);
    if (!state) return null;

    const oldBrowser = side === "left" ? state.leftBrowser : state.rightBrowser;
    const container = oldBrowser.parentNode;

    if (!container) return null;

    // Close the old reader instance associated with this browser.
    // This removes it from Zotero.Reader._readers and prevents orphaned readers.
    const oldReader = readerRuntime.getReaderForBrowser(oldBrowser);
    if (oldReader) {
      await readerRuntime.closeReaderWithoutClosingTab(oldReader);
    }
    this.clearReadAloudStateForSide(state, side);

    // Create new browser element
    const doc = oldBrowser.ownerDocument;
    if (!doc) return null;
    const newBrowser = doc.createXULElement("browser") as XULBrowserElement;

    // Copy attributes from createReaderBrowser
    newBrowser.setAttribute("type", "content");
    newBrowser.setAttribute("transparent", "true");
    newBrowser.setAttribute("src", "resource://zotero/reader/reader.html");

    // Copy styles from old browser to maintain layout
    newBrowser.className = oldBrowser.className;

    // Manually copy style properties to preserve layout
    const oldStyle = (oldBrowser as any).style;
    (newBrowser as any).style.flex = oldStyle.flex;
    (newBrowser as any).style.minWidth = oldStyle.minWidth;
    (newBrowser as any).style.maxWidth = oldStyle.maxWidth;
    (newBrowser as any).style.overflow = oldStyle.overflow;
    (newBrowser as any).style.boxSizing = oldStyle.boxSizing;

    // Remove tracked event listeners bound to the old browser before replacing it.
    // This avoids stale references and cleanup errors when the old browser is dead.
    state.eventListeners = state.eventListeners.filter((entry) => {
      if (entry.target === oldBrowser) {
        try {
          entry.target.removeEventListener(
            entry.type,
            entry.listener,
            entry.options,
          );
        } catch {
          // Old browser may already be dead
        }
        return false;
      }
      return true;
    });

    // Replace in DOM
    container.replaceChild(newBrowser, oldBrowser);

    // Update state
    if (side === "left") {
      state.leftBrowser = newBrowser;
    } else {
      state.rightBrowser = newBrowser;
    }

    return newBrowser;
  }

  /**
   * Select and load a new PDF in the secondary (non-primary) window
   */
  /**
   * Select and load a new PDF in the specified side panel.
   * @param tabID Tab ID
   * @param targetSide The side where the new PDF will be loaded (based on where the user right-clicked)
   */
  private static async selectAndLoadPDF(
    tabID: string,
    targetSide: "left" | "right",
  ) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    // Get the current item ID for the target side
    const currentItemID =
      targetSide === "left" ? state.leftItemID : state.rightItemID;
    const currentItem = Zotero.Items.get(currentItemID);
    if (!currentItem) return;

    // Show PDF selection dialog
    const selectedPDF = await this.pdfSelector.select(currentItem.libraryID);
    if (!selectedPDF) return;

    // Check if the selected PDF is the same as the currently loaded one
    if (selectedPDF.id === currentItemID) {
      // Same PDF - no need to reload
      const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
      })
        .createLine({
          text: getString("splitview-loaded"),
          type: "default",
          icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
        })
        .show();
      popup.startCloseTimer(2000);
      return;
    }

    // Load the new PDF in the target side
    try {
      // Stop sync polling during reload
      const hadPrimary = !!state.primarySide;
      if (hadPrimary) {
        this.stopSyncPolling(tabID);
      }

      // Get the view state for the new PDF
      const newViewState =
        await attachmentState.getStoredViewState(selectedPDF);

      // Get the appropriate popupset
      const popupset =
        targetSide === "left" ? state.leftPopupset : state.rightPopupset;

      // Replace the browser element to ensure a fresh state
      // This avoids race conditions with waitForBrowserLoad on reused browsers
      const newBrowser = await this.replaceBrowser(tabID, targetSide);
      if (!newBrowser) {
        throw new Error("Failed to replace browser element");
      }

      // Reload the browser with the new PDF
      const win = Zotero.getMainWindow();
      await this.initializeReader(
        tabID,
        newBrowser,
        selectedPDF,
        popupset,
        newViewState,
        targetSide === "right", // isRight parameter
      );

      // Setup listeners for the new browser
      // Use the shared focus listener method with all proper guards
      // to prevent redundant "Section item data changed" events
      this.setupBrowserFocusListeners(tabID, newBrowser, targetSide, win);
      this.setupCtrlKeyListener(tabID, newBrowser);
      this.setupZoomButtonListeners(tabID, newBrowser);

      // Update state with new item ID
      if (targetSide === "left") {
        state.leftItemID = selectedPDF.id;
        state.leftParentItemID = selectedPDF.parentItemID || selectedPDF.id;
      } else {
        state.rightItemID = selectedPDF.id;
        state.rightParentItemID = selectedPDF.parentItemID || selectedPDF.id;
      }

      // Update isSamePDF flag
      state.isSamePDF = state.leftItemID === state.rightItemID;

      // Setup annotation sync if we are now viewing the same PDF
      if (state.isSamePDF) {
        this.setupAnnotationManagerSync(tabID);
      }

      // Preserve the existing primary side when replacing a PDF in one view.
      // "Change PDF in This View" should not implicitly transfer primary control.
      this.updateScrollbarColors(tabID);

      // Update tab data
      this.updateTabDataForSession(tabID);

      await this.renameSplitViewTab(tabID);

      // Restart sync if a primary view is active
      if (hadPrimary) {
        this.trackTimeout(
          state,
          () => {
            const s = this.stateMap.get(tabID);
            if (s && s.primarySide) {
              this.cacheViewerContainers(tabID);
              this.initSyncState(tabID);
              this.startSyncPolling(tabID);
            }
          },
          500,
        );
      }

      // Show success notification
      const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
      })
        .createLine({
          text: getString("splitview-loaded"),
          type: "default",
          icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
        })
        .show();
      popup.startCloseTimer(2000);
    } catch (e) {
      Zotero.debug(`Split view: Error loading PDF on ${targetSide} side: ${e}`);

      // Show error notification
      const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
      })
        .createLine({
          text: getString("splitview-not-found"),
          type: "error",
          icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
        })
        .show();
      popup.startCloseTimer(2000);
    }
  }

  /**
   * Swap the PDFs between left and right panels.
   * Recreates both browser instances with swapped items and view states.
   * Primary and active side states follow the swap.
   */
  private static async swapPDFs(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    try {
      // 1. Save current view states from browsers
      let leftCurrentState: any = null;
      let rightCurrentState: any = null;
      try {
        leftCurrentState = readerView.getCurrentViewStateFromBrowser(
          state.leftBrowser,
        );
      } catch {
        // Browser may be dead
      }
      try {
        rightCurrentState = readerView.getCurrentViewStateFromBrowser(
          state.rightBrowser,
        );
      } catch {
        // Browser may be dead
      }
      const leftViewState = leftCurrentState || state.leftViewState;
      const rightViewState = rightCurrentState || state.rightViewState;

      // 2. Record current item IDs and parent IDs
      const oldLeftItemID = state.leftItemID;
      const oldRightItemID = state.rightItemID;
      const oldLeftParentItemID = state.leftParentItemID;
      const oldRightParentItemID = state.rightParentItemID;

      // 3. Stop sync polling during swap
      const hadPrimary = !!state.primarySide;
      if (hadPrimary) {
        this.stopSyncPolling(tabID);
      }

      // 4. Replace both browsers to get fresh instances (closes old readers)
      const newLeftBrowser = await this.replaceBrowser(tabID, "left");
      const newRightBrowser = await this.replaceBrowser(tabID, "right");
      if (!newLeftBrowser || !newRightBrowser) {
        throw new Error("Failed to replace browser elements for swap");
      }

      // 5. Swap state: left gets old right, right gets old left
      state.leftItemID = oldRightItemID;
      state.rightItemID = oldLeftItemID;
      state.leftParentItemID = oldRightParentItemID;
      state.rightParentItemID = oldLeftParentItemID;
      state.leftViewState = rightViewState;
      state.rightViewState = leftViewState;

      // 6. Primary and active sides remain unchanged (do not follow the swap)

      // 7. Get items for initialization
      const newLeftItem = Zotero.Items.get(state.leftItemID);
      const newRightItem = Zotero.Items.get(state.rightItemID);
      if (!newLeftItem || !newRightItem) {
        throw new Error("Failed to get items for swap");
      }

      // 8. Initialize both readers with swapped content
      const win = Zotero.getMainWindow();
      await Promise.all([
        this.initializeReader(
          tabID,
          newLeftBrowser,
          newLeftItem,
          state.leftPopupset,
          rightViewState,
          false, // left is never isRight
        ),
        this.initializeReader(
          tabID,
          newRightBrowser,
          newRightItem,
          state.rightPopupset,
          leftViewState,
          true, // right is always isRight
        ),
      ]);

      // 9. Setup listeners for both new browsers
      this.setupFocusListeners(tabID, newLeftBrowser, newRightBrowser, win);
      this.setupCtrlKeyListener(tabID, newLeftBrowser);
      this.setupCtrlKeyListener(tabID, newRightBrowser);
      this.setupZoomButtonListeners(tabID, newLeftBrowser);
      this.setupZoomButtonListeners(tabID, newRightBrowser);

      // 10. Update scrollbar colors to reflect new primary side
      this.updateScrollbarColors(tabID);

      // 11. Update context pane for the active side
      const activeParentItemID =
        state.activeSide === "left"
          ? state.leftParentItemID
          : state.rightParentItemID;
      this.updateContextPane(tabID, win, activeParentItemID);

      // 12. Setup annotation sync if same PDF
      if (state.isSamePDF) {
        this.setupAnnotationManagerSync(tabID);
      }

      // 13. Update tab data and title
      this.updateTabDataForSession(tabID);
      await this.renameSplitViewTab(tabID);

      // 14. Restart sync if a primary view is active
      if (hadPrimary) {
        this.trackTimeout(
          state,
          () => {
            const s = this.stateMap.get(tabID);
            if (s && s.primarySide) {
              this.cacheViewerContainers(tabID);
              this.initSyncState(tabID);
              this.startSyncPolling(tabID);
            }
          },
          500,
        );
      }

      // Show success notification
      const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
      })
        .createLine({
          text: getString("splitview-swap-pdf"),
          type: "default",
          icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
        })
        .show();
      popup.startCloseTimer(2000);
    } catch (e) {
      Zotero.debug(`Split view: Error swapping PDFs: ${e}`);
    }
  }

  private static async handleSplitView(reader: any) {
    const tabID = reader.tabID;
    try {
      // Clean up any stale state for THIS tab only
      const existingState = this.stateMap.get(tabID);
      if (existingState && !existingState.isCleaningUp) {
        this.cleanupTab(tabID);
      }

      // Wait a bit for cleanup to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      const currentItem = Zotero.Items.get(reader.itemID);
      if (!currentItem) return;
      const selectedPDF = await this.pdfSelector.select(currentItem.libraryID);
      if (!selectedPDF) return;

      // Check if same PDF
      const isSamePDF = selectedPDF.id === reader.itemID;

      if (isSamePDF) {
        // Same file: use dual browser with annotation sync
        await this.convertToSamePDFSplitView(reader);
      } else {
        // Different files: use existing dual browser approach
        await this.convertToSplitView(reader, selectedPDF);
      }
    } catch {
      const s = this.stateMap.get(tabID);
      if (s && !s.isCleaningUp) {
        this.cleanupTab(tabID);
      }
    }
  }

  /**
   * Convert current reader tab to split view
   * Keeps the current PDF on the left side and adds the secondary PDF on the right
   */
  private static async convertToSplitView(
    currentReader: any,
    secondaryPDF: Zotero.Item,
  ) {
    const win = Zotero.getMainWindow();
    const Zotero_Tabs = (win as any).Zotero_Tabs;

    // 1. Get current tab and reader info
    const tabID = currentReader.tabID;
    const leftItemID = currentReader.itemID;
    const leftItem = Zotero.Items.get(leftItemID);
    if (!leftItem) throw new Error(`Attachment ${leftItemID} is unavailable`);
    const container = win.document.getElementById(tabID);

    if (!container) {
      throw new Error("Tab container not found");
    }

    // 2. Save current reader's viewState (position info)
    const leftViewState =
      await readerView.getViewStateFromReader(currentReader);

    // 3. Get right PDF's stored state
    const rightViewState =
      await attachmentState.getStoredViewState(secondaryPDF);

    // 4. Close current reader (but don't close tab)
    await readerRuntime.closeReaderWithoutClosingTab(currentReader);

    // 5. Replace tab container to remove old event listeners
    // The old ReaderTab added event listeners for tab-bottom-placeholder-resize,
    // tab-context-pane-toggle, and tab-selection-change that reference the dead reader.
    // Cloning without events removes these stale listeners.
    const newContainer = container.cloneNode(false) as HTMLElement;
    container.parentNode?.replaceChild(newContainer, container);

    // Restore TabContent custom element methods on the cloned container.
    // cloneNode may not preserve custom element prototype methods, so Zotero's
    // contextPane.update() calling tabContent.setContextPaneOpen() would fail.
    // These methods just dispatch events that our listeners below will handle.
    (newContainer as any).setContextPaneOpen = function (open: boolean) {
      this.dispatchEvent(
        new win.CustomEvent("tab-context-pane-toggle", {
          detail: { open },
        }),
      );
    };
    (newContainer as any).setBottomPlaceholderHeight = function (
      height: number,
    ) {
      this.dispatchEvent(
        new win.CustomEvent("tab-bottom-placeholder-resize", {
          detail: { height },
        }),
      );
    };
    (newContainer as any).onTabSelectionChanged = function (selected: boolean) {
      this.dispatchEvent(
        new win.CustomEvent("tab-selection-change", {
          detail: { selected },
        }),
      );
    };

    // Reset container styles to ensure proper flex layout
    (newContainer as any).style.display = "flex";
    (newContainer as any).style.flexDirection = "row";
    (newContainer as any).style.width = "100%";
    (newContainer as any).style.height = "100%";
    (newContainer as any).style.overflow = "hidden";

    // 6. Build split view layout
    const mainHbox = win.document.createXULElement("hbox") as XULElement;
    (mainHbox as any).style.display = "flex";
    (mainHbox as any).style.flexDirection = "row";
    (mainHbox as any).style.flex = "1 1 100%";
    (mainHbox as any).style.width = "100%";
    (mainHbox as any).style.height = "100%";
    (mainHbox as any).style.minWidth = "0";
    (mainHbox as any).style.overflow = "hidden";
    (mainHbox as any).style.boxSizing = "border-box";

    const leftBrowser = this.createReaderBrowser(win);
    const rightBrowser = this.createReaderBrowser(win);

    const resizer = win.document.createXULElement("box") as XULElement;
    resizer.className = "split-view-resizer";
    (resizer as any).style.cssText = `
      width: 1px;
      min-width: 1px;
      max-width: 1px;
      flex: 0 0 1px;
      cursor: ew-resize;
      background: var(--fill-quarternary, rgba(0, 0, 0, 0.1));
      position: relative;
      z-index: 100;
      box-sizing: border-box;
    `;
    resizer.setAttribute("mousethrough", "never");

    const leftPopupset = win.document.createXULElement(
      "popupset",
    ) as XULElement;
    const rightPopupset = win.document.createXULElement(
      "popupset",
    ) as XULElement;

    mainHbox.appendChild(leftBrowser);
    mainHbox.appendChild(resizer);
    mainHbox.appendChild(rightBrowser);
    newContainer.appendChild(mainHbox);
    newContainer.appendChild(leftPopupset);
    newContainer.appendChild(rightPopupset);

    // Set up event listeners for tab content events (replacing the dead reader's listeners)
    // Handlers are stored so they can be tracked in state after state creation.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const bottomPlaceholderHandler = (event: any) => {
      const s = self.stateMap.get(tabID);
      if (!s || s.isCleaningUp) return;
      const height =
        event.detail?.height !== undefined ? event.detail.height : null;
      try {
        const leftReader = readerRuntime.getInternalReaderFromBrowser(
          s.leftBrowser,
        );
        const rightReader = readerRuntime.getInternalReaderFromBrowser(
          s.rightBrowser,
        );
        if (leftReader?.setBottomPlaceholderHeight) {
          leftReader.setBottomPlaceholderHeight(height);
        }
        if (rightReader?.setBottomPlaceholderHeight) {
          rightReader.setBottomPlaceholderHeight(height);
        }
      } catch {
        // Ignore errors - readers may not be ready
      }
    };

    const contextPaneToggleHandler = (event: any) => {
      const s = self.stateMap.get(tabID);
      if (!s || s.isCleaningUp) return;
      const open = event.detail?.open ?? false;
      if (s.rightBrowser) {
        self.setContextPaneOpenForBrowser(s.rightBrowser, open);
      }
    };

    const tabSelectionChangeHandler = (_event: any) => {
      // No special handling needed for split view
    };

    // Listeners are added here; they will be tracked in state after state creation below
    newContainer.addEventListener(
      "tab-bottom-placeholder-resize",
      bottomPlaceholderHandler,
    );
    newContainer.addEventListener(
      "tab-context-pane-toggle",
      contextPaneToggleHandler,
    );
    newContainer.addEventListener(
      "tab-selection-change",
      tabSelectionChangeHandler,
    );

    // Get parent item IDs for context pane switching
    const leftParentItemID = leftItem.parentItemID || leftItem.id;
    const rightParentItemID = secondaryPDF.parentItemID || secondaryPDF.id;

    // 8. Initialize state and store in map (reuse current tabID)
    //    Capture original tab title before we rename it, for possible future use.
    let originalTitle: string | undefined;
    try {
      const { tab } = Zotero_Tabs._getTab(tabID);
      originalTitle = tab?.title;
    } catch {
      originalTitle = undefined;
    }

    const newState: SplitTabState = {
      tabID,
      container: newContainer as unknown as XUL.Box,
      leftBrowser,
      rightBrowser,
      leftPopupset,
      rightPopupset,
      leftItemID,
      rightItemID: secondaryPDF.id,
      leftParentItemID,
      rightParentItemID,
      primarySide: this.getDefaultPrimarySide(),
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
      eventListeners: [],
      timeoutIds: [],
      toolbarCloseObservers: [],
      leftViewerContainer: null,
      rightViewerContainer: null,
      splitRatio: 0.5,
      leftViewState: leftViewState,
      rightViewState: rightViewState,
      isCleaningUp: false,
      // Different PDF split view - no same PDF sync
      isSamePDF: false,
      annotationNotifierID: null,
      isSyncingSelection: false,
      annotationItemIDs: [],
      scrollSyncRAFPending: false,
      lastScrollSyncTime: 0,
      resizeTimerId: null,
      originalTitle,
    };
    this.stateMap.set(tabID, newState);

    // Track container event listeners that were added before state creation
    newState.eventListeners.push(
      {
        target: newContainer,
        type: "tab-bottom-placeholder-resize",
        listener: bottomPlaceholderHandler as EventListener,
      },
      {
        target: newContainer,
        type: "tab-context-pane-toggle",
        listener: contextPaneToggleHandler as EventListener,
      },
      {
        target: newContainer,
        type: "tab-selection-change",
        listener: tabSelectionChangeHandler as EventListener,
      },
    );

    // Set up drag functionality
    this.setupResizerDrag(
      tabID,
      resizer,
      leftBrowser,
      rightBrowser,
      mainHbox,
      win,
    );

    // Set initial flex values
    this.updateBrowserFlex(leftBrowser, rightBrowser, newState.splitRatio);

    // Register global tab notifier (if not already registered)
    this.ensureGlobalTabNotifier(win);

    // Set up context pane
    this.setupContextPane(tabID, win);

    // 9. Initialize both readers (with viewState)
    try {
      await Promise.all([
        this.initializeReader(
          tabID,
          leftBrowser,
          leftItem,
          leftPopupset,
          leftViewState,
          false,
        ),
        this.initializeReader(
          tabID,
          rightBrowser,
          secondaryPDF,
          rightPopupset,
          rightViewState,
          true,
        ),
      ]);

      // Show success notification
      const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
      })
        .createLine({
          text: getString("splitview-loaded"),
          type: "default",
          icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
        })
        .show();
      popup.startCloseTimer(3000);

      // Initialize context pane with left item
      const curState = this.stateMap.get(tabID);
      if (curState) {
        curState.activeSide = "left";
        this.updateContextPane(tabID, win, curState.leftParentItemID);
      }

      // Set up focus listeners
      this.setupFocusListeners(tabID, leftBrowser, rightBrowser, win);

      // Finish split-view setup after both readers initialize
      this.trackTimeout(
        newState,
        () => {
          const s = this.stateMap.get(tabID);
          if (!s) return;
          this.setupResizeListener(tabID, win);
          this.setupCtrlKeyListener(tabID, leftBrowser);
          this.setupCtrlKeyListener(tabID, rightBrowser);
          this.setupMainWindowKeyboardListener(tabID, win);
          this.setupZoomButtonListeners(tabID, leftBrowser);
          this.setupZoomButtonListeners(tabID, rightBrowser);
          this.setupContextPaneObserver(tabID, win);
          if (s.primarySide) {
            this.cacheViewerContainers(tabID);
            this.initSyncState(tabID);
            this.startSyncPolling(tabID);
          }
          // Apply scrollbar colors to indicate primary side
          this.updateScrollbarColors(tabID);
        },
        500,
      );

      // 10. Update tab data and title (include split view state for session restore)
      Zotero_Tabs.setTabData(tabID, {
        itemID: leftItemID,
        leftItemID,
        rightItemID: secondaryPDF.id,
        isSplitView: true,
        isSamePDF: false,
        splitRatio: newState.splitRatio,
      });
      await this.renameSplitViewTab(tabID);
    } catch (e) {
      this.cleanupTab(tabID);
      throw e;
    }
  }

  /**
   * Convert current reader tab to split view with the same PDF
   * Both sides show the same PDF with annotation synchronization
   */
  private static async convertToSamePDFSplitView(currentReader: any) {
    const win = Zotero.getMainWindow();
    const Zotero_Tabs = (win as any).Zotero_Tabs;

    // 1. Get current tab and reader info
    const tabID = currentReader.tabID;
    const itemID = currentReader.itemID;
    const item = Zotero.Items.get(itemID);
    if (!item) throw new Error(`Attachment ${itemID} is unavailable`);
    const container = win.document.getElementById(tabID);

    if (!container) {
      throw new Error("Tab container not found");
    }

    // 2. Save current reader's viewState (position info)
    const leftViewState =
      await readerView.getViewStateFromReader(currentReader);

    // 3. Close current reader (but don't close tab)
    await readerRuntime.closeReaderWithoutClosingTab(currentReader);

    // 4. Replace tab container to remove old event listeners
    const newContainer = container.cloneNode(false) as HTMLElement;
    container.parentNode?.replaceChild(newContainer, container);

    // Restore TabContent custom element methods on the cloned container.
    // cloneNode may not preserve custom element prototype methods, so Zotero's
    // contextPane.update() calling tabContent.setContextPaneOpen() would fail.
    (newContainer as any).setContextPaneOpen = function (open: boolean) {
      this.dispatchEvent(
        new win.CustomEvent("tab-context-pane-toggle", {
          detail: { open },
        }),
      );
    };
    (newContainer as any).setBottomPlaceholderHeight = function (
      height: number,
    ) {
      this.dispatchEvent(
        new win.CustomEvent("tab-bottom-placeholder-resize", {
          detail: { height },
        }),
      );
    };
    (newContainer as any).onTabSelectionChanged = function (selected: boolean) {
      this.dispatchEvent(
        new win.CustomEvent("tab-selection-change", {
          detail: { selected },
        }),
      );
    };

    // Reset container styles
    (newContainer as any).style.display = "flex";
    (newContainer as any).style.flexDirection = "row";
    (newContainer as any).style.width = "100%";
    (newContainer as any).style.height = "100%";
    (newContainer as any).style.overflow = "hidden";

    // 5. Build split view layout
    const mainHbox = win.document.createXULElement("hbox") as XULElement;
    (mainHbox as any).style.display = "flex";
    (mainHbox as any).style.flexDirection = "row";
    (mainHbox as any).style.flex = "1 1 100%";
    (mainHbox as any).style.width = "100%";
    (mainHbox as any).style.height = "100%";
    (mainHbox as any).style.minWidth = "0";
    (mainHbox as any).style.overflow = "hidden";
    (mainHbox as any).style.boxSizing = "border-box";

    const leftBrowser = this.createReaderBrowser(win);
    const rightBrowser = this.createReaderBrowser(win);

    const resizer = win.document.createXULElement("box") as XULElement;
    resizer.className = "split-view-resizer";
    (resizer as any).style.cssText = `
      width: 1px;
      min-width: 1px;
      max-width: 1px;
      flex: 0 0 1px;
      cursor: ew-resize;
      background: var(--fill-quarternary, rgba(0, 0, 0, 0.1));
      position: relative;
      z-index: 100;
      box-sizing: border-box;
    `;
    resizer.setAttribute("mousethrough", "never");

    const leftPopupset = win.document.createXULElement(
      "popupset",
    ) as XULElement;
    const rightPopupset = win.document.createXULElement(
      "popupset",
    ) as XULElement;

    mainHbox.appendChild(leftBrowser);
    mainHbox.appendChild(resizer);
    mainHbox.appendChild(rightBrowser);
    newContainer.appendChild(mainHbox);
    newContainer.appendChild(leftPopupset);
    newContainer.appendChild(rightPopupset);

    // Set up event listeners for tab content events
    // Handlers are stored so they can be tracked in state after state creation.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const bottomPlaceholderHandler2 = (event: any) => {
      const s = self.stateMap.get(tabID);
      if (!s || s.isCleaningUp) return;
      const height =
        event.detail?.height !== undefined ? event.detail.height : null;
      try {
        const leftReader = readerRuntime.getInternalReaderFromBrowser(
          s.leftBrowser,
        );
        const rightReader = readerRuntime.getInternalReaderFromBrowser(
          s.rightBrowser,
        );
        if (leftReader?.setBottomPlaceholderHeight) {
          leftReader.setBottomPlaceholderHeight(height);
        }
        if (rightReader?.setBottomPlaceholderHeight) {
          rightReader.setBottomPlaceholderHeight(height);
        }
      } catch {
        // Ignore errors
      }
    };

    const contextPaneToggleHandler2 = (event: any) => {
      const s = self.stateMap.get(tabID);
      if (!s || s.isCleaningUp) return;
      const open = event.detail?.open ?? false;
      if (s.rightBrowser) {
        self.setContextPaneOpenForBrowser(s.rightBrowser, open);
      }
    };

    const tabSelectionChangeHandler2 = () => {
      // No special handling needed
    };

    newContainer.addEventListener(
      "tab-bottom-placeholder-resize",
      bottomPlaceholderHandler2,
    );
    newContainer.addEventListener(
      "tab-context-pane-toggle",
      contextPaneToggleHandler2,
    );
    newContainer.addEventListener(
      "tab-selection-change",
      tabSelectionChangeHandler2,
    );

    // Get parent item ID for context pane
    const parentItemID = item.parentItemID || item.id;

    // 7. Initialize state and store in map
    //    Capture original tab title before any rename, so we could restore or
    //    inspect it in the future if needed.
    let originalTitle: string | undefined;
    try {
      const { tab } = Zotero_Tabs._getTab(tabID);
      originalTitle = tab?.title;
    } catch {
      originalTitle = undefined;
    }

    const newState: SplitTabState = {
      tabID,
      container: newContainer as unknown as XUL.Box,
      leftBrowser,
      rightBrowser,
      leftPopupset,
      rightPopupset,
      leftItemID: itemID,
      rightItemID: itemID, // Same PDF
      leftParentItemID: parentItemID,
      rightParentItemID: parentItemID, // Same parent
      primarySide: this.getDefaultPrimarySide(),
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
      eventListeners: [],
      timeoutIds: [],
      toolbarCloseObservers: [],
      leftViewerContainer: null,
      rightViewerContainer: null,
      splitRatio: 0.5,
      leftViewState: leftViewState,
      rightViewState: leftViewState, // Start at same position as left side
      isCleaningUp: false,
      // Same PDF split view specific
      isSamePDF: true,
      annotationNotifierID: null,
      isSyncingSelection: false,
      annotationItemIDs: item.getAnnotations().map((ann: any) => ann.id),
      scrollSyncRAFPending: false,
      lastScrollSyncTime: 0,
      resizeTimerId: null,
      originalTitle,
    };
    this.stateMap.set(tabID, newState);

    // Track container event listeners that were added before state creation
    newState.eventListeners.push(
      {
        target: newContainer,
        type: "tab-bottom-placeholder-resize",
        listener: bottomPlaceholderHandler2 as EventListener,
      },
      {
        target: newContainer,
        type: "tab-context-pane-toggle",
        listener: contextPaneToggleHandler2 as EventListener,
      },
      {
        target: newContainer,
        type: "tab-selection-change",
        listener: tabSelectionChangeHandler2 as EventListener,
      },
    );

    // Set up drag functionality
    this.setupResizerDrag(
      tabID,
      resizer,
      leftBrowser,
      rightBrowser,
      mainHbox,
      win,
    );

    // Set initial flex values
    this.updateBrowserFlex(leftBrowser, rightBrowser, newState.splitRatio);

    // Register global tab notifier (if not already registered)
    this.ensureGlobalTabNotifier(win);

    // Set up context pane
    this.setupContextPane(tabID, win);

    // 8. Initialize both readers with the same PDF
    try {
      await Promise.all([
        this.initializeReader(
          tabID,
          leftBrowser,
          item,
          leftPopupset,
          leftViewState,
          false,
        ),
        this.initializeReader(
          tabID,
          rightBrowser,
          item,
          rightPopupset,
          leftViewState,
          true,
        ),
      ]);

      // Show success notification
      const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
      })
        .createLine({
          text: getString("splitview-same-pdf-loaded"),
          type: "default",
          icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
        })
        .show();
      popup.startCloseTimer(3000);

      // Initialize context pane with left item
      const curState = this.stateMap.get(tabID);
      if (curState) {
        curState.activeSide = "left";
        this.updateContextPane(tabID, win, curState.leftParentItemID);
      }

      // Set up focus listeners
      this.setupFocusListeners(tabID, leftBrowser, rightBrowser, win);

      // Hook into both readers' annotation managers to mirror changes
      // instantly, replicating Zotero's native split view behavior where
      // both views share one _annotationManager. The render() hook fires
      // synchronously when an annotation is created/modified/deleted,
      // bypassing the slow onSaveAnnotations debounce path entirely.
      this.setupAnnotationManagerSync(tabID);

      // Set up selection sync for same PDF
      this.setupSelectionSync(tabID);

      // Finish split-view setup after both readers initialize
      this.trackTimeout(
        newState,
        () => {
          const s = this.stateMap.get(tabID);
          if (!s) return;
          this.setupResizeListener(tabID, win);
          this.setupCtrlKeyListener(tabID, leftBrowser);
          this.setupCtrlKeyListener(tabID, rightBrowser);
          this.setupMainWindowKeyboardListener(tabID, win);
          this.setupZoomButtonListeners(tabID, leftBrowser);
          this.setupZoomButtonListeners(tabID, rightBrowser);
          this.setupContextPaneObserver(tabID, win);
          if (s.primarySide) {
            this.cacheViewerContainers(tabID);
            this.initSyncState(tabID);
            this.startSyncPolling(tabID);
          }
          // Apply scrollbar colors to indicate primary side
          this.updateScrollbarColors(tabID);
        },
        500,
      );

      // 9. Update tab data and title for session restore.
      Zotero_Tabs.setTabData(tabID, {
        itemID: itemID,
        leftItemID: itemID,
        rightItemID: itemID,
        isSplitView: true,
        isSamePDF: true,
        splitRatio: newState.splitRatio,
      });
      await this.renameSplitViewTab(tabID);
    } catch (e) {
      this.cleanupTab(tabID);
      throw e;
    }
  }

  // NOTE: The old Notifier-based setupAnnotationSync and refreshAnnotationsInBothViews
  // have been removed. Annotation sync for same-PDF split view is now handled by
  // setupAnnotationManagerSync() which hooks directly into the annotation manager's
  // render() method for instant, synchronous propagation.

  /**
   * Set up selection sync for same PDF split view
   * When an annotation is selected on one side, sync to the other
   */
  private static setupSelectionSync(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || !state.isSamePDF) return;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    // Helper to clone data into browser's context to avoid permission errors
    const cloneForBrowser = (browser: XULBrowserElement, data: any) => {
      try {
        const win = browser.contentWindow;
        if (!win) return data;
        return Components.utils.cloneInto(data, win, { wrapReflectors: true });
      } catch {
        return data;
      }
    };

    // Set up observers on both readers' internal state
    const setupObserver = (browser: XULBrowserElement, isLeft: boolean) => {
      try {
        const internalReader =
          readerRuntime.getInternalReaderFromBrowser(browser);
        if (!internalReader) return;

        // Hook into the reader's annotation selection
        const originalSetSelectedAnnotationIDs =
          internalReader.setSelectedAnnotationIDs?.bind(internalReader);
        if (originalSetSelectedAnnotationIDs) {
          internalReader.setSelectedAnnotationIDs = (ids: string[]) => {
            // Call original
            originalSetSelectedAnnotationIDs(ids);

            // Sync to other side if not already syncing
            const s = self.stateMap.get(tabID);
            if (s?.isSamePDF && !s.isSyncingSelection && !s.isCleaningUp) {
              s.isSyncingSelection = true;
              try {
                const otherBrowser = isLeft ? s.rightBrowser : s.leftBrowser;
                const otherReader =
                  readerRuntime.getInternalReaderFromBrowser(otherBrowser);
                if (otherReader?.setSelectedAnnotationIDs) {
                  // Clone ids array for the other browser's context
                  const clonedIds = cloneForBrowser(
                    otherBrowser,
                    Array.from(ids),
                  );
                  otherReader.setSelectedAnnotationIDs(clonedIds);
                }
              } finally {
                const s2 = self.stateMap.get(tabID);
                if (s2) {
                  s2.isSyncingSelection = false;
                }
              }
            }
          };
        }
      } catch {
        // Ignore errors
      }
    };

    setupObserver(state.leftBrowser, true);
    setupObserver(state.rightBrowser, false);
  }

  /**
   * Initialize sync state - record primary's current position
   */
  private static initSyncState(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;
    const primarySide = this.getEffectivePrimarySide(state);
    if (!primarySide) {
      state.lastPrimaryScroll = null;
      return;
    }

    try {
      // Refresh cached viewer containers to ensure syncViews uses up-to-date refs
      // (e.g. after primary side switch or browser replacement)
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
    } catch (e) {
      Zotero.debug(
        `Split view: initSyncState error (browser may be dead): ${e}`,
      );
    }
  }

  /**
   * Sync the current side to the target side's position and scale state.
   *
   * The current side is the view where the context menu was triggered.
   * The target side is always the opposite view whose state is copied onto the
   * current side.
   */
  private static async syncPositionAndScale(
    tabID: string,
    currentSide: "left" | "right",
  ) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    // Pause scroll sync to avoid feedback loops
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

      const fallbackViewState =
        targetSide === "left" ? state.leftViewState : state.rightViewState;
      const viewState =
        readerView.getImmediateViewStateFromBrowser(sourceBrowser) ||
        readerView.getCurrentViewStateFromBrowser(sourceBrowser) ||
        (fallbackViewState
          ? JSON.parse(JSON.stringify(fallbackViewState))
          : null);
      if (!viewState) {
        Zotero.debug("Split view: syncPositionAndScale - viewState not found");
        return;
      }

      const applyResult = await readerView.applyViewStateToReader(
        currentReader,
        viewState,
      );

      Zotero.debug(
        `Split view: synced ` +
          `${currentSide} view to ${targetSide} view state ` +
          `(page ${viewState.pageIndex}, top=${viewState.top}, ` +
          `left=${viewState.left}, scale=${viewState.scale})`,
      );

      // Show notification
      const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
      })
        .createLine({
          text: applyResult?.pageIndexClamped
            ? getString("splitview-last-page-reached", {
                args: { side: currentSide },
              })
            : getString("splitview-position-synced"),
          type: "default",
          icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
        })
        .show();
      popup.startCloseTimer(2000);
    } catch (e) {
      Zotero.debug(`Split view: syncPositionAndScale error: ${e}`);
    } finally {
      // Resume scroll sync after _setState has completed and the view has settled.
      // Re-initialize sync baselines to prevent position jumps.
      this.trackTimeout(
        state,
        () => {
          const s = this.stateMap.get(tabID);
          if (s) {
            s.syncPaused = false;
            this.initSyncState(tabID);
          }
        },
        400,
      );
    }
  }

  /**
   * Set up zoom button listeners on a browser's toolbar
   * This directly hooks into zoom button clicks for reliable sync
   */
  private static setupZoomButtonListeners(
    tabID: string,
    browser: XULBrowserElement,
  ) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    try {
      // The zoom buttons are in the reader's main document (browser.contentWindow),
      // NOT in the inner PDF.js iframe
      const win = browser.contentWindow;
      if (!win) return;

      const wrappedWin = (win as any).wrappedJSObject || win;
      const doc = wrappedWin.document;
      if (!doc) return;

      // Find zoom buttons in the toolbar
      // Try multiple selectors as Zotero's reader may use different ones
      // Search for button with zoom-in/zoom-out/zoom-reset icons or titles
      const findButton = (type: "in" | "out" | "reset"): Element | null => {
        const selectors =
          type === "in"
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
                // Zotero reader specific
                'button[data-tabstop="1"][class*="zoom"]',
              ]
            : type === "out"
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
                  // Reset zoom selectors (Zotero reader uses zoomAuto)
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
            const btn = doc.querySelector(selector);
            if (btn) return btn;
          } catch {
            // Invalid selector, skip
          }
        }

        // Try finding by icon class patterns
        const allButtons = doc.querySelectorAll('button, [role="button"]');
        for (const btn of allButtons) {
          const className = (btn.className || "").toLowerCase();
          const title = (btn.getAttribute("title") || "").toLowerCase();
          const ariaLabel = (
            btn.getAttribute("aria-label") || ""
          ).toLowerCase();

          if (type === "in") {
            if (
              className.includes("zoomin") ||
              className.includes("zoom-in") ||
              title.includes("zoom in") ||
              ariaLabel.includes("zoom in") ||
              title.includes("放大") ||
              ariaLabel.includes("放大")
            ) {
              return btn;
            }
          } else if (type === "out") {
            if (
              className.includes("zoomout") ||
              className.includes("zoom-out") ||
              title.includes("zoom out") ||
              ariaLabel.includes("zoom out") ||
              title.includes("缩小") ||
              ariaLabel.includes("缩小")
            ) {
              return btn;
            }
          } else {
            if (
              className.includes("zoomauto") ||
              className.includes("zoom-auto") ||
              className.includes("zoomreset") ||
              className.includes("zoom-reset") ||
              title.includes("zoom reset") ||
              title.includes("reset zoom") ||
              ariaLabel.includes("zoom reset") ||
              ariaLabel.includes("reset zoom") ||
              title.includes("重置") ||
              ariaLabel.includes("重置")
            ) {
              return btn;
            }
          }
        }

        return null;
      };

      const zoomInBtn = findButton("in");
      const zoomOutBtn = findButton("out");
      const zoomResetBtn = findButton("reset");

      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      const isLeft = browser === state.leftBrowser;

      if (zoomInBtn) {
        const zoomInHandler = () => {
          self.handleZoomButtonClick(tabID, isLeft, "in");
        };
        this.trackEventListener(
          state,
          zoomInBtn,
          "click",
          zoomInHandler as EventListener,
          true,
        );
      }

      if (zoomOutBtn) {
        const zoomOutHandler = () => {
          self.handleZoomButtonClick(tabID, isLeft, "out");
        };
        this.trackEventListener(
          state,
          zoomOutBtn,
          "click",
          zoomOutHandler as EventListener,
          true,
        );
      }

      if (zoomResetBtn) {
        const zoomResetHandler = () => {
          self.handleZoomButtonClick(tabID, isLeft, "reset");
        };
        this.trackEventListener(
          state,
          zoomResetBtn,
          "click",
          zoomResetHandler as EventListener,
          true,
        );
      }
    } catch {
      // Ignore errors setting up zoom button listeners
    }
  }

  /**
   * Handle zoom button click - sync to secondary if this is primary
   */
  private static handleZoomButtonClick(
    tabID: string,
    isLeft: boolean,
    direction: "in" | "out" | "reset",
  ) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;
    const primarySide = this.getEffectivePrimarySide(state);
    if (!primarySide) return;

    // Only sync from primary to secondary
    const isPrimary =
      (isLeft && primarySide === "left") ||
      (!isLeft && primarySide === "right");
    if (!isPrimary) return;

    // Skip if Ctrl is pressed (user doing Ctrl+wheel zoom shouldn't sync)
    if (state.ctrlPressed) return;

    const secondaryBrowser =
      primarySide === "left" ? state.rightBrowser : state.leftBrowser;

    // Pause scroll sync during zoom
    state.zoomingCount++;

    // Sync zoom action to secondary immediately
    if (direction === "in") {
      this.zoomInForBrowser(secondaryBrowser);
    } else if (direction === "out") {
      this.zoomOutForBrowser(secondaryBrowser);
    } else {
      this.zoomResetForBrowser(secondaryBrowser);
    }

    // Resume scroll sync after a delay, and reinitialize sync state
    // to prevent position jump (zoom changes scroll positions)
    this.trackTimeout(
      state,
      () => {
        const s = this.stateMap.get(tabID);
        if (s) {
          s.zoomingCount = Math.max(0, s.zoomingCount - 1);
          // Reinitialize sync state after zoom completes
          // This updates lastPrimaryScroll to current position
          if (s.zoomingCount === 0) {
            this.initSyncState(tabID);
          }
        }
      },
      150,
    ); // Slightly longer to ensure zoom animation completes
  }

  /**
   * Initialize a reader in a browser element
   * @param viewState - Optional view state to restore position
   * @param isRight - Whether this is the right browser (shows context pane toggle)
   */
  private static async initializeReader(
    tabID: string,
    browser: XULBrowserElement,
    item: Zotero.Item,
    popupset: XULElement,
    viewState?: any,
    isRight: boolean = false,
  ): Promise<void> {
    await readerRuntime.waitForBrowserLoad(browser);

    const win = browser.contentWindow;
    if (!win) throw new Error("Browser contentWindow not available");

    const wrappedWin = (win as any).wrappedJSObject || win;
    const mainWindow = Zotero.getMainWindow();

    // Get PDF data URL
    const data = {
      url: `zotero://attachment/${Zotero.API.getLibraryPrefix(item.libraryID)}/items/${item.key}/`,
    };

    // Get annotations - match Zotero's _getAnnotation method
    const annotationItems = item.getAnnotations();
    const annotations = await Promise.all(
      annotationItems.map(async (annot: Zotero.Item) => {
        try {
          if (!annot || !annot.isAnnotation()) {
            return null;
          }
          const json: any = await Zotero.Annotations.toJSON(annot);
          json.id = annot.key;
          delete json.key;
          // Ensure no undefined values for non-array properties (match Zotero's behavior)
          for (const key in json) {
            if (!Array.isArray(json[key])) {
              json[key] = json[key] || "";
            }
          }
          json.tags = json.tags || [];
          return json;
        } catch {
          return null;
        }
      }),
    );
    const validAnnotations = annotations.filter((a) => a !== null);

    // Prepare Fluent localization data
    const ftl: string[] = [];
    try {
      ftl.push(
        Zotero.File.getContentsFromURL("chrome://zotero/locale/zotero.ftl"),
      );
    } catch {
      // Ignore FTL loading errors
    }
    try {
      ftl.push(
        Zotero.File.getContentsFromURL("chrome://zotero/locale/reader.ftl"),
      );
    } catch {
      // Ignore FTL loading errors
    }

    // Store references for callbacks
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const itemRef = item;
    const browserRef = browser;
    const popupsetRef = popupset;
    const readAloudConfig = await this.readAloud.getReaderConfig(
      browser,
      ftl,
      (status) => this.handleReadAloudStatus(tabID, browser, status),
    );

    // Only show context pane toggle button on the RIGHT browser
    // The right reader's toggle controls the global context pane
    const showContextPaneToggle = isRight;
    const mainWin = Zotero.getMainWindow();
    const contextPaneOpen = isRight
      ? !((mainWin as any).ZoteroContextPane?.collapsed ?? true)
      : false;

    // bottomPlaceholderHeight controls stackedView in reader-ui.js:
    //   let stackedView = state.bottomPlaceholderHeight !== null;
    // When stackedView = true, the toggle button uses a different icon (bottom sidebar)
    // and is always shown regardless of contextPaneOpen.
    // For standard (non-stacked) layout, this MUST be null so the toggle hides when
    // context pane opens and uses the correct sidebar icon.
    const isStacked = Zotero.Prefs.get("layout") === "stacked";
    const bottomPlaceholderHeight = isStacked ? 0 : null;

    // Create internal reader config - all callbacks defined inline, clone entire object once
    const readerConfig = {
      type: "pdf",
      data,
      annotations: validAnnotations,
      readOnly: false,
      authorName:
        item.library.libraryType === "group"
          ? Zotero.Users.getCurrentName()
          : "",
      showContextPaneToggle,
      contextPaneOpen, // Right browser shows toggle to control global context pane
      sidebarWidth: 240,
      sidebarOpen: false, // Default to collapsed in split view
      bottomPlaceholderHeight,
      rtl: (Zotero as any).rtl,
      fontSize: Zotero.Prefs.get("fontSize"),
      ftl,
      showAnnotations: true,
      // Additional reader preferences
      textSelectionAnnotationMode: Zotero.Prefs.get(
        "reader.textSelectionAnnotationMode",
      ),
      customThemes:
        (Zotero as any).SyncedSettings?.get(
          Zotero.Libraries.userLibraryID,
          "readerCustomThemes",
        ) ?? [],
      lightTheme: Zotero.Prefs.get("reader.lightTheme"),
      darkTheme: Zotero.Prefs.get("reader.darkTheme"),
      fontFamily: Zotero.Prefs.get("reader.ebookFontFamily"),
      hyphenate: Zotero.Prefs.get("reader.ebookHyphenate"),
      autoDisableNoteTool: Zotero.Prefs.get("reader.autoDisableTool.note"),
      autoDisableTextTool: Zotero.Prefs.get("reader.autoDisableTool.text"),
      autoDisableImageTool: Zotero.Prefs.get("reader.autoDisableTool.image"),
      sidebarView: Zotero.Prefs.get("reader.lastSidebarTab"),
      ...readAloudConfig,
      // Pass viewState to restore position
      primaryViewState: viewState,
      // Required callbacks - defined as regular functions
      onOpenContextMenu: () => {
        const params = wrappedWin.contextMenuParams;
        if (params) {
          self.openContextMenu(browserRef, popupsetRef, params);
        }
      },
      onToggleSidebar: (open: boolean) => {
        // Sync sidebar toggle when sync is enabled
        self.handleSidebarToggle(tabID, browserRef, open);
      },
      onChangeSidebarWidth: (_width: number) => {
        // No-op for split view
      },
      onChangeViewState: (viewState: any, _primary: boolean) => {
        // Track view state for saving to disk later
        const s = self.stateMap.get(tabID);
        if (s && !s.isCleaningUp) {
          const isLeft = browserRef === s.leftBrowser;
          const stateCopy = JSON.parse(JSON.stringify(viewState));
          if (isLeft) {
            s.leftViewState = stateCopy;
          } else {
            s.rightViewState = stateCopy;
          }
          if (
            self.shouldSyncLastReadAloudPositionFromBrowser(
              s,
              browserRef,
              viewState,
            )
          ) {
            attachmentState.syncLastReadAloudPositionToItem(itemRef, viewState);
          }
        }
        // Sync zoom when scale changes (toolbar zoom in/out)
        self.handleViewStateChange(browserRef, viewState);
      },
      onSaveAnnotations: async (annotations: any[], callback: () => void) => {
        await self.handleAnnotationSave(itemRef, annotations);
        if (callback) callback();
      },
      onDeleteAnnotations: (ids: string[]) => {
        self.handleAnnotationDelete(itemRef, ids);
      },
      onAddToNote: (_annotations: any[]) => {
        // No-op for split view
      },
      onOpenTagsPopup: (_id: string, _x: number, _y: number) => {
        // Tags popup not implemented for split view
      },
      onClosePopup: () => {
        // No-op
      },
      onOpenLink: (url: string) => {
        Zotero.launchURL(url);
      },
      onCopyImage: (_dataURL: string) => {
        // Image copy not implemented for split view
      },
      onSaveImageAs: (_dataURL: string) => {
        // Save image not implemented for split view
      },
      onSetDataTransferAnnotations: (
        _dataTransfer: any,
        _annotations: any[],
        _fromText: boolean,
      ) => {
        // Drag-drop not implemented for split view
      },
      onToggleContextPane: () => {
        // Toggle global context pane
        const mainWin = Zotero.getMainWindow();
        if ((mainWin as any).ZoteroContextPane) {
          (mainWin as any).ZoteroContextPane.togglePane();
          // Update right reader's contextPaneOpen state after toggle
          // This controls whether the toggle button shows in the toolbar
          setTimeout(() => {
            const s = self.stateMap.get(tabID);
            if (s?.rightBrowser) {
              const isOpen = !(
                (mainWin as any).ZoteroContextPane?.collapsed ?? true
              );
              self.setContextPaneOpenForBrowser(s.rightBrowser, isOpen);
            }
          }, 50);
        }
      },
    };

    // Clone entire config once with wrapReflectors and cloneFunctions
    wrappedWin.createReader(
      Components.utils.cloneInto(readerConfig, win, {
        wrapReflectors: true,
        cloneFunctions: true,
      }),
    );

    // Wait for internal reader to be ready
    await readerRuntime.waitForInternalReader(browser);

    this.installToolbarCloseButton(tabID, browser, isRight ? "right" : "left");

    // Only hide the reader's internal sidenav on the LEFT browser
    // The RIGHT browser keeps its toggle button to control the global context pane
    if (!isRight) {
      this.hideReaderSidenav(browser);
    } else {
      // Inject a content-side event listener for synchronous context pane state updates.
      // setContextPaneOpen() uses React's flushSync() which only works when called from
      // within the content compartment. By injecting a <script>, the listener runs in the
      // content compartment so flushSync() works correctly, producing a smooth transition
      // without flicker when the toggle button appears/disappears.
      this.injectContextPaneHandler(browser);
    }
  }

  /**
   * Add a close button to the reader toolbar for this split-view side.
   */
  private static installToolbarCloseButton(
    tabID: string,
    browser: XULBrowserElement,
    side: "left" | "right",
  ) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp || !readerRuntime.isBrowserAlive(browser))
      return;

    try {
      state.toolbarCloseObservers = state.toolbarCloseObservers.filter(
        (entry) => {
          if (entry.side !== side) return true;
          try {
            entry.observer.disconnect();
          } catch {
            // Ignore observers from an already-unloaded browser
          }
          return false;
        },
      );

      const win = browser.contentWindow;
      if (!win) return;
      const wrappedWin = (win as any).wrappedJSObject || win;
      const doc = wrappedWin.document as Document | undefined;
      if (!doc) return;

      const buttonID = `split-view-close-${side}`;
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;

      const addButton = () => {
        const currentState = self.stateMap.get(tabID);
        if (!currentState || currentState.isCleaningUp) return;
        if (doc.getElementById(buttonID)) return;

        const findButton = doc.querySelector(
          ".toolbar .end .toolbar-button.find",
        );
        if (!findButton?.parentNode) return;

        const button = doc.createElement("button");
        button.id = buttonID;
        button.className = "toolbar-button split-view-close-button";
        button.setAttribute("type", "button");
        button.setAttribute("tabindex", "-1");
        button.setAttribute("title", this.getCloseViewMenuLabel());
        button.setAttribute("aria-label", this.getCloseViewMenuLabel());

        button.innerHTML = `
          <svg class="split-view-close-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M11.2923 12L12 11.292L8.70711 7.99999L12 4.70796L11.2922 4L8.00011 7.29299L4.70798 4L4 4.70774L7.29311 7.99999L4 11.2922L4.70796 12L8.00011 8.70699L11.2923 12Z" fill="currentColor"></path>
          </svg>
        `;

        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void self.revertToSingleReader(tabID, side);
        });

        findButton.after(button);
      };

      const injectStyle = () => {
        if (doc.getElementById("split-view-close-button-style")) return;
        const style = doc.createElement("style");
        style.id = "split-view-close-button-style";
        style.textContent = `
          .toolbar-button.split-view-close-button {
            flex: 0 0 28px;
            color: var(--fill-secondary);
          }

          .toolbar-button.split-view-close-button .split-view-close-icon {
            width: 16px;
            height: 16px;
            display: block;
            pointer-events: none;
          }
        `;
        doc.head?.appendChild(style);
      };

      injectStyle();
      addButton();

      const observer = new win.MutationObserver(() => addButton());
      const observerTarget =
        doc.getElementById("reader-ui") || doc.documentElement;
      observer.observe(observerTarget, {
        childList: true,
        subtree: true,
      });
      state.toolbarCloseObservers.push({ side, observer });
    } catch (e) {
      Zotero.debug(`Split view: installToolbarCloseButton failed: ${e}`);
    }
  }

  /**
   * Hide the sidenav inside a reader browser
   * This prevents each reader from having its own context pane toggle
   */
  private static hideReaderSidenav(browser: XULBrowserElement) {
    try {
      const win = browser.contentWindow;
      if (!win) return;

      const wrappedWin = (win as any).wrappedJSObject || win;
      const doc = wrappedWin.document;
      if (!doc) return;

      const sidenav = doc.querySelector(
        ".sidenav, reader-sidenav, #sidenav, [class*='sidenav']",
      );
      if (sidenav) {
        sidenav.style.display = "none";
      }

      // Also try to find any context pane toggle buttons
      const toggleBtns = doc.querySelectorAll(
        "[class*='context-pane'], [data-action='toggle-pane']",
      );
      toggleBtns.forEach((btn: any) => {
        btn.style.display = "none";
      });

      // Check the internal reader object for sidenav
      const internalReader =
        readerRuntime.getInternalReaderFromBrowser(browser);
      if (internalReader) {
        // Try to hide sidenav via the reader API if available
        if (internalReader._sidenav) {
          internalReader._sidenav.style.display = "none";
        }
        // Some readers have a toolbarRight that contains the sidenav
        if (internalReader._toolbarRight) {
          // Only hide context pane related items, not all toolbar items
          const contextItems = internalReader._toolbarRight.querySelectorAll?.(
            "[class*='context'], [data-action='toggle-pane']",
          );
          contextItems?.forEach((item: any) => {
            item.style.display = "none";
          });
        }
      }
    } catch {
      // Ignore errors
    }
  }

  private static shouldSyncLastReadAloudPositionFromBrowser(
    state: SplitTabState,
    browser: XULBrowserElement,
    viewState: any,
  ): boolean {
    if (!viewState || !("lastReadAloudPosition" in viewState)) return false;

    const side = this.getReaderSideByBrowser(state.tabID, browser);
    if (!side) return false;

    const status = state.readAloudStatuses[side];
    return state.readAloudSide === side && !!status?.active && !status.paused;
  }

  /**
   * Find an already-open ordinary reader tab for an attachment item.
   * Split-view tabs are explicitly excluded from reuse.
   */
  private static findReusableReaderTabID(
    itemID: number,
    excludedTabIDs: Set<string> = new Set(),
  ): string | null {
    try {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = (win as any).Zotero_Tabs;
      const tabs =
        typeof Zotero_Tabs?.getTabs === "function"
          ? Zotero_Tabs.getTabs()
          : Zotero_Tabs?._tabs || [];

      for (const tab of tabs) {
        if (!tab?.id || excludedTabIDs.has(tab.id)) continue;
        if (tab.data?.isSplitView) continue;
        const isReaderTab =
          tab.type === "reader" ||
          tab.type === "reader-unloaded" ||
          tab.type === "reader-loading" ||
          tab.type?.startsWith("reader") ||
          tab.mode === "reader";
        if (isReaderTab && tab.data?.itemID === itemID) {
          return tab.id;
        }
      }
    } catch (e) {
      Zotero.debug(`Split view: findReusableReaderTabID error: ${e}`);
    }
    return null;
  }

  /**
   * Wait until a tab has a live reader instance.
   */
  private static async waitForReaderByTabID(
    tabID: string,
    maxWaitMs = 10000,
  ): Promise<any | null> {
    const start = Date.now();
    let reader = Zotero.Reader.getByTabID(tabID);
    while (!reader && Date.now() - start < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      reader = Zotero.Reader.getByTabID(tabID);
    }
    if (!reader) return null;
    await readerRuntime.waitForReaderReady(reader, maxWaitMs);
    return reader;
  }

  /**
   * Wait until a Zotero tab and its reader instance are fully gone.
   */
  private static async waitForTabClosed(
    tabID: string,
    maxWaitMs = 3000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = (win as any)?.Zotero_Tabs;
      const reader = Zotero.Reader.getByTabID(tabID);
      let tab: any;
      try {
        tab = Zotero_Tabs?._getTab(tabID)?.tab || null;
      } catch {
        tab = null;
      }
      if (!reader && !tab) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Let the embedded split readers flush debounced view-state callbacks before
   * the browsers are unloaded and standard readers are reopened.
   */
  private static async waitForSplitViewToSettle(): Promise<void> {
    // Zotero reader debounces view-state updates at 300ms. Keep a small margin
    // so the final scroll callback reliably lands before cleanup starts.
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  /**
   * Wait for a standard reader tab to finish background loading and apply the
   * desired view state without selecting it.
   */
  private static async restoreSeparateViewTarget(
    tabID: string,
    viewState: any,
  ): Promise<void> {
    try {
      const reader = await this.waitForReaderByTabID(tabID);
      if (!reader) return;
      await readerView.applyViewStateToReader(reader, viewState);
    } catch (e) {
      Zotero.debug(`Split view: restoreSeparateViewTarget failed: ${e}`);
    }
  }

  /**
   * Reuse or create a normal reader tab in the background, then restore the
   * split-view state without switching focus to it.
   */
  private static async prepareSeparateViewTarget(
    target: SeparateViewTarget,
    tabIndex: number,
    activate = false,
    deferRestore = false,
  ): Promise<void> {
    const win = Zotero.getMainWindow();
    const Zotero_Tabs = (win as any).Zotero_Tabs;

    const selectTargetIfNeeded = () => {
      if (!activate || !target.tabID) return;
      if (Zotero_Tabs.selectedID !== target.tabID) {
        Zotero_Tabs.select(target.tabID);
      }
    };

    const openTarget = async (title?: string): Promise<void> => {
      const reader = await Zotero.Reader.open(target.itemID, undefined, {
        title,
        tabIndex,
        openInBackground: !activate,
        allowDuplicate: true,
      });
      target.tabID = reader?.tabID || null;
      if (!target.tabID) return;
      selectTargetIfNeeded();
      if (deferRestore) return;
      // Fresh reader tabs usually restore from `.zotero-reader-state` during
      // open, but still reapply the captured in-memory state as a fallback in
      // case disk persistence failed.
      await this.restoreSeparateViewTarget(target.tabID, target.viewState);
    };

    if (!target.tabID) {
      await openTarget();
      return;
    }

    let tab: any = null;
    try {
      ({ tab } = Zotero_Tabs._getTab(target.tabID));
    } catch (e) {
      Zotero.debug(
        `Split view: prepareSeparateViewTarget get tab failed: ${e}`,
      );
    }

    if (!tab) {
      target.tabID = null;
      await openTarget();
      return;
    }

    const existingTabID = target.tabID;
    const existingTitle = tab.title;

    try {
      Zotero_Tabs.move(existingTabID, tabIndex);
    } catch (e) {
      Zotero.debug(`Split view: separateViews move tab failed: ${e}`);
    }

    const liveReader = Zotero.Reader.getByTabID(existingTabID);
    if (liveReader) {
      target.tabID = existingTabID;
      selectTargetIfNeeded();
      if (deferRestore) return;
      await readerRuntime.waitForReaderReady(liveReader);
      await readerView.applyViewStateToReader(liveReader, target.viewState);
      return;
    }

    let refreshedTab = tab;
    try {
      refreshedTab = Zotero_Tabs._getTab(existingTabID).tab || tab;
    } catch (e) {
      Zotero.debug(
        `Split view: prepareSeparateViewTarget refresh tab failed: ${e}`,
      );
    }

    if (refreshedTab?.type === "reader-unloaded") {
      try {
        Zotero_Tabs.close(existingTabID);
        await this.waitForTabClosed(existingTabID);
      } catch (e) {
        Zotero.debug(
          `Split view: prepareSeparateViewTarget close unloaded tab failed: ${e}`,
        );
      }
      target.tabID = null;
      await openTarget(refreshedTab.title || existingTitle);
      return;
    }

    if (refreshedTab?.type === "reader-loading") {
      target.tabID = existingTabID;
      selectTargetIfNeeded();
      if (deferRestore) return;
      const loadingReader = await this.waitForReaderByTabID(existingTabID);
      if (!loadingReader) return;
      await readerView.applyViewStateToReader(loadingReader, target.viewState);
      return;
    }

    target.tabID = null;
    await openTarget(existingTitle);
  }

  /**
   * Open context menu for a reader
   */
  private static openContextMenu(
    browser: XULBrowserElement,
    popupset: XULElement,
    params: { x: number; y: number; itemGroups: any[][] },
  ) {
    // Check if browser is still alive
    if (!readerRuntime.isBrowserAlive(browser)) return;

    const mainWindow = Zotero.getMainWindow();
    const { x, y, itemGroups } = params;

    const popup = mainWindow.document.createXULElement("menupopup");
    popupset.appendChild(popup);

    popup.addEventListener("popuphidden", function () {
      popup.remove();
    });

    const appendItems = (parentNode: Element, groups: any[][]) => {
      for (let i = 0; i < groups.length; i++) {
        const itemGroup = groups[i];
        for (const item of itemGroup) {
          if (item.groups) {
            // Submenu
            const menu = mainWindow.document.createXULElement("menu");
            menu.setAttribute("label", item.label);
            const menupopup = mainWindow.document.createXULElement("menupopup");
            menu.appendChild(menupopup);
            appendItems(menupopup, item.groups);
            parentNode.appendChild(menu);
          } else {
            // Menu item
            const menuitem = mainWindow.document.createXULElement("menuitem");
            menuitem.setAttribute("label", item.label);
            if (item.disabled) {
              menuitem.setAttribute("disabled", "true");
            }
            if (item.checked) {
              menuitem.setAttribute("type", "checkbox");
              menuitem.setAttribute("checked", "true");
            }
            menuitem.addEventListener("command", () => {
              if (item.onCommand) item.onCommand();
            });
            parentNode.appendChild(menuitem);
          }
        }
        // Add separator between groups (but not after the last group)
        if (i < groups.length - 1) {
          const separator =
            mainWindow.document.createXULElement("menuseparator");
          parentNode.appendChild(separator);
        }
      }
    };

    appendItems(popup, itemGroups);

    // Add Split View menu items - find which tab state owns this browser
    let ownerTabID: string | null = null;
    for (const [tid, s] of this.stateMap) {
      if (s.leftBrowser === browser || s.rightBrowser === browser) {
        ownerTabID = tid;
        break;
      }
    }
    const ownerState = ownerTabID ? this.stateMap.get(ownerTabID) : null;
    if (ownerState && ownerTabID) {
      const separator = mainWindow.document.createXULElement("menuseparator");
      popup.appendChild(separator);

      // Determine which side this browser is on
      const isLeft = browser === ownerState.leftBrowser;
      const currentSide = isLeft ? "left" : "right";
      const capturedTabID = ownerTabID;

      // Swap PDFs (exchange left and right PDFs)
      const swapItem = mainWindow.document.createXULElement("menuitem");
      swapItem.setAttribute("label", getString("splitview-swap-pdf"));
      this.setMenuItemIcon(swapItem, this.getIconURI("swap_horiz_24dp.svg"));
      swapItem.addEventListener("command", async () => {
        await this.swapPDFs(capturedTabID);
      });
      popup.appendChild(swapItem);

      const separateItem = mainWindow.document.createXULElement("menuitem");
      separateItem.setAttribute("label", getString("splitview-separate-views"));
      this.setMenuItemIcon(separateItem, this.getIconURI("separate_24dp.svg"));
      separateItem.addEventListener("command", () => {
        this.separateViews(capturedTabID, currentSide);
      });
      popup.appendChild(separateItem);

      // Close Split View (revert to single reader)
      const closeItem = mainWindow.document.createXULElement("menuitem");
      closeItem.setAttribute("label", this.getCloseViewMenuLabel());
      this.setMenuItemIcon(
        closeItem,
        this.getIconURI("do_not_splitscreen_vertical_24dp.svg"),
      );
      closeItem.addEventListener("command", () => {
        this.revertToSingleReader(capturedTabID, currentSide);
      });
      popup.appendChild(closeItem);

      // Set Primary (right below Split-View Reader)
      const primaryItem = mainWindow.document.createXULElement("menuitem");
      const primaryMenuConfig = this.getPrimaryMenuConfig(
        ownerState,
        currentSide,
      );
      primaryItem.setAttribute(
        "label",
        this.getSetPrimaryMenuLabel(primaryMenuConfig.menuState),
      );
      if (primaryMenuConfig.disabled) {
        primaryItem.setAttribute("disabled", "true");
      }
      this.setMenuItemIcon(
        primaryItem,
        this.getIconURI(
          primaryMenuConfig.isCurrentPrimary
            ? "primary_window_24dp.svg"
            : "standby_24dp.svg",
        ),
      );
      primaryItem.addEventListener("command", () => {
        const s = this.stateMap.get(capturedTabID);
        if (!s || s.isCleaningUp) return;
        const currentConfig = this.getPrimaryMenuConfig(s, currentSide);
        this.setPrimarySide(capturedTabID, currentConfig.targetPrimarySide);
      });
      popup.appendChild(primaryItem);

      // Replace the PDF on the side where the user right-clicked
      const openAnotherItem = mainWindow.document.createXULElement("menuitem");
      openAnotherItem.setAttribute("label", this.getOpenAnotherPDFMenuLabel());
      this.setMenuItemIcon(
        openAnotherItem,
        this.getIconURI("file_open_24dp.svg"),
      );
      openAnotherItem.addEventListener("command", async () => {
        await this.selectAndLoadPDF(capturedTabID, currentSide);
      });
      popup.appendChild(openAnotherItem);

      // Sync Position and Scale
      const syncPositionItem = mainWindow.document.createXULElement("menuitem");
      syncPositionItem.setAttribute(
        "label",
        this.getSyncPositionMenuLabel(currentSide),
      );
      this.setMenuItemIcon(syncPositionItem, this.getIconURI("sync_24dp.svg"));
      syncPositionItem.addEventListener("command", () => {
        this.syncPositionAndScale(capturedTabID, currentSide);
      });
      popup.appendChild(syncPositionItem);

      popup.addEventListener(
        "popupshown",
        () => {
          mainWindow.setTimeout(() => {
            const s = this.stateMap.get(capturedTabID);
            if (!s || s.isCleaningUp) return;
            this.activateSide(capturedTabID, currentSide, mainWindow);
            this.refreshPrimaryMenuItemElement(
              primaryItem,
              capturedTabID,
              currentSide,
            );
          }, 0);
        },
        { once: true },
      );
    }

    // Calculate screen position
    const browserRect = browser.getBoundingClientRect();
    const screenX = browserRect.left + x;
    const screenY = browserRect.top + y;

    // Convert to screen coordinates
    const windowUtils = (mainWindow as any).windowUtils;
    if (windowUtils && windowUtils.toScreenRectInCSSUnits) {
      const rect = windowUtils.toScreenRectInCSSUnits(screenX, screenY, 0, 0);
      setTimeout(() => (popup as any).openPopupAtScreen(rect.x, rect.y, true));
    } else {
      // Fallback
      setTimeout(() =>
        (popup as any).openPopupAtScreen(screenX, screenY, true),
      );
    }
  }

  /**
   * Hook into both readers' _annotationManager.render() to mirror annotation
   * changes instantly between the two views, replicating Zotero's native
   * split view behavior.
   *
   * In Zotero's native split view, both views share one _annotationManager.
   * When an annotation is created/modified/deleted:
   *   _applyChanges → render() → onRender → _updateState → view.setAnnotations()
   * This happens SYNCHRONOUSLY, so both views update immediately.
   *
   * In our plugin, each browser has its own reader with its own annotation
   * manager. We hook render() on each to propagate to the other:
   *   Left AM render() → update left view → copy annotations → right AM render() → update right view
   *
   * The DB save (onSaveAnnotations) is completely separate and fires later
   * via debounced _triggerSaving. We don't need to intercept it for UI sync.
   */
  private static setupAnnotationManagerSync(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || !state.isSamePDF) return;

    const leftReader = readerRuntime.getInternalReaderFromBrowser(
      state.leftBrowser,
    );
    const rightReader = readerRuntime.getInternalReaderFromBrowser(
      state.rightBrowser,
    );
    if (!leftReader || !rightReader) return;

    const leftAM = leftReader._annotationManager;
    const rightAM = rightReader._annotationManager;
    if (!leftAM || !rightAM) return;

    let isSyncing = false; // Guard against infinite recursion
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    // Capture original render functions (arrow functions, so `this` is bound to AM instance)
    const origLeftRender = leftAM.render;
    const origRightRender = rightAM.render;

    // When left annotation manager renders, mirror state to right
    leftAM.render = () => {
      origLeftRender();
      const s = self.stateMap.get(tabID);
      if (!isSyncing && s?.isSamePDF && !s.isCleaningUp) {
        isSyncing = true;
        try {
          // Deep-clone annotations across browser compartments via JSON
          const serialized = JSON.stringify(leftAM._annotations);
          const parsed = JSON.parse(serialized);
          // Clone into right browser's compartment for safe cross-compartment access
          const rightWin = s.rightBrowser.contentWindow;
          rightAM._annotations = rightWin
            ? Components.utils.cloneInto(parsed, rightWin, {
                wrapReflectors: true,
              })
            : parsed;
          origRightRender();
        } catch (e) {
          Zotero.debug(`Split view: annotation sync left→right error: ${e}`);
        } finally {
          isSyncing = false;
        }
      }
    };

    // When right annotation manager renders, mirror state to left
    rightAM.render = () => {
      origRightRender();
      const s = self.stateMap.get(tabID);
      if (!isSyncing && s?.isSamePDF && !s.isCleaningUp) {
        isSyncing = true;
        try {
          const serialized = JSON.stringify(rightAM._annotations);
          const parsed = JSON.parse(serialized);
          const leftWin = s.leftBrowser.contentWindow;
          leftAM._annotations = leftWin
            ? Components.utils.cloneInto(parsed, leftWin, {
                wrapReflectors: true,
              })
            : parsed;
          origLeftRender();
        } catch (e) {
          Zotero.debug(`Split view: annotation sync right→left error: ${e}`);
        } finally {
          isSyncing = false;
        }
      }
    };

    Zotero.debug("Split view: annotation manager sync hooks installed");
  }

  /**
   * Handle annotation save callback
   * Uses the same approach as Zotero's reader
   */
  private static async handleAnnotationSave(
    item: Zotero.Item,
    annotations: any[],
  ) {
    const attachment = Zotero.Items.get(item.id);
    if (!attachment) throw new Error(`Attachment ${item.id} is unavailable`);
    try {
      for (const annotation of annotations) {
        annotation.key = annotation.id;
        delete annotation.authorName;
        await Zotero.Annotations.saveFromJSON(attachment, annotation);
      }
    } catch {
      // Ignore annotation save errors
    }
  }

  /**
   * Handle annotation delete callback
   * Uses the same approach as Zotero's reader
   */
  private static async handleAnnotationDelete(
    item: Zotero.Item,
    ids: string[],
  ) {
    const attachment = Zotero.Items.get(item.id);
    if (!attachment) throw new Error(`Attachment ${item.id} is unavailable`);
    const libraryID = attachment.libraryID;
    try {
      for (const key of ids) {
        const annotation = Zotero.Items.getByLibraryAndKey(libraryID, key);
        if (
          annotation &&
          annotation.isAnnotation() &&
          annotation.parentID === item.id
        ) {
          await annotation.eraseTx();
        }
      }
    } catch {
      // Ignore annotation delete errors
    }
  }

  /**
   * Handle sidebar toggle - sync to the other reader when sync is enabled
   * Pauses scroll sync during sidebar animation to prevent position drift
   */
  private static handleSidebarToggle(
    tabID: string,
    sourceBrowser: XULBrowserElement,
    open: boolean,
  ) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;
    const primarySide = this.getEffectivePrimarySide(state);
    if (!primarySide) return;

    // Determine if this is the primary browser
    const isLeft = sourceBrowser === state.leftBrowser;
    const isPrimary =
      (isLeft && primarySide === "left") ||
      (!isLeft && primarySide === "right");

    // Only sync from primary to secondary
    if (!isPrimary) return;

    // Cancel any pending timers from previous toggle (debounce)
    const win = Zotero.getMainWindow();
    for (const timerId of state.sidebarToggleTimers) {
      win.clearTimeout(timerId);
    }
    state.sidebarToggleTimers = [];

    // Pause sync during sidebar toggle to prevent position drift
    state.syncPaused = true;

    // Get the secondary browser
    const secondaryBrowser = isLeft ? state.rightBrowser : state.leftBrowser;

    // Toggle sidebar on secondary reader
    try {
      const internalReader =
        readerRuntime.getInternalReaderFromBrowser(secondaryBrowser);
      if (
        internalReader &&
        typeof internalReader.toggleSidebar === "function"
      ) {
        internalReader.toggleSidebar(open);
      } else if (internalReader && internalReader._primaryView) {
        const primaryView = internalReader._primaryView;
        if (primaryView && typeof primaryView.setSidebarOpen === "function") {
          primaryView.setSidebarOpen(open);
        }
      }
    } catch {
      // Ignore errors
    }

    // Resume sync after sidebar animation completes and reinitialize position
    // Only set one timer - the final one that resumes sync
    const timerId = win.setTimeout(() => {
      const s = this.stateMap.get(tabID);
      if (!s) return;
      // Reinitialize sync state with current positions
      this.initSyncState(tabID);
      s.syncPaused = false;
      // Clear timer list
      s.sidebarToggleTimers = [];
    }, 200);

    state.sidebarToggleTimers.push(timerId);
  }

  /**
   * Revert split view to single reader
   * Called when user unchecks "Split-View Reader" in context menu
   * Keeps the focused reader and closes the other one
   * @param sideToClose Optional. If provided, closes this specific side. If not, keeps active side.
   */
  private static async separateViews(
    tabID: string,
    clickedSide: "left" | "right",
  ) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    state.isCleaningUp = true;

    const win = Zotero.getMainWindow();
    const Zotero_Tabs = (win as any).Zotero_Tabs;
    const { tabIndex } = Zotero_Tabs._getTab(tabID);

    const leftCurrentState =
      readerView.getCurrentViewStateFromBrowser(state.leftBrowser) ||
      state.leftViewState;
    const rightCurrentState =
      readerView.getCurrentViewStateFromBrowser(state.rightBrowser) ||
      state.rightViewState;

    try {
      if (state.isSamePDF) {
        const keepState =
          clickedSide === "left" ? leftCurrentState : rightCurrentState;
        await attachmentState.saveViewStateToDisk(state.leftItemID, keepState);
      } else {
        await Promise.all([
          attachmentState.saveViewStateToDisk(
            state.leftItemID,
            leftCurrentState,
          ),
          attachmentState.saveViewStateToDisk(
            state.rightItemID,
            rightCurrentState,
          ),
        ]);
      }
    } catch (e) {
      Zotero.debug(`Split view: separateViews save state failed: ${e}`);
    }

    await this.waitForSplitViewToSettle();

    const excludedTabIDs = new Set<string>([tabID]);
    const targets: SeparateViewTarget[] = state.isSamePDF
      ? [
          {
            itemID: state.leftItemID,
            tabID: this.findReusableReaderTabID(
              state.leftItemID,
              excludedTabIDs,
            ),
            viewState:
              clickedSide === "left" ? leftCurrentState : rightCurrentState,
            side: clickedSide,
          },
        ]
      : [
          {
            itemID: state.leftItemID,
            tabID: this.findReusableReaderTabID(
              state.leftItemID,
              excludedTabIDs,
            ),
            viewState: leftCurrentState,
            side: "left",
          },
          {
            itemID: state.rightItemID,
            tabID: this.findReusableReaderTabID(
              state.rightItemID,
              excludedTabIDs,
            ),
            viewState: rightCurrentState,
            side: "right",
          },
        ];

    const primaryTarget = state.isSamePDF
      ? targets[0]
      : targets.find((target) => target.side === clickedSide) || targets[0];
    const secondaryTargets = targets.filter(
      (target) => target !== primaryTarget,
    );

    const getFinalTargetIndex = (target: SeparateViewTarget) =>
      state.isSamePDF || target.side === "left" ? tabIndex : tabIndex + 1;

    // While the split tab is still open, any prepared replacement tab must be
    // inserted one slot to the right of its final destination.
    const getPreCloseTargetIndex = (target: SeparateViewTarget) =>
      getFinalTargetIndex(target) + 1;

    for (const target of targets) {
      await this.prepareSeparateViewTarget(
        target,
        getPreCloseTargetIndex(target),
        false,
        true,
      );
    }

    if (primaryTarget?.tabID) {
      Zotero_Tabs.select(primaryTarget.tabID);
    }

    this.cleanupTabResources(tabID);
    Zotero_Tabs.close(tabID);

    await this.waitForTabClosed(tabID);

    if (primaryTarget) {
      if (primaryTarget.tabID) {
        await this.restoreSeparateViewTarget(
          primaryTarget.tabID,
          primaryTarget.viewState,
        );
      } else {
        await this.prepareSeparateViewTarget(
          primaryTarget,
          getFinalTargetIndex(primaryTarget),
          true,
          false,
        );
      }
    }

    for (const target of secondaryTargets) {
      if (target.tabID) {
        await this.restoreSeparateViewTarget(target.tabID, target.viewState);
        continue;
      }
      await this.prepareSeparateViewTarget(
        target,
        getFinalTargetIndex(target),
        false,
        false,
      );
    }

    const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
    })
      .createLine({
        text: getString("splitview-closed"),
        type: "default",
        icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
      })
      .show();
    popup.startCloseTimer(2000);
  }

  /**
   * Revert split view to single reader
   * Called when user unchecks "Split-View Reader" in context menu
   * Keeps the focused reader and closes the other one
   * @param sideToClose Optional. If provided, closes this specific side. If not, keeps active side.
   */
  private static async revertToSingleReader(
    tabID: string,
    sideToClose?: "left" | "right",
  ) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    // Mark as cleaning up to prevent dead object errors
    state.isCleaningUp = true;

    const win = Zotero.getMainWindow();
    const Zotero_Tabs = (win as any).Zotero_Tabs;
    const { tabIndex } = Zotero_Tabs._getTab(tabID);

    // 1. Determine which reader to keep
    // If sideToClose is "left", we keep right. If "right", keep left.
    // If not specified, we keep the currently active side (default behavior).
    let keepLeft = state.activeSide === "left";
    if (sideToClose) {
      keepLeft = sideToClose === "right";
    }
    const keepItemID = keepLeft ? state.leftItemID : state.rightItemID;
    const closedItemID = keepLeft ? state.rightItemID : state.leftItemID;

    // 2. Save current view states to disk before closing
    let leftCurrentState: any = null;
    let rightCurrentState: any = null;
    try {
      // Get the most current state from browsers
      leftCurrentState = readerView.getCurrentViewStateFromBrowser(
        state.leftBrowser,
      );
      rightCurrentState = readerView.getCurrentViewStateFromBrowser(
        state.rightBrowser,
      );

      // Save both states
      await Promise.all([
        attachmentState.saveViewStateToDisk(
          state.leftItemID,
          leftCurrentState || state.leftViewState,
        ),
        attachmentState.saveViewStateToDisk(
          state.rightItemID,
          rightCurrentState || state.rightViewState,
        ),
      ]);
    } catch (e) {
      Zotero.debug("Split view: Error saving states: " + e);
    }

    await this.waitForSplitViewToSettle();

    // 3. Clean up split state (but don't close tab yet)
    this.cleanupTabResources(tabID);

    // 4. Close current tab and open the kept reader in a new tab
    // Prepare the kept reader first so closing the split tab doesn't trigger
    // Zotero to auto-select and load some unrelated unloaded reader tab.
    const keepTarget: SeparateViewTarget = {
      itemID: keepItemID,
      tabID: this.findReusableReaderTabID(keepItemID, new Set([tabID])),
      viewState: keepLeft
        ? leftCurrentState || state.leftViewState
        : rightCurrentState || state.rightViewState,
      side: keepLeft ? "left" : "right",
    };

    await this.prepareSeparateViewTarget(keepTarget, tabIndex + 1, false, true);

    if (keepTarget.tabID) {
      Zotero_Tabs.select(keepTarget.tabID);
    }

    // 4. Rewrite the closing tab as a normal reader for the side being closed,
    // then close the split tab after the kept reader is already ready.
    this.prepareTabDataForSingleReaderClose(tabID, closedItemID);
    Zotero_Tabs.close(tabID);

    await this.waitForTabClosed(tabID);

    if (keepTarget.tabID) {
      await this.restoreSeparateViewTarget(
        keepTarget.tabID,
        keepTarget.viewState,
      );
    } else {
      await this.prepareSeparateViewTarget(keepTarget, tabIndex, true, false);
    }

    const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
    })
      .createLine({
        text: getString("splitview-closed"),
        type: "default",
        icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
      })
      .show();
    popup.startCloseTimer(2000);
  }

  /**
   * Clean up split view state resources for a specific tab and remove from map.
   * Core cleanup logic shared by cleanupTab and cleanupTabResources.
   */
  private static cleanupTabResources(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    // Mark as cleaning up to prevent further operations
    state.isCleaningUp = true;

    const leftBrowser = state.leftBrowser;
    const rightBrowser = state.rightBrowser;

    // Stop active Read Aloud before unloading embedded readers.
    this.pauseReadAloudInBrowser(leftBrowser, true);
    this.pauseReadAloudInBrowser(rightBrowser, true);
    this.setSplitTabAudioStatus(tabID, { active: false, paused: false });

    // Unload browsers FIRST to prevent dead object errors from callbacks
    // This stops the internal readers from firing more callbacks
    readerRuntime.unloadBrowser(leftBrowser);
    readerRuntime.unloadBrowser(rightBrowser);

    // Store references before removing from map
    const eventListeners = [...state.eventListeners];
    const timeoutIds = [...state.timeoutIds];
    const toolbarCloseObservers = [...state.toolbarCloseObservers];
    const sidebarToggleTimers = [...state.sidebarToggleTimers];
    const resizeTimerId = state.resizeTimerId;
    const annotationNotifierID = state.annotationNotifierID;
    const contextPaneObserver = (state as any).contextPaneObserver;
    const dragOverlay = state.dragOverlay;

    // Clear state arrays first to prevent re-entry
    state.eventListeners = [];
    state.timeoutIds = [];
    state.toolbarCloseObservers = [];
    state.sidebarToggleTimers = [];
    state.leftViewerContainer = null;
    state.rightViewerContainer = null;
    state.resizeTimerId = null;
    state.annotationNotifierID = null;
    state.dragOverlay = null;
    (state as any).contextPaneObserver = null;

    // Stop sync polling before other cleanup
    this.stopSyncPolling(tabID);

    // Remove from map
    this.stateMap.delete(tabID);

    let win: Window | null = null;
    try {
      win = Zotero.getMainWindow();
    } catch (e) {
      Zotero.debug(`Split view: cleanup ${tabID} - getMainWindow failed: ${e}`);
    }

    // Remove split-view-active class only if no other split views are active for the current tab
    if (win) {
      try {
        const Zotero_Tabs = (win as any).Zotero_Tabs;
        const selectedTabID = Zotero_Tabs?.selectedID;
        if (!selectedTabID || !this.stateMap.has(selectedTabID)) {
          win.document.documentElement?.classList.remove("split-view-active");
        }
      } catch (e) {
        Zotero.debug(
          `Split view: cleanup ${tabID} - remove class failed: ${e}`,
        );
      }
    }

    // Remove all tracked event listeners
    for (const { target, type, listener, options } of eventListeners) {
      try {
        target.removeEventListener(type, listener, options);
      } catch (e) {
        Zotero.debug(
          `Split view: cleanup ${tabID} - removeEventListener(${type}) failed: ${e}`,
        );
      }
    }

    // Disconnect toolbar close button observers
    for (const { observer } of toolbarCloseObservers) {
      try {
        observer.disconnect();
      } catch (e) {
        Zotero.debug(
          `Split view: cleanup ${tabID} - toolbar observer disconnect failed: ${e}`,
        );
      }
    }

    // Remove resizer drag overlay if tab was closed during drag (restores cursor and clickability)
    if (dragOverlay && dragOverlay.parentNode) {
      try {
        dragOverlay.remove();
      } catch (e) {
        Zotero.debug(
          `Split view: cleanup ${tabID} - dragOverlay.remove failed: ${e}`,
        );
      }
    }

    // Clear all tracked timeouts
    if (win) {
      for (const id of timeoutIds) {
        try {
          win.clearTimeout(id);
        } catch (e) {
          Zotero.debug(
            `Split view: cleanup ${tabID} - clearTimeout failed: ${e}`,
          );
        }
      }

      // Clear sidebar toggle timers
      for (const timerId of sidebarToggleTimers) {
        try {
          win.clearTimeout(timerId);
        } catch (e) {
          Zotero.debug(
            `Split view: cleanup ${tabID} - clearTimeout(sidebar) failed: ${e}`,
          );
        }
      }

      // Clear resize debounce timer
      if (resizeTimerId !== null) {
        try {
          win.clearTimeout(resizeTimerId);
        } catch (e) {
          Zotero.debug(
            `Split view: cleanup ${tabID} - clearTimeout(resize) failed: ${e}`,
          );
        }
      }
    }

    // Unregister annotation sync notifier (same PDF split view)
    if (annotationNotifierID) {
      try {
        Zotero.Notifier.unregisterObserver(annotationNotifierID);
      } catch (e) {
        Zotero.debug(
          `Split view: cleanup ${tabID} - unregisterObserver(annotation) failed: ${e}`,
        );
      }
    }

    // Disconnect context pane observer
    if (contextPaneObserver) {
      try {
        contextPaneObserver.disconnect();
      } catch (e) {
        Zotero.debug(
          `Split view: cleanup ${tabID} - observer.disconnect failed: ${e}`,
        );
      }
    }

    // If no more split views, unregister global tab notifier
    if (this.stateMap.size === 0 && this.globalTabNotifierID) {
      try {
        Zotero.Notifier.unregisterObserver(this.globalTabNotifierID);
      } catch (e) {
        Zotero.debug(
          `Split view: cleanup - unregisterObserver(globalTab) failed: ${e}`,
        );
      }
      this.globalTabNotifierID = null;
    }
  }

  /**
   * Clean up a specific tab's split view (with state save)
   */
  private static cleanupTab(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    // Prevent re-entry and dead object access
    if (state.isCleaningUp) return;
    state.isCleaningUp = true;

    // Save view states to disk before cleanup (fire and forget)
    const leftItemID = state.leftItemID;
    const rightItemID = state.rightItemID;
    const leftViewState = state.leftViewState;
    const rightViewState = state.rightViewState;

    // Try to get current state from browsers (may fail if dead)
    let leftCurrentState: any = null;
    let rightCurrentState: any = null;
    try {
      leftCurrentState = readerView.getCurrentViewStateFromBrowser(
        state.leftBrowser,
      );
    } catch {
      // Browser may be dead
    }
    try {
      rightCurrentState = readerView.getCurrentViewStateFromBrowser(
        state.rightBrowser,
      );
    } catch {
      // Browser may be dead
    }

    // Save states asynchronously (don't await)
    Promise.all([
      attachmentState.saveViewStateToDisk(
        leftItemID,
        leftCurrentState || leftViewState,
      ),
      attachmentState.saveViewStateToDisk(
        rightItemID,
        rightCurrentState || rightViewState,
      ),
    ]).catch(() => {
      /* Ignore save errors */
    });

    // Reset isCleaningUp so cleanupTabResources can process it
    state.isCleaningUp = false;

    this.cleanupTabResources(tabID);
  }

  /**
   * Close split tab
   */
  private static closeSplitTab(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    // Cleanup state first
    this.cleanupTab(tabID);

    try {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = (win as any).Zotero_Tabs;
      Zotero_Tabs.close(tabID);
    } catch {
      // Ignore errors
    }

    const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
    })
      .createLine({
        text: getString("splitview-closed"),
        type: "default",
        icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
      })
      .show();
    popup.startCloseTimer(2000);
  }

  /**
   * Start sync polling
   * Uses requestAnimationFrame batching: the scroll event handler schedules
   * a rAF callback, so multiple scroll events within the same frame are
   * coalesced into a single DOM write. This reduces cross-compartment
   * overhead and prevents forced reflows during fast scrolling.
   */
  private static startSyncPolling(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;
    const primarySide = this.getEffectivePrimarySide(state);
    if (!primarySide) return;

    try {
      const primaryBrowser =
        primarySide === "left" ? state.leftBrowser : state.rightBrowser;

      const primaryContainer =
        readerView.getViewerContainerFromBrowser(primaryBrowser);
      if (!primaryContainer) return;

      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      const win = Zotero.getMainWindow();
      // Minimum interval between scroll syncs (ms) for throttling
      const SCROLL_SYNC_MIN_INTERVAL = 16; // ~60fps

      state.scrollHandler = () => {
        const s = self.stateMap.get(tabID);
        if (!s || s.isCleaningUp || s.scrollSyncRAFPending) return;

        // Time-based throttling: skip if last sync was too recent
        const now = Date.now();
        if (now - s.lastScrollSyncTime < SCROLL_SYNC_MIN_INTERVAL) return;

        s.scrollSyncRAFPending = true;
        win.requestAnimationFrame(() => {
          const s2 = self.stateMap.get(tabID);
          if (!s2 || s2.isCleaningUp) return;
          s2.scrollSyncRAFPending = false;
          s2.lastScrollSyncTime = Date.now();
          self.syncViews(tabID);
        });
      };
      primaryContainer.addEventListener("scroll", state.scrollHandler, {
        passive: true,
      });
      state.scrollHandlerBrowser = primaryBrowser;
    } catch (e) {
      Zotero.debug(
        `Split view: startSyncPolling error (browser may be dead): ${e}`,
      );
    }
  }

  /**
   * Stop sync polling
   */
  private static stopSyncPolling(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    // Remove scroll listener
    if (state.scrollHandler) {
      try {
        const primaryContainer = state.scrollHandlerBrowser
          ? readerView.getViewerContainerFromBrowser(state.scrollHandlerBrowser)
          : null;
        if (primaryContainer) {
          primaryContainer.removeEventListener("scroll", state.scrollHandler);
        }
      } catch {
        // Browser may be dead
      }
      state.scrollHandler = null;
      state.scrollHandlerBrowser = null;
    }
    // Cancel any pending rAF
    state.scrollSyncRAFPending = false;
  }

  private static SYNC_THRESHOLD = 1;

  /**
   * Sync scroll position between views.
   * Called once per animation frame (via rAF) to batch scroll events.
   * Uses cached viewer containers and delta-based scrolling for performance.
   */
  private static syncViews(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;
    const primarySide = this.getEffectivePrimarySide(state);
    if (!primarySide) return;
    if (!state.lastPrimaryScroll) return;
    if (state.syncPaused) return;
    if (state.ctrlPressed) return;
    if (state.zoomingCount > 0) return;

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

      // Read primary scroll position once
      const primaryTop = primaryContainer.scrollTop;
      const primaryLeft = primaryContainer.scrollLeft;

      const deltaTop = primaryTop - state.lastPrimaryScroll.top;
      const deltaLeft = primaryLeft - state.lastPrimaryScroll.left;

      if (
        Math.abs(deltaTop) >= this.SYNC_THRESHOLD ||
        Math.abs(deltaLeft) >= this.SYNC_THRESHOLD
      ) {
        // Single write: use scrollTo for atomic position update
        const newTop = Math.max(0, secondaryContainer.scrollTop + deltaTop);
        const newLeft = Math.max(0, secondaryContainer.scrollLeft + deltaLeft);
        secondaryContainer.scrollTo(newLeft, newTop);

        state.lastPrimaryScroll = {
          top: primaryTop,
          left: primaryLeft,
        };
      }
    } catch (e) {
      Zotero.debug(`Split view: syncViews error: ${e}`);
    }
  }

  /**
   * Call zoomIn on a browser's internal reader
   */
  private static zoomInForBrowser(browser: XULBrowserElement) {
    if (!readerRuntime.isBrowserAlive(browser)) return;
    try {
      const internalReader =
        readerRuntime.getInternalReaderFromBrowser(browser);
      if (internalReader && typeof internalReader.zoomIn === "function") {
        internalReader.zoomIn();
      }
    } catch (e) {
      Zotero.debug(`Split view: zoomInForBrowser error: ${e}`);
    }
  }

  /**
   * Call zoomOut on a browser's internal reader
   */
  private static zoomOutForBrowser(browser: XULBrowserElement) {
    if (!readerRuntime.isBrowserAlive(browser)) return;
    try {
      const internalReader =
        readerRuntime.getInternalReaderFromBrowser(browser);
      if (internalReader && typeof internalReader.zoomOut === "function") {
        internalReader.zoomOut();
      }
    } catch (e) {
      Zotero.debug(`Split view: zoomOutForBrowser error: ${e}`);
    }
  }

  /**
   * Call zoomReset on a browser's internal reader
   */
  private static zoomResetForBrowser(browser: XULBrowserElement) {
    if (!readerRuntime.isBrowserAlive(browser)) return;
    try {
      const internalReader =
        readerRuntime.getInternalReaderFromBrowser(browser);
      if (internalReader && typeof internalReader.zoomReset === "function") {
        internalReader.zoomReset();
      }
    } catch (e) {
      Zotero.debug(`Split view: zoomResetForBrowser error: ${e}`);
    }
  }

  /**
   * Inject a content-side event listener into the reader's iframe.
   * This allows us to call setContextPaneOpen() (which uses flushSync) from
   * within the content compartment, avoiding the cross-compartment issue.
   */
  private static injectContextPaneHandler(browser: XULBrowserElement) {
    try {
      const win = browser.contentWindow;
      if (!win) return;
      const wrappedWin = (win as any).wrappedJSObject || win;
      const doc = wrappedWin.document;
      if (!doc) return;

      const script = doc.createElement("script");
      script.textContent = `
        document.addEventListener('__splitview_context_pane', function(e) {
          if (window._reader && window._reader.setContextPaneOpen) {
            window._reader.setContextPaneOpen(e.detail.open);
          }
        });
      `;
      doc.head.appendChild(script);
      script.remove(); // Remove the script element; the listener persists
    } catch (e) {
      Zotero.debug(`Split view: injectContextPaneHandler error: ${e}`);
    }
  }

  /**
   * Inject CSS to change scrollbar color for a browser's PDF viewer.
   * Red scrollbar indicates the primary window, gray for secondary.
   */
  private static injectScrollbarCSS(
    browser: XULBrowserElement,
    isPrimary: boolean,
  ) {
    try {
      if (!browser || !browser.contentWindow) return;

      // Safety check for dead objects (prevents InvisibleToDebugger errors)
      if (
        Components.utils.isDeadWrapper(browser) ||
        Components.utils.isDeadWrapper(browser.contentWindow)
      ) {
        return;
      }

      const internalReader =
        readerRuntime.getInternalReaderFromBrowser(browser);
      if (!internalReader) return;

      const primaryView = internalReader._primaryView;
      if (!primaryView) return;

      const iframe = primaryView._iframe;
      if (!iframe || Components.utils.isDeadWrapper(iframe)) return;

      const iframeWin = iframe.contentWindow;
      if (!iframeWin || Components.utils.isDeadWrapper(iframeWin)) return;

      const wrappedWin = (iframeWin as any).wrappedJSObject || iframeWin;
      if (Components.utils.isDeadWrapper(wrappedWin)) return;

      const doc = wrappedWin.document;
      if (!doc || Components.utils.isDeadWrapper(doc)) return;

      const existingStyle = doc.getElementById("split-view-scrollbar-style");

      // If secondary: just ensure no custom scrollbar style exists
      if (!isPrimary) {
        if (existingStyle && !Components.utils.isDeadWrapper(existingStyle)) {
          existingStyle.remove();
        }
        return;
      }

      // Build the desired CSS content for primary window
      const r = getPref("primaryScrollbarR") ?? 255;
      const g = getPref("primaryScrollbarG") ?? 0;
      const b = getPref("primaryScrollbarB") ?? 0;
      const cssContent = `
        #viewerContainer {
          scrollbar-color: rgba(${r}, ${g}, ${b}, 0.6) #f0f0f0 !important;
        }
      `;

      // Skip injection if existing style already has identical content
      if (
        existingStyle &&
        !Components.utils.isDeadWrapper(existingStyle) &&
        existingStyle.textContent === cssContent
      ) {
        return;
      }

      // Remove outdated style if present
      if (existingStyle && !Components.utils.isDeadWrapper(existingStyle)) {
        existingStyle.remove();
      }

      // Create new style element for primary window
      const style = doc.createElement("style");
      style.id = "split-view-scrollbar-style";
      style.textContent = cssContent;

      if (doc.head && !Components.utils.isDeadWrapper(doc.head)) {
        doc.head.appendChild(style);
      } else if (
        doc.documentElement &&
        !Components.utils.isDeadWrapper(doc.documentElement)
      ) {
        doc.documentElement.appendChild(style);
      }
    } catch (e) {
      Zotero.debug(`Split view: injectScrollbarCSS error: ${e}`);
    }
  }

  /**
   * Update scrollbar colors for both browsers based on current primary side
   */
  private static updateScrollbarColors(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;
    const primarySide = this.getEffectivePrimarySide(state);

    try {
      // Only show a highlighted scrollbar while a primary view exists.
      this.injectScrollbarCSS(state.leftBrowser, primarySide === "left");
      this.injectScrollbarCSS(state.rightBrowser, primarySide === "right");
    } catch (e) {
      Zotero.debug(`Split view: updateScrollbarColors error: ${e}`);
    }
  }

  /**
   * Set contextPaneOpen state on a browser's internal reader.
   * This controls whether the toggle button shows in the toolbar.
   *
   * Dispatches a custom event to trigger the injected content-side listener,
   * which calls setContextPaneOpen() with React's flushSync() for a smooth,
   * synchronous transition (no flicker). Falls back to direct _updateState()
   * if the event handler is not available.
   */
  private static setContextPaneOpenForBrowser(
    browser: XULBrowserElement,
    open: boolean,
  ) {
    if (!readerRuntime.isBrowserAlive(browser)) return;
    try {
      const win = browser.contentWindow;
      if (!win) return;
      const wrappedWin = (win as any).wrappedJSObject || win;
      const doc = wrappedWin.document;
      if (!doc) return;

      // Dispatch event to the injected content-side handler which calls
      // setContextPaneOpen() with flushSync inside the correct compartment.
      // The ENTIRE eventInit object must be cloned into the content compartment,
      // otherwise the content-side CustomEvent constructor can't read the detail property.
      const eventInit = Components.utils.cloneInto({ detail: { open } }, win);
      doc.dispatchEvent(
        new wrappedWin.CustomEvent("__splitview_context_pane", eventInit),
      );
    } catch (e) {
      Zotero.debug(`Split view: setContextPaneOpenForBrowser error: ${e}`);
      // Fallback: direct _updateState (async, may cause brief flicker)
      try {
        const internalReader =
          readerRuntime.getInternalReaderFromBrowser(browser);
        const fallbackWin = browser.contentWindow;
        if (internalReader?._updateState && fallbackWin) {
          const stateUpdate = Components.utils.cloneInto(
            { contextPaneOpen: open },
            fallbackWin,
          );
          internalReader._updateState(stateUpdate);
        }
      } catch {
        // Ignore fallback errors
      }
    }
  }

  /**
   * Set up observer to watch context pane collapsed state changes
   * When context pane is toggled via sidenav, update right reader's toggle button visibility
   */
  private static setupContextPaneObserver(tabID: string, win: Window) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    try {
      const contextPane = win.document.getElementById("zotero-context-pane");
      if (!contextPane) return;

      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      const observer = new win.MutationObserver(
        (mutations: MutationRecord[]) => {
          for (const mutation of mutations) {
            if (
              mutation.type === "attributes" &&
              mutation.attributeName === "collapsed"
            ) {
              const isOpen = contextPane.getAttribute("collapsed") !== "true";
              const s = self.stateMap.get(tabID);
              if (s?.rightBrowser) {
                self.setContextPaneOpenForBrowser(s.rightBrowser, isOpen);
              }
            }
          }
        },
      );

      observer.observe(contextPane, {
        attributes: true,
        attributeFilter: ["collapsed"],
      });

      // Store observer for cleanup
      (state as any).contextPaneObserver = observer;
    } catch {
      // Ignore errors
    }
  }

  /**
   * Set up Ctrl key listener on a browser's iframe to detect Ctrl+wheel zoom
   * and Ctrl+Plus/Minus keyboard shortcuts for zoom sync
   */
  private static setupCtrlKeyListener(
    tabID: string,
    browser: XULBrowserElement,
  ) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    try {
      const internalReader =
        readerRuntime.getInternalReaderFromBrowser(browser);
      if (!internalReader) return;

      const primaryView = internalReader._primaryView;
      if (!primaryView) return;

      const iframe = primaryView._iframe;
      if (!iframe) return;

      const iframeWin = iframe.contentWindow;
      if (!iframeWin) return;

      const wrappedWin = (iframeWin as any).wrappedJSObject || iframeWin;
      const doc = wrappedWin.document;
      if (!doc) return;

      // Also get the reader.html window for keyboard events
      const readerWin = browser.contentWindow;
      const wrappedReaderWin = readerWin
        ? (readerWin as any).wrappedJSObject || readerWin
        : null;

      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;

      const keydownHandler = (e: KeyboardEvent) => {
        const s = self.stateMap.get(tabID);
        if (!s) return;

        if (e.key === "Control") {
          s.ctrlPressed = true;
          return;
        }

        // Note: Ctrl+Plus/Minus zoom sync is handled by setupMainWindowKeyboardListener
        // to avoid duplicate handling when events propagate through multiple layers
      };
      // Use capture phase to intercept before Zotero/PDF.js handlers
      // Listen on both PDF iframe doc and reader window for better coverage
      this.trackEventListener(
        state,
        doc,
        "keydown",
        keydownHandler as EventListener,
        true,
      );
      if (wrappedReaderWin && wrappedReaderWin.document) {
        this.trackEventListener(
          state,
          wrappedReaderWin.document,
          "keydown",
          keydownHandler as EventListener,
          true,
        );
      }

      const keyupHandler = (e: KeyboardEvent) => {
        const s = self.stateMap.get(tabID);
        if (e.key === "Control" && s) {
          s.ctrlPressed = false;
        }
      };
      this.trackEventListener(
        state,
        doc,
        "keyup",
        keyupHandler as EventListener,
      );

      const blurHandler = () => {
        const s = self.stateMap.get(tabID);
        if (s) {
          s.ctrlPressed = false;
        }
      };
      this.trackEventListener(
        state,
        wrappedWin,
        "blur",
        blurHandler as EventListener,
      );
    } catch {
      // Ignore errors
    }
  }

  /**
   * Handle keyboard zoom (Ctrl+Plus/Minus) - sync to secondary
   */
  private static handleKeyboardZoom(
    tabID: string,
    isLeft: boolean,
    direction: "in" | "out",
  ) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;
    const primarySide = this.getEffectivePrimarySide(state);
    if (!primarySide) return;

    const secondaryBrowser =
      primarySide === "left" ? state.rightBrowser : state.leftBrowser;

    // Pause scroll sync during zoom
    state.zoomingCount++;

    // Sync zoom action to secondary
    if (direction === "in") {
      this.zoomInForBrowser(secondaryBrowser);
    } else {
      this.zoomOutForBrowser(secondaryBrowser);
    }

    // Resume scroll sync after zoom completes
    this.trackTimeout(
      state,
      () => {
        const s = this.stateMap.get(tabID);
        if (s) {
          s.zoomingCount = Math.max(0, s.zoomingCount - 1);
          if (s.zoomingCount === 0) {
            this.initSyncState(tabID);
          }
        }
      },
      150,
    );
  }

  /**
   * Set up resize listener to pause scroll sync during window resize
   * This prevents false scroll sync when context pane expands/collapses
   */
  private static setupResizeListener(tabID: string, win: Window) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const resizeHandler = () => {
      const s = self.stateMap.get(tabID);
      if (!s) return;

      // Pause sync during resize
      s.syncPaused = true;

      // Clear any existing timer
      if (s.resizeTimerId !== null) {
        win.clearTimeout(s.resizeTimerId);
      }

      // Resume sync after resize settles and reinitialize sync state
      s.resizeTimerId = win.setTimeout(() => {
        const s2 = self.stateMap.get(tabID);
        if (s2) {
          // Reinitialize sync state with new positions after resize
          self.initSyncState(tabID);
          s2.syncPaused = false;
          s2.resizeTimerId = null;
        }
      }, 200);
    };

    this.trackEventListener(
      state,
      win,
      "resize",
      resizeHandler as EventListener,
    );
  }

  /**
   * Set up main window keyboard listener for Ctrl+=/- zoom sync
   * This catches keyboard events at the top level before they're consumed
   */
  private static setupMainWindowKeyboardListener(tabID: string, win: Window) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const keydownHandler = (e: KeyboardEvent) => {
      const s = self.stateMap.get(tabID);
      if (!s) return;
      if (!e.ctrlKey || e.altKey || e.metaKey) return;

      // Check if zoom key (support both Ctrl+=/- and Ctrl+Shift+=/-)
      // With Shift: key is "+" or "_"
      // Without Shift: key is "=" or "-"
      const isZoomIn =
        e.key === "+" ||
        e.key === "=" ||
        e.code === "Equal" ||
        e.code === "NumpadAdd";
      const isZoomOut =
        e.key === "-" ||
        e.key === "_" ||
        e.code === "Minus" ||
        e.code === "NumpadSubtract";

      if (!isZoomIn && !isZoomOut) return;

      // Determine which browser has focus to check if it's primary
      const activeElement = win.document.activeElement;
      const leftBrowserFocused =
        s.leftBrowser.contains(activeElement) ||
        s.leftBrowser === activeElement;
      const rightBrowserFocused =
        s.rightBrowser.contains(activeElement) ||
        s.rightBrowser === activeElement;

      // If neither browser is focused, use activeSide
      let isLeft: boolean;
      if (leftBrowserFocused) {
        isLeft = true;
      } else if (rightBrowserFocused) {
        isLeft = false;
      } else {
        isLeft = s.activeSide === "left";
      }

      const primarySide = self.getEffectivePrimarySide(s);
      if (!primarySide) return;
      const isPrimary =
        (isLeft && primarySide === "left") ||
        (!isLeft && primarySide === "right");
      if (!isPrimary) return;

      // Sync zoom to secondary
      if (isZoomIn) {
        self.handleKeyboardZoom(tabID, isLeft, "in");
      } else if (isZoomOut) {
        self.handleKeyboardZoom(tabID, isLeft, "out");
      }
    };

    // Use capture phase at main window level
    this.trackEventListener(
      state,
      win,
      "keydown",
      keydownHandler as EventListener,
      true,
    );
  }

  /**
   * Handle view state change (no-op, zoom sync is done via button listeners)
   */
  private static handleViewStateChange(
    _sourceBrowser: XULBrowserElement,
    _viewState: any,
  ) {
    // Zoom sync is handled by setupZoomButtonListeners for reliability
  }

  /**
   * Activate one side of the split view and run all related side effects.
   *
   * "Activation" is intentionally shared by click and focus interactions.
   * Context-menu opens also activate the side, but that activation is deferred
   * until after the menu is shown to avoid interfering with Zotero's own
   * synchronous reader event handlers.
   */
  private static activateSide(
    tabID: string,
    side: "left" | "right",
    win: Window,
  ) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;
    const shouldPromotePrimary =
      getPref("followFocusPrimary") &&
      state.primarySide !== null &&
      state.primarySide !== side;
    if (state.activeSide === side && !shouldPromotePrimary) return;

    state.activeSide = side;

    // Auto-switch primary when followFocusPrimary preference is enabled.
    // Directly set state to avoid notification popup from setPrimarySide().
    if (shouldPromotePrimary) {
      state.primarySide = side;
      this.stopSyncPolling(tabID);
      this.initSyncState(tabID);
      this.startSyncPolling(tabID);
    }

    // Update scrollbar colors to reflect active/primary side
    this.updateScrollbarColors(tabID);

    // Skip context pane update when both sides belong to the same Zotero item
    if (state.leftParentItemID === state.rightParentItemID) return;

    const parentItemID =
      side === "left" ? state.leftParentItemID : state.rightParentItemID;
    this.updateContextPane(tabID, win, parentItemID);
  }

  /**
   * Set up focus/click listeners for a single browser to handle context pane switching.
   * Reusable for both initial setup and secondary PDF replacement.
   * Includes all guard conditions to prevent redundant "Section item data changed" events.
   */
  private static setupBrowserFocusListeners(
    tabID: string,
    browser: XULBrowserElement,
    side: "left" | "right",
    win: Window,
  ) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    // IMPORTANT: Wrap handlers in setTimeout to run asynchronously.
    // Zotero's internal reader handlers (mouse events, etc.) may be running synchronously,
    // and accessing certain properties or layout immediately after can cause errors
    // like "Uncaught TypeError: can't access property 'rects', pointPosition is null".
    // By yielding to the event loop, we ensure Zotero's internal logic completes first.
    const scheduleActivation = () =>
      win.setTimeout(() => {
        self.activateSide(tabID, side, win);
      }, 0);
    const clickHandler = () => scheduleActivation();
    const focusHandler = () => scheduleActivation();
    this.trackEventListener(
      state,
      browser,
      "click",
      clickHandler as EventListener,
      true,
    );
    this.trackEventListener(
      state,
      browser,
      "focus",
      focusHandler as EventListener,
      true,
    );
  }

  /**
   * Set up focus listeners for context pane switching (both browsers).
   * Delegates to setupBrowserFocusListeners for each side.
   */
  private static setupFocusListeners(
    tabID: string,
    leftBrowser: XULBrowserElement,
    rightBrowser: XULBrowserElement,
    win: Window,
  ) {
    this.setupBrowserFocusListeners(tabID, leftBrowser, "left", win);
    this.setupBrowserFocusListeners(tabID, rightBrowser, "right", win);
  }

  /**
   * Update context pane to show the specified item
   * Based on Zotero's contextPane.js implementation
   */
  private static updateContextPane(
    tabID: string,
    win: Window,
    parentItemID: number,
  ) {
    try {
      const state = this.stateMap.get(tabID);
      if (!state || state.isCleaningUp) return;

      const document = win.document;
      const item = Zotero.Items.get(parentItemID);
      if (!item) return;

      const contextPaneElement = document.querySelector("context-pane") as any;
      if (!contextPaneElement) return;

      const itemPaneDeck = contextPaneElement._itemPaneDeck;
      if (!itemPaneDeck) return;

      let itemDetails = itemPaneDeck.querySelector(
        `[data-tab-id="${tabID}"]`,
      ) as any;

      if (itemDetails) {
        itemDetails.item = item;
        if (typeof itemDetails.render === "function") {
          itemDetails.render();
        }
      } else {
        itemDetails = document.createXULElement("item-details");
        itemDetails.id = tabID + "-context";
        itemDetails.dataset.tabId = tabID;
        itemDetails.className = "zotero-item-pane-content";
        itemPaneDeck.appendChild(itemDetails);

        // Set up the item-details properties
        const libraryID = item.libraryID;
        const library = Zotero.Libraries.get(libraryID);
        const editable = library && library.editable && !item.deleted;

        itemDetails.editable = editable;
        itemDetails.tabID = tabID;
        itemDetails.tabType = "reader"; // Use reader type for proper rendering
        itemDetails.item = item;

        if (contextPaneElement._sidenav) {
          itemDetails.sidenav = contextPaneElement._sidenav;
        }
      }

      itemPaneDeck.selectedPanel = itemDetails;
    } catch {
      // Ignore context pane errors
    }
  }

  /**
   * Ensure the global tab notifier is registered.
   * This is a single notifier shared across all split view tabs.
   * It handles CSS class toggling and tab close cleanup for all split views.
   */
  private static ensureGlobalTabNotifier(win: Window) {
    // Already registered
    if (this.globalTabNotifierID) return;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const notifierCallback = {
      notify: (
        action: string,
        type: string,
        ids: (string | number)[],
        _extraData: any,
      ) => {
        if (type !== "tab") return;

        if (action === "select") {
          const selectedTabID = String(ids[0]);
          const selectedState = self.stateMap.get(selectedTabID);

          if (selectedState && !selectedState.isCleaningUp) {
            // This tab has split view - activate CSS and context pane
            win.document.documentElement?.classList.add("split-view-active");
            self.showContextPaneForSplitView(win);
            // Update context pane content to show the active side's item
            const parentItemID = self.getActiveParentItemID(selectedState);
            self.updateContextPane(selectedTabID, win, parentItemID);
          } else {
            // This tab has no split view - remove CSS class
            win.document.documentElement?.classList.remove("split-view-active");
          }
        } else if (action === "close") {
          // Handle tab close - cleanup if this tab has split view
          const closedTabID = String(ids[0]);
          const closedState = self.stateMap.get(closedTabID);
          if (closedState && !closedState.isCleaningUp) {
            // Save states before cleanup
            const leftItemID = closedState.leftItemID;
            const rightItemID = closedState.rightItemID;
            const leftViewState = closedState.leftViewState;
            const rightViewState = closedState.rightViewState;

            // Try to get current state from browsers
            let leftCurrentState: any = null;
            let rightCurrentState: any = null;
            try {
              leftCurrentState = readerView.getCurrentViewStateFromBrowser(
                closedState.leftBrowser,
              );
            } catch {
              /* Browser may be dead */
            }
            try {
              rightCurrentState = readerView.getCurrentViewStateFromBrowser(
                closedState.rightBrowser,
              );
            } catch {
              /* Browser may be dead */
            }

            // Save states asynchronously
            Promise.all([
              attachmentState.saveViewStateToDisk(
                leftItemID,
                leftCurrentState || leftViewState,
              ),
              attachmentState.saveViewStateToDisk(
                rightItemID,
                rightCurrentState || rightViewState,
              ),
            ]).catch(() => {
              /* Ignore save errors */
            });

            self.cleanupTabResources(closedTabID);
          }
        }
      },
    };

    this.globalTabNotifierID = Zotero.Notifier.registerObserver(
      notifierCallback,
      ["tab"],
      "splitView",
      20,
    );
  }

  /**
   * Show context pane elements for our split view tab
   */
  private static showContextPaneForSplitView(win: Window) {
    const document = win.document;
    const ZoteroContextPane = (win as any).ZoteroContextPane;
    if (!ZoteroContextPane) return;

    const splitter = ZoteroContextPane.splitter;
    if (splitter) {
      splitter.setAttribute("hidden", "false");
    }

    const sidenav = ZoteroContextPane.sidenav;
    if (sidenav) {
      sidenav.hidden = false;
      sidenav.removeAttribute("hidden");
      sidenav.style.display = "";
      sidenav.style.visibility = "visible";
    }

    const sidenavById = document.getElementById(
      "zotero-context-pane-sidenav",
    ) as HTMLElement | null;
    if (sidenavById) {
      (sidenavById as any).hidden = false;
      sidenavById.removeAttribute("hidden");
    }

    const contextPaneBox = document.getElementById("zotero-context-pane");
    if (contextPaneBox) {
      contextPaneBox.removeAttribute("hidden");
    }

    this.injectSidenavCSS(document);
  }

  /**
   * Inject CSS to keep sidenav visible when context pane is collapsed
   * Only applies when split-view tab is active (body has .split-view-active class)
   */
  private static injectSidenavCSS(document: Document) {
    const styleId = "split-view-sidenav-style";
    if (document.getElementById(styleId)) {
      // CSS already injected, just ensure the active class is set
      document.documentElement?.classList.add("split-view-active");
      return;
    }

    const style = document.createElement("style");
    style.id = styleId;
    // Override XUL's collapsed behavior for context pane
    // Zotero uses display:flex for context pane, we need to maintain that
    // when collapsed to keep sidenav visible
    style.textContent = `
      /* Context pane layout - ONLY override when expanded (not collapsed).
       * When collapsed, we apply NO display override so XUL's native
       * collapsed="true" behavior works correctly (hides everything
       * including the sidenav). This matches native Zotero behavior:
       * collapsed → entire context pane + sidenav hidden, reader toggle shown. */
      :root.split-view-active #zotero-context-pane:not([collapsed="true"]) {
        display: flex !important;
        flex-direction: row !important;
        flex-grow: 0 !important;
        flex-shrink: 0 !important;
      }
      /* Force sidenav visible when context pane is expanded
       * (overrides the hidden="true" attribute that Zotero sets by default) */
      :root.split-view-active #zotero-context-pane:not([collapsed="true"]) #zotero-context-pane-sidenav {
        display: flex !important;
        flex-direction: column !important;
        visibility: visible !important;
        pointer-events: auto !important;
        width: 37px !important;
        min-width: 37px !important;
        flex-shrink: 0 !important;
      }
      :root.split-view-active #zotero-context-pane:not([collapsed="true"]) #zotero-context-pane-sidenav[hidden] {
        display: flex !important;
        visibility: visible !important;
      }
      /* Splitter - only show when context pane is expanded */
      :root.split-view-active #zotero-context-splitter[state="open"] {
        display: flex !important;
        visibility: visible !important;
      }
      /* Dragging cursor for resizer */
      body.split-view-dragging,
      body.split-view-dragging * {
        cursor: ew-resize !important;
        user-select: none !important;
      }
    `;
    const target = document.head || document.documentElement;
    if (target) {
      target.appendChild(style);
    }

    document.documentElement?.classList.add("split-view-active");
  }

  /**
   * Set up context pane for our split view tab
   * Note: Polling removed - tab notifier handles tab selection events
   */
  private static setupContextPane(tabID: string, win: Window) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    // Initialize immediately
    this.showContextPaneForSplitView(win);

    // Single delayed call to ensure async updates complete
    // (Replaced multiple 50ms/150ms/300ms calls with a single 300ms call)
    this.trackTimeout(state, () => this.showContextPaneForSplitView(win), 300);

    // Note: Polling interval removed - ensureGlobalTabNotifier() already handles
    // tab selection events and calls showContextPaneForSplitView() when needed
  }

  // NOTE: The old singleton cleanup() method has been replaced by:
  // - cleanupTab(tabID): saves state + cleans up resources for a specific tab
  // - cleanupTabResources(tabID): cleans up resources only (no state save)

  // === Library-mode split view (open from Shift+P without an active reader) ===

  /**
   * Open split view from the library / non-reader context.
   * Two-step flow: select first PDF → open it → select second PDF → split view.
   * If the user cancels the second selection, the first PDF stays open as a normal tab.
   */
  private static async openSplitViewFromLibrary() {
    // Step 1: select the first PDF (left side)
    const firstPDF = await this.pdfSelector.select(
      undefined,
      getString("splitview-select-first-pdf"),
    );
    if (!firstPDF) return;

    const win = Zotero.getMainWindow();
    const Zotero_Tabs = (win as any).Zotero_Tabs;

    // Check if this PDF is already open in an existing tab (including split view tabs)
    // This handles both normal tabs and split view tabs after Zotero restart
    let existingTabID: string | null = null;
    let isAlreadySplitView = false;

    if (Zotero_Tabs) {
      const tabs =
        typeof Zotero_Tabs.getTabs === "function"
          ? Zotero_Tabs.getTabs()
          : Zotero_Tabs._tabs || [];

      for (const tab of tabs) {
        // Check if tab contains this PDF as left side
        if (tab.data?.itemID === firstPDF.id) {
          existingTabID = tab.id;
          // Check if this tab is already a split view (has rightItemID)
          if (tab.data?.rightItemID) {
            isAlreadySplitView = true;
          }
          break;
        }
        // Also check split view data for right-side PDF
        if (tab.data?.rightItemID === firstPDF.id) {
          existingTabID = tab.id;
          isAlreadySplitView = true;
          break;
        }
      }
    }

    // If already in a split view tab, just switch to it and return
    if (existingTabID && isAlreadySplitView) {
      Zotero_Tabs.select(existingTabID);
      return;
    }

    let reader: _ZoteroTypes.ReaderInstance | null = null;

    if (existingTabID) {
      // Switch to existing tab first
      Zotero_Tabs.select(existingTabID);
      // Wait for tab switch and reader initialization
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Get the reader after switching
      reader = Zotero.Reader.getByTabID(existingTabID) || null;
      if (!reader) {
        // Tab might be unloaded, wait for it to load
        await new Promise((resolve) => setTimeout(resolve, 1000));
        reader = Zotero.Reader.getByTabID(existingTabID) || null;
      }
    }

    if (!reader) {
      // Open the first PDF in a new reader tab
      reader = (await Zotero.Reader.open(firstPDF.id)) || null;
    }

    if (!reader) return;

    // Check if this reader is already in split view mode (via stateMap)
    if (this.stateMap.has(reader.tabID)) {
      // Already in split view, no need to show second prompt
      return;
    }

    // Wait for the reader to fully initialise
    // For unloaded tabs, we need to wait longer and ensure the reader is ready
    await readerRuntime.waitForReaderReady(reader);

    // Step 2: select the second PDF (right side)
    const secondPDF = await this.pdfSelector.select(
      firstPDF.libraryID,
      getString("splitview-select-second-pdf"),
    );
    if (!secondPDF) return; // User cancelled – leave the single PDF open

    // Check if same PDF
    const isSamePDF = secondPDF.id === reader.itemID;

    if (isSamePDF) {
      await this.convertToSamePDFSplitView(reader);
    } else {
      await this.convertToSplitView(reader, secondPDF);
    }
  }
}
