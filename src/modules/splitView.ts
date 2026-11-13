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
import { SplitViewConversionService } from "./splitView/conversion";
import { SplitViewShutdown } from "./splitView/shutdown";
import { SplitTabResourceTracker } from "./splitView/resourceTracker";
import { SplitReaderEntryFlow } from "./splitView/readerEntryFlow";
import { SplitTabNotifier } from "./splitView/tabNotifier";
import { SplitPrimaryView } from "./splitView/primaryView";
import { SplitScrollbar } from "./splitView/scrollbar";
import { ReaderMenuPresentation } from "./splitView/readerMenuPresentation";
import { SplitReaderPopupMenu } from "./splitView/readerPopupMenu";
import { SplitTabCleanup } from "./splitView/tabCleanup";
import { SplitSessionRestore } from "./splitView/sessionRestore";
import { SplitReaderInitialization } from "./splitView/readerInitialization";
import { SplitViewNotifications } from "./splitView/notifications";
import { SplitReaderToolbar } from "./splitView/readerToolbar";
import { SplitViewDelayedSetup } from "./splitView/delayedSetup";
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { clearPref, getPref } from "../utils/prefs";

export class SplitViewFactory {
  /** Per-tab split view states. Each tab can independently have its own split view. */
  private static stateMap: Map<string, SplitTabState> = new Map();
  private static notifications = new SplitViewNotifications({
    getString: (key, options) =>
      options
        ? getString(key as Parameters<typeof getString>[0], options as any)
        : getString(key as Parameters<typeof getString>[0]),
    show: (text, type, duration) => {
      const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
      })
        .createLine({
          text,
          type,
          icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
        })
        .show();
      popup.startCloseTimer(duration);
    },
  });
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
    saveState: (state) => this.tabNotifier.save(state),
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
    showClosed: () => this.notifications.showClosed(),
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
  private static menuPresentation = new ReaderMenuPresentation({
    getString: (key, options) =>
      options
        ? getString(key as Parameters<typeof getString>[0], options as any)
        : getString(key as Parameters<typeof getString>[0]),
    getAddonRef: () => addon.data.config.addonRef,
    getState: (id) => this.stateMap.get(id) ?? null,
    getPrimaryMenuConfig: (state, side) =>
      this.primaryView.getMenuConfig(state, side),
  });
  private static readerContextMenu = new SplitReaderContextMenu({
    isAlive: () => !!addon.data.alive,
    getState: (id) => this.stateMap.get(id) ?? null,
    getReaderSide: (id, reader) =>
      this.readAloudCoordinator.getReaderSide(id, reader as any),
    getPrimaryMenuConfig: (state, side) =>
      this.primaryView.getMenuConfig(state, side),
    getString: (key) => this.menuPresentation.getString(key),
    getCloseMenuLabel: () => this.menuPresentation.getCloseViewMenuLabel(),
    getSetPrimaryMenuLabel: (menuState) =>
      this.menuPresentation.getSetPrimaryMenuLabel(menuState),
    getIconURI: (name) => this.menuPresentation.getIconURI(name),
    setMenuItemIcon: (item, uri) =>
      this.menuPresentation.setMenuItemIcon(item, uri),
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
      this.menuPresentation.refreshPrimaryMenuItem(item, id, side),
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
  private static resourceTracker = new SplitTabResourceTracker(() =>
    Zotero.getMainWindow(),
  );
  private static sync = new SplitSync({
    getState: (id) => this.stateMap.get(id),
    getEffectivePrimarySide: (state) =>
      this.primaryView.getEffectiveSide(state),
    getMainWindow: () => Zotero.getMainWindow(),
    trackEventListener: (...args) =>
      this.resourceTracker.trackEventListener(...args),
    trackTimeout: (...args) => this.resourceTracker.trackTimeout(...args),
    onPositionSynced: (side, result) =>
      this.notifications.showPositionSynced(side, result),
  });
  private static interactions = new SplitInteractions({
    getState: (tabID) => this.stateMap.get(tabID),
    getEffectivePrimarySide: (state) =>
      this.primaryView.getEffectiveSide(state),
    sync: this.sync,
    trackEventListener: (...args) =>
      this.resourceTracker.trackEventListener(...args),
    updateScrollbarColors: (tabID) => this.splitScrollbar.update(tabID),
  });
  private static primaryView = new SplitPrimaryView({
    getState: (tabID) => this.stateMap.get(tabID) || null,
    stopSyncPolling: (tabID) => this.sync.stopSyncPolling(tabID),
    updateScrollbarColors: (tabID) => this.splitScrollbar.update(tabID),
    initSyncState: (tabID) => this.sync.initSyncState(tabID),
    startSyncPolling: (tabID) => this.sync.startSyncPolling(tabID),
    updateSession: (tabID) => this.updateTabDataForSession(tabID),
  });
  private static splitScrollbar = new SplitScrollbar({
    getState: (tabID) => this.stateMap.get(tabID) || null,
    getTabIDs: () => this.stateMap.keys(),
    getEffectivePrimarySide: (state) =>
      this.primaryView.getEffectiveSide(state),
    getColor: () => ({
      red: getPref("primaryScrollbarR") ?? 255,
      green: getPref("primaryScrollbarG") ?? 0,
      blue: getPref("primaryScrollbarB") ?? 0,
    }),
    setPrimaryColor: (browser, color) =>
      readerScrollbar.setPrimaryColor(browser, color),
    registerObserver: (name, callback) =>
      Zotero.Prefs.registerObserver(name, callback, true),
    unregisterObserver: (id) => Zotero.Prefs.unregisterObserver(id),
    debug: (message) => Zotero.debug(message),
  });
  private static delayedSetup = new SplitViewDelayedSetup({
    getState: (tabID) => this.stateMap.get(tabID),
    trackTimeout: (...args) => this.resourceTracker.trackTimeout(...args),
    setupResizeListener: (tabID, win) =>
      this.interactions.setupResizeListener(tabID, win),
    setupCtrlKeyListener: (tabID, browser) =>
      this.interactions.setupCtrlKeyListener(tabID, browser),
    setupMainWindowKeyboardListener: (tabID, win) =>
      this.interactions.setupMainWindowKeyboardListener(tabID, win),
    setupZoomButtonListeners: (tabID, browser) =>
      this.sync.setupZoomButtonListeners(tabID, browser),
    setupContextPaneObserver: (tabID, win) =>
      this.interactions.setupContextPaneObserver(tabID, win),
    cacheViewerContainers: (tabID) => this.sync.cacheViewerContainers(tabID),
    initSyncState: (tabID) => this.sync.initSyncState(tabID),
    startSyncPolling: (tabID) => this.sync.startSyncPolling(tabID),
    updateScrollbar: (tabID) => this.splitScrollbar.update(tabID),
  });
  private static readerHost = new SplitReaderHost();
  private static readerToolbar = new SplitReaderToolbar({
    getState: (tabID) => this.stateMap.get(tabID) || null,
    isBrowserAlive: (browser) => readerRuntime.isBrowserAlive(browser),
    hasActiveSplitState: (tabID) => this.hasActiveSplitState(tabID),
    getCloseLabel: () => this.menuPresentation.getCloseViewMenuLabel(),
    closeSide: (tabID, side) => void this.revertToSingleReader(tabID, side),
    installButton: (browser, options) => installCloseButton(browser, options),
  });
  private static readerInitialization = new SplitReaderInitialization(
    this.readerHost,
    {
      getState: (tabID) => this.stateMap.get(tabID) || null,
      getReadAloudConfig: (browser, ftl, onStatus) =>
        this.readAloud.getReaderConfig(browser, ftl, onStatus),
      handleReadAloudStatus: (tabID, browser, status) =>
        this.readAloudCoordinator.handleStatus(tabID, browser, status),
      openContextMenu: (browser, popupset, params) =>
        this.openContextMenu(browser, popupset, params),
      toggleSidebar: (tabID, browser, open) =>
        this.sync.handleSidebarToggle(tabID, browser, open),
      shouldSyncLastReadAloudPosition: (state, browser, viewState) =>
        this.readAloudCoordinator.shouldSyncLastPosition(
          state,
          browser,
          viewState,
        ),
      syncLastReadAloudPosition: (item, viewState) =>
        attachmentState.syncLastReadAloudPositionToItem(item, viewState),
      writeSession: (state) => this.session.write(state),
      saveAnnotations: (item, _browser, annotations, readerWindow) =>
        annotationStore.save(item.id, annotations, readerWindow),
      deleteAnnotations: (itemID, ids) => annotationStore.remove(itemID, ids),
      reportAnnotationFailure: (browser, error) =>
        reportAnnotationFailure(browser, error),
      toggleContextPane: (tabID) => {
        const win = Zotero.getMainWindow();
        const contextPane = (win as any).ZoteroContextPane;
        if (!contextPane) return;
        contextPane.togglePane();
        setTimeout(() => {
          const state = this.stateMap.get(tabID);
          if (!state?.rightBrowser) return;
          const isOpen = !((win as any).ZoteroContextPane?.collapsed ?? true);
          splitContextPane.setReaderOpen(state.rightBrowser, isOpen);
        }, 50);
      },
      afterReady: (tabID, browser, side) => {
        this.readerToolbar.installCloseButton(tabID, browser, side);
        if (side === "left") splitContextPane.hideReaderSidenav(browser);
        else splitContextPane.injectReaderHandler(browser);
        this.splitScrollbar.update(tabID);
      },
    },
  );
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
    showLoaded: (isSamePDF) => this.notifications.showCreated(isSamePDF),
    updateContextPane: (tabID, win, itemID) =>
      splitContextPane.updateItem(tabID, win, itemID),
    setupFocusListeners: (...args) =>
      this.interactions.setupFocusListeners(...args),
    bindAnnotations: (state) => bindSplitAnnotations(state),
    scheduleDelayedSetup: (...args) => this.delayedSetup.schedule(...args),
    writeSession: (state) => this.session.write(state),
    renameTab: (tabID) => this.tabTitles.renameTab(tabID),
    cleanup: (tabID) => this.cleanupTab(tabID),
  });
  private static conversion = new SplitViewConversionService({
    getMainWindow: () => Zotero.getMainWindow(),
    getItem: (itemID) => Zotero.Items.get(itemID) || undefined,
    getContainer: (win, tabID) => win.document.getElementById(tabID),
    getViewState: (reader) => readerView.getViewStateFromReader(reader),
    getStoredViewState: (item) => attachmentState.getStoredViewState(item),
    closeReader: (reader) => readerRuntime.closeReaderWithoutClosingTab(reader),
    createShell: (...args) => this.splitReaderTab.create(...args),
    createAndInitialize: (options) =>
      this.creation.createAndInitialize(options),
  });
  private static readerPopupMenu = new SplitReaderPopupMenu({
    isBrowserAlive: (browser) => readerRuntime.isBrowserAlive(browser),
    getMainWindow: () => Zotero.getMainWindow(),
    getStates: () => this.stateMap.entries(),
    getState: (tabID) => this.stateMap.get(tabID) || null,
    getString: (key, options) => this.menuPresentation.getString(key, options),
    getIconURI: (name) => this.menuPresentation.getIconURI(name),
    setMenuItemIcon: (item, uri) =>
      this.menuPresentation.setMenuItemIcon(item, uri),
    getCloseViewMenuLabel: () => this.menuPresentation.getCloseViewMenuLabel(),
    getOpenAnotherPDFMenuLabel: () =>
      this.menuPresentation.getOpenAnotherPDFMenuLabel(),
    getSyncPositionMenuLabel: (side) =>
      this.menuPresentation.getSyncPositionMenuLabel(side),
    getSetPrimaryMenuLabel: (state) =>
      this.menuPresentation.getSetPrimaryMenuLabel(state),
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
      this.menuPresentation.refreshPrimaryMenuItem(item, tabID, side),
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
    updateScrollbarColors: (tabID) => this.splitScrollbar.update(tabID),
    updateContextPane: (tabID, win, itemID) =>
      splitContextPane.updateItem(tabID, win, itemID),
    bindAnnotations: (state) => bindSplitAnnotations(state),
    updateSession: (tabID) => this.updateTabDataForSession(tabID),
    renameTab: (tabID) => this.tabTitles.renameTab(tabID),
    scheduleSyncRestart: (tabID, state) =>
      this.scheduleSyncRestart(tabID, state),
    showSwapped: () => this.notifications.showSwapped(),
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
    updateScrollbarColors: (tabID) => this.splitScrollbar.update(tabID),
    bindAnnotations: (state) => bindSplitAnnotations(state),
    updateSession: (tabID) => this.updateTabDataForSession(tabID),
    renameTab: (tabID) => this.tabTitles.renameTab(tabID),
    scheduleSyncRestart: (tabID, state) =>
      this.scheduleSyncRestart(tabID, state),
    showLoaded: () => this.notifications.showLoadResult(true),
    showFailure: () => this.notifications.showLoadResult(false),
    debug: (message) => Zotero.debug(message),
  });
  private static sessionRestore = new SplitSessionRestore({
    getReader: (tabID) => Zotero.Reader.getByTabID(tabID) || null,
    getInitializationPromise: (reader) =>
      readerRuntime.getInitializationPromise(reader),
    hasState: (tabID) => this.stateMap.has(tabID),
    itemExists: (itemID) => Zotero.Items.exists(itemID),
    getItem: (itemID) => Zotero.Items.get(itemID) || null,
    convertSamePDF: (reader, data) =>
      this.conversion.convertSamePDF(reader, data),
    convertDifferentPDF: (reader, item, data) =>
      this.conversion.convertDifferentPDF(reader, item, data),
    getState: (tabID) => this.stateMap.get(tabID) || null,
    updateBrowserFlex: (state, ratio) =>
      this.layout.updateBrowserFlex(
        state.leftBrowser,
        state.rightBrowser,
        ratio,
      ),
    updateScrollbarColors: (tabID) => this.splitScrollbar.update(tabID),
    writeSession: (tabID) => this.updateTabDataForSession(tabID),
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
    splitSamePDF: (reader) => this.conversion.convertSamePDF(reader),
    splitDifferentPDF: (reader, item) =>
      this.conversion.convertDifferentPDF(reader, item),
  });
  private static readerEntryFlow = new SplitReaderEntryFlow({
    getState: (tabID) => this.stateMap.get(tabID) || null,
    cleanup: (tabID) => this.cleanupTab(tabID),
    wait: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    getItem: (itemID) => Zotero.Items.get(itemID) || null,
    selectPDF: (libraryID) => this.pdfSelector.select(libraryID),
    convertSamePDF: (reader) => this.conversion.convertSamePDF(reader),
    convertDifferentPDF: (reader, item) =>
      this.conversion.convertDifferentPDF(reader, item),
  });
  private static shutdown = new SplitViewShutdown({
    disposePDFSelector: () => this.pdfSelector.dispose(),
    unregisterReaderContextMenu: () => this.readerContextMenu.unregister(),
    getStates: () => this.stateMap.values(),
    saveAll: (states) => this.tabNotifier.saveAll(states),
    getTabIDs: () => this.stateMap.keys(),
    cleanupTabResources: (tabID) => this.cleanupTabResources(tabID),
    clearStates: () => this.stateMap.clear(),
    unregisterSession: () => this.session.unregister(),
    unregisterTabNotifier: () => this.tabNotifier.unregister(),
    unregisterScrollbarObservers: () =>
      this.splitScrollbar.unregisterObservers(),
    unregisterTabTitles: () => this.tabTitles.unregister(),
    unregisterReadAloud: () => this.readAloud.unregister(),
    unregisterTabLookup: () => {
      this.tabHooks.unregister();
      this.tabContextMenu.unregister();
    },
    unregisterCommandPalette: () => commandPalette.unregister(),
    debug: (message) => Zotero.debug(message),
  });
  private static readAloud = new SplitReadAloudService({
    states: () => this.stateMap.values(),
    getReader: (browser) => readerRuntime.getInternalReaderFromBrowser(browser),
    isActive: (browser) =>
      !!this.readAloudCoordinator.getActiveReaderInfoByBrowser(browser),
  });
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

  static refreshOpenSplitViewTabTitles(): void {
    this.tabTitles.refreshOpenTabs();
  }

  static registerSplitTabTitleItemNotifier() {
    this.tabTitles.registerItemNotifier();
  }

  private static clearLegacySyncEnabledPref(): void {
    // The standalone syncEnabled pref was removed. Existing tabs restore their
    // old sync state from session data, so new split views should no longer
    // consult this hidden pref as a long-term default.
    clearPref("syncEnabled");
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

    this.splitScrollbar.registerObservers(prefix);

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
    this.shutdown.unregisterAll();
  }

  /**
   * Restore split view from saved session data
   */
  private static async restoreSplitViewFromSession(
    tabID: string,
    savedData: any,
  ) {
    await this.sessionRestore.restore(tabID, savedData);
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
    await this.readerEntryFlow.open(reader);
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
    await this.readerInitialization.initialize(
      tabID,
      browser,
      item,
      popupset,
      viewState,
      isRight,
    );
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
    this.tabCleanup.cleanupAndSave(tabID);
  }

  /**
   * Close split tab
   */
  private static closeSplitTab(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    this.cleanupTab(tabID);

    try {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = tabsForWindow(win);
      Zotero_Tabs.close(tabID);
    } catch {
      // Ignore errors
    }

    this.notifications.showClosed();
  }

  private static scheduleSyncRestart(tabID: string, state: SplitTabState) {
    this.resourceTracker.trackTimeout(
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
    this.resourceTracker.trackTimeout(
      state,
      () => splitContextPane.showForSplitView(win),
      300,
    );

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
