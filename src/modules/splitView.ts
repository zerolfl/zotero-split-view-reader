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
import type { SplitTabState } from "./splitView/types";
import { SplitReadAloudService } from "./splitView/readAloud";
import { SplitReadAloudCoordinator } from "./splitView/readAloudCoordinator";
import { SplitTabTitleService } from "./splitView/tabTitles";
import { SplitTabContextMenu } from "../platform/tabContextMenu";
import { installCloseButton } from "../platform/readerToolbar";
import { readerScrollbar } from "../platform/readerScrollbar";
import { SplitReaderContextMenu } from "./splitView/readerContextMenu";
import { SplitLibraryFlow } from "./splitView/libraryFlow";
import { SeparateViewTargets } from "./splitView/separateViewTargets";
import { SplitViewLifecycle } from "./splitView/lifecycle";
import { PDFSwapService } from "./splitView/pdfSwap";
import { PDFReplacementService } from "./splitView/pdfReplacement";
import { SplitReaderBrowserAdapter } from "../platform/splitReaderBrowser";
import { SplitReaderTabAdapter } from "../platform/splitReaderTab";
import { pauseNativeReaders } from "../platform/readAloud";
import { SplitInteractions } from "./splitView/interactions";
import { SplitViewCreationService } from "./splitView/creation";
import { SplitTabNotifier } from "./splitView/tabNotifier";
import { SplitPrimaryView } from "./splitView/primaryView";
import { SplitReaderPopupMenu } from "./splitView/readerPopupMenu";
import { SplitTabCleanup } from "./splitView/tabCleanup";
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { clearPref, getPref } from "../utils/prefs";

export class SplitViewFactory {
  /** Per-tab split view states. Each tab can independently have its own split view. */
  private static stateMap: Map<string, SplitTabState> = new Map();
  private static tabNotifier = new SplitTabNotifier({
    getState: (tabID) => this.stateMap.get(tabID) || null,
    getActiveParentItemID: (state) => this.getActiveParentItemID(state),
    showForSplitView: (win) => splitContextPane.showForSplitView(win),
    updateContextPane: (tabID, win, itemID) =>
      splitContextPane.updateItem(tabID, win, itemID),
    captureViewState: (browser) =>
      readerView.getCurrentViewStateFromBrowser(browser),
    saveViewState: (itemID, viewState) =>
      attachmentState.saveViewStateToDisk(itemID, viewState),
    cleanupResources: (tabID) => this.cleanupTabResources(tabID),
    registerNotifier: (callback) =>
      Zotero.Notifier.registerObserver(callback, ["tab"], "splitView", 20),
    unregisterNotifier: (id) => Zotero.Notifier.unregisterObserver(id),
    debug: (message) => Zotero.debug(message),
  });
  private static tabCleanup = new SplitTabCleanup({
    getState: (tabID) => this.stateMap.get(tabID) || null,
    removeState: (tabID) => this.stateMap.delete(tabID),
    hasState: (tabID) => this.stateMap.has(tabID),
    hasAnyState: () => this.stateMap.size > 0,
    pauseReader: (browser) =>
      this.readAloudCoordinator.pauseBrowser(browser, true),
    setAudioStatus: (tabID) =>
      this.setSplitTabAudioStatus(tabID, { active: false, paused: false }),
    unloadBrowser: (browser) => readerRuntime.unloadBrowser(browser),
    stopSyncPolling: (tabID) => this.sync.stopSyncPolling(tabID),
    getMainWindow: () => Zotero.getMainWindow(),
    getSelectedTabID: (win) => tabsForWindow(win)?.selectedID || null,
    disconnectContextPaneObserver: (observer) =>
      splitContextPane.disconnectObserver(observer),
    unregisterTabNotifier: () => this.tabNotifier.unregister(),
    debug: (message) => Zotero.debug(message),
  });
  private static separateTargets = new SeparateViewTargets({
    getTabs: () => tabsForWindow(Zotero.getMainWindow()),
    getReader: (tabID) => Zotero.Reader.getByTabID(tabID),
    openReader: (itemID, options) =>
      Zotero.Reader.open(itemID, undefined, options),
    waitForReaderReady: (reader, maxWaitMs) =>
      readerRuntime.waitForReaderReady(reader, maxWaitMs),
    applyViewState: (reader, viewState) =>
      readerView.applyViewStateToReader(reader, viewState),
    delay: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    debug: (message) => Zotero.debug(message),
  });
  private static lifecycle = new SplitViewLifecycle({
    getState: (tabID) => this.stateMap.get(tabID) || null,
    getTabs: () => tabsForWindow(Zotero.getMainWindow()),
    targets: this.separateTargets,
    captureViewState: (browser) =>
      readerView.getCurrentViewStateFromBrowser(browser),
    saveViewState: (itemID, viewState) =>
      attachmentState.saveViewStateToDisk(itemID, viewState),
    cleanup: (tabID) => this.cleanupTabResources(tabID),
    prepareSingleReaderClose: (tabID, itemID) =>
      this.prepareTabDataForSingleReaderClose(tabID, itemID),
    showClosed: () => this.showSplitViewClosedMessage(),
    debug: (message) => Zotero.debug(message),
  });
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
  private static readerBrowser = new SplitReaderBrowserAdapter({
    getState: (tabID) => this.stateMap.get(tabID) || null,
    getReaderForBrowser: (browser) =>
      readerRuntime.getReaderForBrowser(browser),
    closeReader: (reader) => readerRuntime.closeReaderWithoutClosingTab(reader),
    clearReadAloudSide: (state, side) =>
      this.readAloudCoordinator.clearSide(state as SplitTabState, side),
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
      this.primaryView.getMenuConfig(state, side),
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
    setPrimarySide: (id, side) => this.primaryView.setSide(id, side),
    selectAndLoadPDF: (id, side) => this.selectAndLoadPDF(id, side),
    syncPositionAndScale: (id, side) =>
      this.sync.syncPositionAndScale(id, side),
    activateSide: (id, side, win) =>
      this.interactions.activateSide(id, side, win),
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
  private static splitReaderTab = new SplitReaderTabAdapter({
    getState: (tabID) => this.stateMap.get(tabID) || null,
    getInternalReader: (browser) =>
      readerRuntime.getInternalReaderFromBrowser(browser),
    setContextPaneOpen: (browser, open) =>
      splitContextPane.setReaderOpen(browser, open),
  });
  private static sync = new SplitSync({
    getState: (id) => this.stateMap.get(id),
    getEffectivePrimarySide: (state) =>
      this.primaryView.getEffectiveSide(state),
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
  private static interactions = new SplitInteractions({
    getState: (tabID) => this.stateMap.get(tabID),
    getEffectivePrimarySide: (state) =>
      this.primaryView.getEffectiveSide(state),
    sync: this.sync,
    trackEventListener: (...args) => this.trackEventListener(...args),
    updateScrollbarColors: (tabID) => this.updateScrollbarColors(tabID),
  });
  private static primaryView = new SplitPrimaryView({
    getState: (tabID) => this.stateMap.get(tabID) || null,
    stopSyncPolling: (tabID) => this.sync.stopSyncPolling(tabID),
    updateScrollbarColors: (tabID) => this.updateScrollbarColors(tabID),
    initSyncState: (tabID) => this.sync.initSyncState(tabID),
    startSyncPolling: (tabID) => this.sync.startSyncPolling(tabID),
    updateSession: (tabID) => this.updateTabDataForSession(tabID),
  });
  private static readerHost = new SplitReaderHost();
  private static creation = new SplitViewCreationService({
    getDefaultPrimarySide: () => this.primaryView.getDefaultSide(),
    getOriginalTitle: (tabID) => {
      try {
        return tabsForWindow(Zotero.getMainWindow()).lookup(tabID).tab?.title;
      } catch {
        return undefined;
      }
    },
    setState: (tabID, state) => this.stateMap.set(tabID, state),
    setupShell: (tabID, state, shell, win) => {
      this.layout.setupResizerDrag(
        tabID,
        shell.resizer,
        shell.leftBrowser,
        shell.rightBrowser,
        shell.mainHbox,
        win,
      );
      this.layout.updateBrowserFlex(
        shell.leftBrowser,
        shell.rightBrowser,
        state.splitRatio,
      );
      this.tabNotifier.ensureRegistered(win);
      this.setupContextPane(tabID, win);
    },
    initializeReader: (...args) => this.initializeReader(...args),
    showLoaded: (isSamePDF) => this.showCreatedSplitViewMessage(isSamePDF),
    updateContextPane: (tabID, win, itemID) =>
      splitContextPane.updateItem(tabID, win, itemID),
    setupFocusListeners: (...args) =>
      this.interactions.setupFocusListeners(...args),
    bindAnnotations: (state) => bindSplitAnnotations(state),
    scheduleDelayedSetup: (tabID, state, win, leftBrowser, rightBrowser) =>
      this.trackTimeout(
        state,
        () => {
          const current = this.stateMap.get(tabID);
          if (!current) return;
          this.interactions.setupResizeListener(tabID, win);
          this.interactions.setupCtrlKeyListener(tabID, leftBrowser);
          this.interactions.setupCtrlKeyListener(tabID, rightBrowser);
          this.interactions.setupMainWindowKeyboardListener(tabID, win);
          this.sync.setupZoomButtonListeners(tabID, leftBrowser);
          this.sync.setupZoomButtonListeners(tabID, rightBrowser);
          this.interactions.setupContextPaneObserver(tabID, win);
          if (current.primarySide) {
            this.sync.cacheViewerContainers(tabID);
            this.sync.initSyncState(tabID);
            this.sync.startSyncPolling(tabID);
          }
          this.updateScrollbarColors(tabID);
        },
        500,
      ),
    writeSession: (state) => this.session.write(state),
    renameTab: (tabID) => this.tabTitles.renameTab(tabID),
    cleanup: (tabID) => this.cleanupTab(tabID),
  });
  private static readerPopupMenu = new SplitReaderPopupMenu({
    isBrowserAlive: (browser) => readerRuntime.isBrowserAlive(browser),
    getMainWindow: () => Zotero.getMainWindow(),
    getStates: () => this.stateMap.entries(),
    getState: (tabID) => this.stateMap.get(tabID) || null,
    getString: (key, options) =>
      options
        ? getString(key as Parameters<typeof getString>[0], options as any)
        : getString(key as Parameters<typeof getString>[0]),
    getIconURI: (name) => this.getIconURI(name),
    setMenuItemIcon: (item, uri) => this.setMenuItemIcon(item, uri),
    getCloseViewMenuLabel: () => this.getCloseViewMenuLabel(),
    getOpenAnotherPDFMenuLabel: () => this.getOpenAnotherPDFMenuLabel(),
    getSyncPositionMenuLabel: (side) => this.getSyncPositionMenuLabel(side),
    getSetPrimaryMenuLabel: (state) => this.getSetPrimaryMenuLabel(state),
    getPrimaryMenuConfig: (state, side) =>
      this.primaryView.getMenuConfig(state, side),
    swapPDFs: (tabID) => this.swapPDFs(tabID),
    separateViews: (tabID, side) => void this.separateViews(tabID, side),
    closeSide: (tabID, side) => void this.revertToSingleReader(tabID, side),
    setPrimarySide: (tabID, side) => this.primaryView.setSide(tabID, side),
    selectAndLoadPDF: (tabID, side) => this.selectAndLoadPDF(tabID, side),
    syncPositionAndScale: (tabID, side) =>
      this.sync.syncPositionAndScale(tabID, side),
    activateSide: (tabID, side, win) =>
      this.interactions.activateSide(tabID, side, win),
    refreshPrimaryMenuItem: (item, tabID, side) =>
      this.refreshPrimaryMenuItemElement(item, tabID, side),
    schedule: (callback) => setTimeout(callback),
  });
  private static pdfSwap = new PDFSwapService({
    getState: (tabID) => this.stateMap.get(tabID) || null,
    captureViewState: (browser) =>
      readerView.getCurrentViewStateFromBrowser(browser),
    replaceBrowser: (tabID, side) => this.readerBrowser.replace(tabID, side),
    getItem: (itemID) => Zotero.Items.get(itemID) || undefined,
    getMainWindow: () => Zotero.getMainWindow(),
    initializeReader: (...args) => this.initializeReader(...args),
    setupFocusListeners: (...args) =>
      this.interactions.setupFocusListeners(...args),
    setupCtrlKeyListener: (...args) =>
      this.interactions.setupCtrlKeyListener(...args),
    setupZoomButtonListeners: (tabID, browser) =>
      this.sync.setupZoomButtonListeners(tabID, browser),
    stopSyncPolling: (tabID) => this.sync.stopSyncPolling(tabID),
    updateScrollbarColors: (tabID) => this.updateScrollbarColors(tabID),
    updateContextPane: (tabID, win, itemID) =>
      splitContextPane.updateItem(tabID, win, itemID),
    bindAnnotations: (state) => bindSplitAnnotations(state),
    updateSession: (tabID) => this.updateTabDataForSession(tabID),
    renameTab: (tabID) => this.tabTitles.renameTab(tabID),
    scheduleSyncRestart: (tabID, state) =>
      this.scheduleSyncRestart(tabID, state),
    showSwapped: () => this.showSplitViewSwappedMessage(),
    debug: (message) => Zotero.debug(message),
  });
  private static pdfReplacement = new PDFReplacementService({
    getState: (tabID) => this.stateMap.get(tabID) || null,
    getItem: (itemID) => Zotero.Items.get(itemID) || undefined,
    selectPDF: (libraryID) => this.pdfSelector.select(libraryID),
    getStoredViewState: (item) => attachmentState.getStoredViewState(item),
    replaceBrowser: (tabID, side) => this.readerBrowser.replace(tabID, side),
    getMainWindow: () => Zotero.getMainWindow(),
    initializeReader: (...args) => this.initializeReader(...args),
    setupBrowserFocusListeners: (...args) =>
      this.interactions.setupBrowserFocusListeners(...args),
    setupCtrlKeyListener: (...args) =>
      this.interactions.setupCtrlKeyListener(...args),
    setupZoomButtonListeners: (tabID, browser) =>
      this.sync.setupZoomButtonListeners(tabID, browser),
    stopSyncPolling: (tabID) => this.sync.stopSyncPolling(tabID),
    updateScrollbarColors: (tabID) => this.updateScrollbarColors(tabID),
    bindAnnotations: (state) => bindSplitAnnotations(state),
    updateSession: (tabID) => this.updateTabDataForSession(tabID),
    renameTab: (tabID) => this.tabTitles.renameTab(tabID),
    scheduleSyncRestart: (tabID, state) =>
      this.scheduleSyncRestart(tabID, state),
    showLoaded: () => this.showSplitViewLoadMessage(true),
    showFailure: () => this.showSplitViewLoadMessage(false),
    debug: (message) => Zotero.debug(message),
  });
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

  private static clearLegacySyncEnabledPref(): void {
    // The standalone syncEnabled pref was removed. Existing tabs restore their
    // old sync state from session data, so new split views should no longer
    // consult this hidden pref as a long-term default.
    clearPref("syncEnabled");
  }

  private static refreshPrimaryMenuItemElement(
    menuitem: Element,
    tabID: string,
    side: "left" | "right" | null,
  ) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return null;

    const config = this.primaryView.getMenuConfig(state, side);
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
    this.tabNotifier.saveAll(this.stateMap.values());

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

    this.tabNotifier.unregister();

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

      // Reader setup starts synchronization after its delayed initialization.
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
    await this.pdfReplacement.selectAndLoad(tabID, targetSide);
  }

  /**
   * Swap the PDFs between left and right panels.
   * Recreates both browser instances with swapped items and view states.
   * Primary and active side settings remain attached to their panes.
   */
  private static async swapPDFs(tabID: string) {
    await this.pdfSwap.swap(tabID);
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

    const shell = this.splitReaderTab.create(win, tabID, container);
    await this.creation.createAndInitialize({
      win,
      tabID,
      shell,
      leftItem,
      rightItem: secondaryPDF,
      leftViewState,
      rightViewState,
      isSamePDF: false,
    });
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

    const shell = this.splitReaderTab.create(win, tabID, container);
    await this.creation.createAndInitialize({
      win,
      tabID,
      shell,
      leftItem: item,
      rightItem: item,
      leftViewState,
      rightViewState,
      isSamePDF: true,
    });
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
   * Open context menu for a reader
   */
  private static openContextMenu(
    browser: XULBrowserElement,
    popupset: XULElement,
    params: { x: number; y: number; itemGroups: any[][] },
  ) {
    this.readerPopupMenu.open(browser, popupset, params);
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
    await this.lifecycle.separate(tabID, clickedSide);
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
    await this.lifecycle.revertToSingleReader(tabID, sideToClose);
  }

  /**
   * Clean up split view state resources for a specific tab and remove from map.
   * Core cleanup logic shared by cleanupTab and cleanupTabResources.
   */
  private static cleanupTabResources(tabID: string) {
    this.tabCleanup.cleanup(tabID);
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

    this.tabNotifier.save(state);

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

    this.showSplitViewClosedMessage();
  }

  private static showSplitViewClosedMessage() {
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

  private static showSplitViewLoadMessage(loaded: boolean) {
    const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
    })
      .createLine({
        text: getString(loaded ? "splitview-loaded" : "splitview-not-found"),
        type: loaded ? "default" : "error",
        icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
      })
      .show();
    popup.startCloseTimer(2000);
  }

  private static showCreatedSplitViewMessage(isSamePDF: boolean) {
    const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
    })
      .createLine({
        text: getString(
          isSamePDF ? "splitview-same-pdf-loaded" : "splitview-loaded",
        ),
        type: "default",
        icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
      })
      .show();
    popup.startCloseTimer(3000);
  }

  private static showSplitViewSwappedMessage() {
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
  }

  private static scheduleSyncRestart(tabID: string, state: SplitTabState) {
    this.trackTimeout(
      state,
      () => {
        const current = this.stateMap.get(tabID);
        if (!current?.primarySide) return;
        this.sync.cacheViewerContainers(tabID);
        this.sync.initSyncState(tabID);
        this.sync.startSyncPolling(tabID);
      },
      500,
    );
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
    const primarySide = this.primaryView.getEffectiveSide(state);

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

    // Tab selection events call showForSplitView() through the shared notifier.
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
