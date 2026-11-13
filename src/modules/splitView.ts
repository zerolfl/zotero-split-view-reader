import { bindSplitAnnotations } from "./splitView/annotations";
import { SplitLayout } from "./splitView/layout";
import { SplitSync } from "./splitView/sync";
import { SplitReaderHost } from "./splitView/readerHost";
import { annotationStore } from "../platform/annotationStore";
import { reportAnnotationFailure } from "../platform/readerAnnotations";
import { SplitSession } from "./splitView/session";
import { TabHooks } from "../platform/tabHooks";
import { tabsForWindow } from "../platform/tabs";
import { attachmentState } from "../platform/attachmentState";
import { readerView } from "../platform/readerView";
import { readerRuntime } from "../platform/readerRuntime";
import { contextPane as splitContextPane } from "../platform/contextPane";
import { commandPalette } from "../ui/commandPalette";
import { PDFSelector } from "./pdfSelector";
import type { SeparateViewTarget, SplitTabState } from "./splitView/types";
import { SplitReadAloudService } from "./splitView/readAloud";
import { SplitReadAloudCoordinator } from "./splitView/readAloudCoordinator";
import { SplitTabTitleService } from "./splitView/tabTitles";
import { SplitTabContextMenu } from "../platform/tabContextMenu";
import { installCloseButton } from "../platform/readerToolbar";
import { readerScrollbar } from "../platform/readerScrollbar";
import { SplitReaderContextMenu } from "./splitView/readerContextMenu";
import { SplitLibraryFlow } from "./splitView/libraryFlow";
import { pauseNativeReaders } from "../platform/readAloud";
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { clearPref, getPref } from "../utils/prefs";

export class SplitViewFactory {
  /** Per-tab split view states. Each tab can independently have its own split view. */
  private static stateMap: Map<string, SplitTabState> = new Map();
  private static tabTitles = new SplitTabTitleService({
    getStates: () => this.stateMap.values(),
    getState: (id) => this.stateMap.get(id),
  });
  private static readAloudCoordinator = new SplitReadAloudCoordinator({
    states: () => this.stateMap.values(),
    getState: (id) => this.stateMap.get(id),
    getReader: (browser) => readerRuntime.getInternalReaderFromBrowser(browser),
    setAudioStatus: (id, status) => this.setSplitTabAudioStatus(id, status),
    pauseOtherReaders: pauseNativeReaders,
  });
  private static tabHooks = new TabHooks({
    hasSplit: (id) => this.hasActiveSplitState(id),
    findRightItem: (itemID) =>
      [...this.stateMap.values()].find(
        (state) => state.rightItemID === itemID && !state.isCleaningUp,
      )?.tabID || null,
    getTitle: (tab) => this.tabTitles.getTitleForTab(tab),
    toggleAudio: (id) => this.readAloudCoordinator.toggleActive(id),
    pauseSplitAudio: () => this.readAloudCoordinator.pauseAll(),
  });
  private static tabContextMenu = new SplitTabContextMenu({
    isActiveSplitView: (id) => this.hasActiveSplitState(id),
    showInLibrary: (id, win) => this.showInLibraryForActiveSide(id, win),
  });
  private static readerContextMenu = new SplitReaderContextMenu({
    isAlive: () => !!addon.data.alive,
    getState: (id) => this.stateMap.get(id) ?? null,
    getReaderSide: (id, reader) =>
      this.readAloudCoordinator.getReaderSide(id, reader as any),
    getPrimaryMenuConfig: (state, side) =>
      this.getPrimaryMenuConfig(state, side),
    getString: (key) => getString(key as Parameters<typeof getString>[0]),
    getCloseMenuLabel: () => this.getCloseViewMenuLabel(),
    getSetPrimaryMenuLabel: (menuState) =>
      this.getSetPrimaryMenuLabel(menuState),
    getIconURI: (name) => this.getIconURI(name),
    setMenuItemIcon: (item, uri) => this.setMenuItemIcon(item, uri),
    swapPDFs: (id) => this.swapPDFs(id),
    separateViews: (id, side) => void this.separateViews(id, side),
    handleSplitView: (reader) => void this.handleSplitView(reader),
    revertToSingleReader: (id, side) =>
      void this.revertToSingleReader(id, side),
    setPrimarySide: (id, side) => this.setPrimarySide(id, side),
    selectAndLoadPDF: (id, side) => this.selectAndLoadPDF(id, side),
    syncPositionAndScale: (id, side) =>
      this.sync.syncPositionAndScale(id, side),
    activateSide: (id, side, win) => this.activateSide(id, side, win),
    refreshPrimaryMenuItem: (item, id, side) =>
      this.refreshPrimaryMenuItemElement(item, id, side),
  });
  private static session = new SplitSession(
    (id, data) => this.restoreSplitViewFromSession(id, data),
    (id) => this.hasActiveSplitState(id),
  );
  private static layout = new SplitLayout(
    (id) => this.stateMap.get(id),
    (state) => this.session.write(state),
  );
  private static sync = new SplitSync({
    getState: (id) => this.stateMap.get(id),
    getEffectivePrimarySide: (state) => this.getEffectivePrimarySide(state),
    getMainWindow: () => Zotero.getMainWindow(),
    trackEventListener: (...args) => this.trackEventListener(...args),
    trackTimeout: (...args) => this.trackTimeout(...args),
    onPositionSynced: (side, result) => {
      const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
      })
        .createLine({
          text: result?.pageIndexClamped
            ? getString("splitview-last-page-reached", { args: { side } })
            : getString("splitview-position-synced"),
          type: "default",
          icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
        })
        .show();
      popup.startCloseTimer(2000);
    },
  });
  private static readerHost = new SplitReaderHost();
  private static pdfSelector = new PDFSelector();
  private static libraryFlow = new SplitLibraryFlow({
    selectPDF: (step, libraryID) =>
      this.pdfSelector.select(
        libraryID,
        getString(
          step === "first"
            ? "splitview-select-first-pdf"
            : "splitview-select-second-pdf",
        ),
      ),
    getTabs: () => {
      const win = Zotero.getMainWindow();
      return (win as any).Zotero_Tabs ? tabsForWindow(win) : null;
    },
    getReader: (tabID) => Zotero.Reader.getByTabID(tabID) || null,
    openReader: (itemID) => Zotero.Reader.open(itemID),
    wait: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    waitForReaderReady: (reader) => readerRuntime.waitForReaderReady(reader),
    hasSplitState: (tabID) => this.stateMap.has(tabID),
    splitSamePDF: (reader) => this.convertToSamePDFSplitView(reader),
    splitDifferentPDF: (reader, item) => this.convertToSplitView(reader, item),
  });
  private static readAloud = new SplitReadAloudService({
    states: () => this.stateMap.values(),
    getReader: (browser) => readerRuntime.getInternalReaderFromBrowser(browser),
    isActive: (browser) =>
      !!this.readAloudCoordinator.getActiveReaderInfoByBrowser(browser),
  });
  /** Global tab notifier ID - shared across all split view tabs */
  private static globalTabNotifierID: string | null = null;

  /** Preference observer IDs for scrollbar RGB - apply new color to open split view tabs */
  private static scrollbarPrefObserverIDs: (symbol | null)[] = [
    null,
    null,
    null,
  ];
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

  private static showInLibraryForActiveSide(tabID: string, win: Window): void {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    const itemID = this.getActiveItemID(state);
    const item = Zotero.Items.get(itemID);
    const targetItemID = item && item.parentItemID ? item.parentItemID : itemID;
    const pane = (win as any).ZoteroPane_Local || (win as any).ZoteroPane;
    if (typeof pane?.selectItem === "function") {
      void pane.selectItem(targetItemID);
    }
  }

  /**
   * Get the state for the currently selected Zotero tab (if it has split view)
   */
  private static getActiveTabState(): SplitTabState | null {
    try {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = tabsForWindow(win);
      const selectedTabID = Zotero_Tabs?.selectedID;
      if (selectedTabID) {
        return this.stateMap.get(selectedTabID) ?? null;
      }
    } catch {
      // Ignore errors
    }
    return null;
  }

  static refreshOpenSplitViewTabTitles(): void {
    this.tabTitles.refreshOpenTabs();
  }

  static registerSplitTabTitleItemNotifier() {
    this.tabTitles.registerItemNotifier();
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

  static registerContextMenu() {
    this.readerContextMenu.register(addon.data.config.addonID);
  }

  /**
   * Hook into Zotero_Tabs.getTabIDByItemID to support finding tabs by right-side itemID
   */
  static registerTabLookup(win: Window = Zotero.getMainWindow()) {
    this.tabHooks.register(win);
    this.tabContextMenu.register(win);
  }
  static registerSessionRestore() {
    this.session.register();
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

    this.tabTitles.registerPreferenceObserver(`${prefix}.splitTabsTitle`);

    this.readAloud.register();
  }

  /**
   * Register a named command in the Shift+P command palette.
   * Context-aware: in a reader tab it starts the split view flow immediately;
   * in the library or any other tab it enters the two-step PDF selection flow.
   */
  static registerPromptCommands(win: Window) {
    commandPalette.register(win, async () => {
      const tabs = tabsForWindow(win);
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
    this.readerContextMenu.unregister();
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

    this.session.unregister();

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
    this.tabTitles.unregister();
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
    this.tabHooks.unregister();
    this.tabContextMenu.unregister();
  }

  /**
   * Restore split view from saved session data
   */
  private static async restoreSplitViewFromSession(
    tabID: string,
    savedData: any,
  ) {
    const win = Zotero.getMainWindow();
    const Zotero_Tabs = tabsForWindow(win);

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
      await this.convertToSamePDFSplitView(reader, savedData);
    } else {
      // Restore different-PDF split view
      await this.convertToSplitView(reader, rightItem, savedData);
    }

    // Restore saved settings
    const state = this.stateMap.get(tabID);
    if (state) {
      // Restore split ratio
      if (typeof splitRatio === "number" && splitRatio > 0 && splitRatio < 1) {
        state.splitRatio = splitRatio;
        this.layout.updateBrowserFlex(
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
  private static updateTabDataForSession(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (state) this.session.write(state);
  }
  private static prepareTabDataForSingleReaderClose(
    tabID: string,
    itemID: number,
  ) {
    this.session.prepareClose(tabID, itemID);
  }

  private static setSplitTabAudioStatus(tabID: string, status: any): void {
    try {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = tabsForWindow(win);
      if (typeof Zotero_Tabs?.setAudioStatus === "function") {
        Zotero_Tabs.setAudioStatus(tabID, status);
      }
    } catch (e) {
      Zotero.debug(`Split view: setSplitTabAudioStatus failed: ${e}`);
    }
  }

  /**
   * Set which side is the primary (controller)
   */
  private static setPrimarySide(tabID: string, side: "left" | "right" | null) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    // Stop current sync before changing
    this.sync.stopSyncPolling(tabID);

    state.primarySide = side;
    state.lastPrimaryScroll = null;

    // Update scrollbar colors to reflect new primary side
    this.updateScrollbarColors(tabID);

    // Restart sync with new primary
    if (side) {
      this.sync.initSyncState(tabID);
      this.sync.startSyncPolling(tabID);
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
    state.disposeAnnotations?.();
    state.disposeAnnotations = undefined;

    // Close the old reader instance associated with this browser.
    // This removes it from Zotero.Reader._readers and prevents orphaned readers.
    const oldReader = readerRuntime.getReaderForBrowser(oldBrowser);
    if (oldReader) {
      await readerRuntime.closeReaderWithoutClosingTab(oldReader);
    }
    this.readAloudCoordinator.clearSide(state, side);

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
        this.sync.stopSyncPolling(tabID);
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
      this.sync.setupZoomButtonListeners(tabID, newBrowser);

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
        bindSplitAnnotations(state);
      }

      // Preserve the existing primary side when replacing a PDF in one view.
      // "Change PDF in This View" should not implicitly transfer primary control.
      this.updateScrollbarColors(tabID);

      // Update tab data
      this.updateTabDataForSession(tabID);

      await this.tabTitles.renameTab(tabID);

      // Restart sync if a primary view is active
      if (hadPrimary) {
        this.trackTimeout(
          state,
          () => {
            const s = this.stateMap.get(tabID);
            if (s && s.primarySide) {
              this.sync.cacheViewerContainers(tabID);
              this.sync.initSyncState(tabID);
              this.sync.startSyncPolling(tabID);
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
        this.sync.stopSyncPolling(tabID);
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
      this.sync.setupZoomButtonListeners(tabID, newLeftBrowser);
      this.sync.setupZoomButtonListeners(tabID, newRightBrowser);

      // 10. Update scrollbar colors to reflect new primary side
      this.updateScrollbarColors(tabID);

      // 11. Update context pane for the active side
      const activeParentItemID =
        state.activeSide === "left"
          ? state.leftParentItemID
          : state.rightParentItemID;
      splitContextPane.updateItem(tabID, win, activeParentItemID);

      // 12. Setup annotation sync if same PDF
      if (state.isSamePDF) {
        bindSplitAnnotations(state);
      }

      // 13. Update tab data and title
      this.updateTabDataForSession(tabID);
      await this.tabTitles.renameTab(tabID);

      // 14. Restart sync if a primary view is active
      if (hadPrimary) {
        this.trackTimeout(
          state,
          () => {
            const s = this.stateMap.get(tabID);
            if (s && s.primarySide) {
              this.sync.cacheViewerContainers(tabID);
              this.sync.initSyncState(tabID);
              this.sync.startSyncPolling(tabID);
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
    restored?: { leftViewState?: any; rightViewState?: any },
  ) {
    const win = Zotero.getMainWindow();
    const Zotero_Tabs = tabsForWindow(win);

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
      restored?.leftViewState ??
      (await readerView.getViewStateFromReader(currentReader));

    // 3. Get right PDF's stored state
    const rightViewState =
      restored?.rightViewState ??
      (await attachmentState.getStoredViewState(secondaryPDF));

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

    const leftBrowser = this.layout.createReaderBrowser(win);
    const rightBrowser = this.layout.createReaderBrowser(win);

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
        splitContextPane.setReaderOpen(s.rightBrowser, open);
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
      const { tab } = Zotero_Tabs.lookup(tabID);
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
      contextPaneObserver: null,
      leftViewerContainer: null,
      rightViewerContainer: null,
      splitRatio: 0.5,
      leftViewState: leftViewState,
      rightViewState: rightViewState,
      isCleaningUp: false,
      // Different PDF split view - no same PDF sync
      isSamePDF: false,
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
    this.layout.setupResizerDrag(
      tabID,
      resizer,
      leftBrowser,
      rightBrowser,
      mainHbox,
      win,
    );

    // Set initial flex values
    this.layout.updateBrowserFlex(
      leftBrowser,
      rightBrowser,
      newState.splitRatio,
    );

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
        splitContextPane.updateItem(tabID, win, curState.leftParentItemID);
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
          this.sync.setupZoomButtonListeners(tabID, leftBrowser);
          this.sync.setupZoomButtonListeners(tabID, rightBrowser);
          this.setupContextPaneObserver(tabID, win);
          if (s.primarySide) {
            this.sync.cacheViewerContainers(tabID);
            this.sync.initSyncState(tabID);
            this.sync.startSyncPolling(tabID);
          }
          // Apply scrollbar colors to indicate primary side
          this.updateScrollbarColors(tabID);
        },
        500,
      );

      // 10. Update tab data and title (include split view state for session restore)
      this.session.write(newState);
      await this.tabTitles.renameTab(tabID);
    } catch (e) {
      this.cleanupTab(tabID);
      throw e;
    }
  }

  /**
   * Convert current reader tab to split view with the same PDF
   * Both sides show the same PDF with annotation synchronization
   */
  private static async convertToSamePDFSplitView(
    currentReader: any,
    restored?: { leftViewState?: any; rightViewState?: any },
  ) {
    const win = Zotero.getMainWindow();
    const Zotero_Tabs = tabsForWindow(win);

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
      restored?.leftViewState ??
      (await readerView.getViewStateFromReader(currentReader));
    const rightViewState = restored?.rightViewState ?? leftViewState;

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

    const leftBrowser = this.layout.createReaderBrowser(win);
    const rightBrowser = this.layout.createReaderBrowser(win);

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
        splitContextPane.setReaderOpen(s.rightBrowser, open);
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
      const { tab } = Zotero_Tabs.lookup(tabID);
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
      contextPaneObserver: null,
      leftViewerContainer: null,
      rightViewerContainer: null,
      splitRatio: 0.5,
      leftViewState: leftViewState,
      rightViewState,
      isCleaningUp: false,
      // Same PDF split view specific
      isSamePDF: true,
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
    this.layout.setupResizerDrag(
      tabID,
      resizer,
      leftBrowser,
      rightBrowser,
      mainHbox,
      win,
    );

    // Set initial flex values
    this.layout.updateBrowserFlex(
      leftBrowser,
      rightBrowser,
      newState.splitRatio,
    );

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
          rightViewState,
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
        splitContextPane.updateItem(tabID, win, curState.leftParentItemID);
      }

      // Set up focus listeners
      this.setupFocusListeners(tabID, leftBrowser, rightBrowser, win);

      bindSplitAnnotations(newState);

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
          this.sync.setupZoomButtonListeners(tabID, leftBrowser);
          this.sync.setupZoomButtonListeners(tabID, rightBrowser);
          this.setupContextPaneObserver(tabID, win);
          if (s.primarySide) {
            this.sync.cacheViewerContainers(tabID);
            this.sync.initSyncState(tabID);
            this.sync.startSyncPolling(tabID);
          }
          // Apply scrollbar colors to indicate primary side
          this.updateScrollbarColors(tabID);
        },
        500,
      );

      // 9. Update tab data and title for session restore.
      this.session.write(newState);
      await this.tabTitles.renameTab(tabID);
    } catch (e) {
      this.cleanupTab(tabID);
      throw e;
    }
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
    await this.readerHost.initialize({
      browser,
      item,
      viewState,
      isRight,
      getReadAloudConfig: (ftl, onStatus) =>
        this.readAloud.getReaderConfig(browser, ftl, onStatus),
      callbacks: {
        onReadAloudStatus: (status) =>
          this.readAloudCoordinator.handleStatus(tabID, browser, status),
        openContextMenu: (params) =>
          this.openContextMenu(browser, popupset, params),
        toggleSidebar: (open) =>
          this.sync.handleSidebarToggle(tabID, browser, open),
        onViewStateChange: (viewState) => {
          const state = this.stateMap.get(tabID);
          if (
            !state ||
            state.isCleaningUp ||
            (browser !== state.leftBrowser && browser !== state.rightBrowser)
          )
            return;
          const isLeft = browser === state.leftBrowser;
          const stateCopy = JSON.parse(JSON.stringify(viewState));
          if (isLeft) state.leftViewState = stateCopy;
          else state.rightViewState = stateCopy;
          this.session.write(state);
          if (
            this.readAloudCoordinator.shouldSyncLastPosition(
              state,
              browser,
              viewState,
            )
          )
            attachmentState.syncLastReadAloudPositionToItem(item, viewState);
        },
        saveAnnotations: async (annotations, callback, readerWindow) => {
          try {
            await annotationStore.save(item.id, annotations, readerWindow);
          } catch (error) {
            reportAnnotationFailure(browser, error);
          } finally {
            callback?.();
          }
        },
        deleteAnnotations: (ids) => {
          void annotationStore
            .remove(item.id, ids)
            .catch((error) => reportAnnotationFailure(browser, error));
        },
        toggleContextPane: () => {
          const mainWindow = Zotero.getMainWindow();
          const contextPane = (mainWindow as any).ZoteroContextPane;
          if (!contextPane) return;
          contextPane.togglePane();
          setTimeout(() => {
            const state = this.stateMap.get(tabID);
            if (!state?.rightBrowser) return;
            const isOpen = !(
              (mainWindow as any).ZoteroContextPane?.collapsed ?? true
            );
            splitContextPane.setReaderOpen(state.rightBrowser, isOpen);
          }, 50);
        },
        afterReady: () => {
          this.installToolbarCloseButton(
            tabID,
            browser,
            isRight ? "right" : "left",
          );
          if (!isRight) splitContextPane.hideReaderSidenav(browser);
          else splitContextPane.injectReaderHandler(browser);
        },
      },
    });
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

    const observer = installCloseButton(browser, {
      side,
      label: this.getCloseViewMenuLabel(),
      isActive: () => this.hasActiveSplitState(tabID),
      onClose: () => void this.revertToSingleReader(tabID, side),
    });
    if (observer) state.toolbarCloseObservers.push({ side, observer });
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
      const Zotero_Tabs = tabsForWindow(win);
      const tabs = Zotero_Tabs.list();

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
      const Zotero_Tabs = tabsForWindow(win);
      const reader = Zotero.Reader.getByTabID(tabID);
      let tab: any;
      try {
        tab = Zotero_Tabs.lookup(tabID)?.tab || null;
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
    const Zotero_Tabs = tabsForWindow(win);

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
      ({ tab } = Zotero_Tabs.lookup(target.tabID));
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
      refreshedTab = Zotero_Tabs.lookup(existingTabID).tab || tab;
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
        this.sync.syncPositionAndScale(capturedTabID, currentSide);
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
    const Zotero_Tabs = tabsForWindow(win);
    const { tabIndex } = Zotero_Tabs.lookup(tabID);

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
    const Zotero_Tabs = tabsForWindow(win);
    const { tabIndex } = Zotero_Tabs.lookup(tabID);

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
    state.disposeAnnotations?.();
    state.disposeAnnotations = undefined;

    // Stop active Read Aloud before unloading embedded readers.
    this.readAloudCoordinator.pauseBrowser(leftBrowser, true);
    this.readAloudCoordinator.pauseBrowser(rightBrowser, true);
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
    const contextPaneObserver = state.contextPaneObserver;
    const dragOverlay = state.dragOverlay;

    // Clear state arrays first to prevent re-entry
    state.eventListeners = [];
    state.timeoutIds = [];
    state.toolbarCloseObservers = [];
    state.sidebarToggleTimers = [];
    state.leftViewerContainer = null;
    state.rightViewerContainer = null;
    state.resizeTimerId = null;
    state.dragOverlay = null;
    state.contextPaneObserver = null;

    // Stop sync polling before other cleanup
    this.sync.stopSyncPolling(tabID);

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
        const Zotero_Tabs = tabsForWindow(win);
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

    // Disconnect context pane observer
    splitContextPane.disconnectObserver(contextPaneObserver);

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
      const Zotero_Tabs = tabsForWindow(win);
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
   * Inject CSS to change scrollbar color for a browser's PDF viewer.
   * Red scrollbar indicates the primary window, gray for secondary.
   */
  /**
   * Update scrollbar colors for both browsers based on current primary side
   */
  private static updateScrollbarColors(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;
    const primarySide = this.getEffectivePrimarySide(state);

    try {
      // Only show a highlighted scrollbar while a primary view exists.
      const color = primarySide
        ? {
            red: getPref("primaryScrollbarR") ?? 255,
            green: getPref("primaryScrollbarG") ?? 0,
            blue: getPref("primaryScrollbarB") ?? 0,
          }
        : null;
      readerScrollbar.setPrimaryColor(
        state.leftBrowser,
        primarySide === "left" ? color : null,
      );
      readerScrollbar.setPrimaryColor(
        state.rightBrowser,
        primarySide === "right" ? color : null,
      );
    } catch (e) {
      Zotero.debug(`Split view: updateScrollbarColors error: ${e}`);
    }
  }

  /**
   * Set up observer to watch context pane collapsed state changes
   * When context pane is toggled via sidenav, update right reader's toggle button visibility
   */
  private static setupContextPaneObserver(tabID: string, win: Window) {
    const state = this.stateMap.get(tabID);
    if (!state) return;
    splitContextPane.disconnectObserver(state.contextPaneObserver);
    state.contextPaneObserver = splitContextPane.observeCollapsed(
      win,
      (isOpen) => {
        const currentState = this.stateMap.get(tabID);
        if (currentState?.rightBrowser) {
          splitContextPane.setReaderOpen(currentState.rightBrowser, isOpen);
        }
      },
    );
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
          self.sync.initSyncState(tabID);
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
          self.sync.initSyncState(tabID);
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
          self.sync.initSyncState(tabID);
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
        self.sync.handleKeyboardZoom(tabID, isLeft, "in");
      } else if (isZoomOut) {
        self.sync.handleKeyboardZoom(tabID, isLeft, "out");
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
      this.sync.stopSyncPolling(tabID);
      this.sync.initSyncState(tabID);
      this.sync.startSyncPolling(tabID);
    }

    // Update scrollbar colors to reflect active/primary side
    this.updateScrollbarColors(tabID);

    // Skip context pane update when both sides belong to the same Zotero item
    if (state.leftParentItemID === state.rightParentItemID) return;

    const parentItemID =
      side === "left" ? state.leftParentItemID : state.rightParentItemID;
    splitContextPane.updateItem(tabID, win, parentItemID);
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
            splitContextPane.showForSplitView(win);
            // Update context pane content to show the active side's item
            const parentItemID = self.getActiveParentItemID(selectedState);
            splitContextPane.updateItem(selectedTabID, win, parentItemID);
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
   * Set up context pane for our split view tab
   * Note: Polling removed - tab notifier handles tab selection events
   */
  private static setupContextPane(tabID: string, win: Window) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    // Initialize immediately
    splitContextPane.showForSplitView(win);

    // Single delayed call to ensure async updates complete
    // (Replaced multiple 50ms/150ms/300ms calls with a single 300ms call)
    this.trackTimeout(state, () => splitContextPane.showForSplitView(win), 300);

    // Note: Polling interval removed - ensureGlobalTabNotifier() already handles
    // tab selection events and calls showForSplitView() when needed
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
    await this.libraryFlow.open();
  }
}
