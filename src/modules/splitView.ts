import { bindSplitAnnotations } from "./splitView/annotations";
import { SplitLayout } from "./splitView/layout";
import { SplitSync } from "./splitView/sync";
import { SplitReaderHost } from "./splitView/readerHost";
import { annotationStore } from "../platform/annotationStore";
import { reportAnnotationFailure } from "../platform/readerAnnotations";
import { SplitSession } from "./splitView/session";
import { TabHooks } from "../platform/tabHooks";
import {
  setTabAudioStatus,
  tabsForWindow,
  tabsForWindowIfAvailable,
} from "../platform/tabs";
import { attachmentState } from "../platform/attachmentState";
import { readerView } from "../platform/readerView";
import { readerRuntime } from "../platform/readerRuntime";
import { readerApi } from "../platform/readerApi";
import { itemApi } from "../platform/itemApi";
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
import { SplitLibrarySelection } from "./splitView/librarySelection";
import { SplitCommandEntry } from "./splitView/commandEntry";
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
import { SplitTabStateStore } from "./splitView/stateStore";
import { SplitViewContextPane } from "./splitView/contextPane";
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
import { SplitViewRegistration } from "./splitView/registration";
import { libraryPane } from "../platform/libraryPane";
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { clearPref, getPref } from "../utils/prefs";

export class SplitViewFactory {
  /** Per-tab split states are owned by the registry, not by the controller. */
  private static stateStore = new SplitTabStateStore();
  private static librarySelection = new SplitLibrarySelection({
    getState: (tabID) => this.stateStore.get(tabID) || null,
    getParentItemID: (itemID) => {
      const item = itemApi.get(itemID);
      return item && item.parentItemID ? item.parentItemID : null;
    },
    selectItem: (win, itemID) => libraryPane.selectItem(win, itemID),
  });
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
    getState: (tabID) => this.stateStore.get(tabID) || null,
    getWindowForTab: (tabID) =>
      Zotero.getMainWindows().find(
        (win) => !!win.document.getElementById(tabID),
      ) || null,
    getActiveParentItemID: (state) =>
      this.stateStore.getActiveParentItemID(state),
    showForSplitView: (win) => splitContextPane.showForSplitView(win),
    updateContextPane: (tabID, win, itemID) =>
      splitContextPane.updateItem(tabID, win, itemID),
    captureViewState: (browser) =>
      readerView.getCurrentViewStateFromBrowser(browser),
    saveViewState: (itemID, viewState) =>
      attachmentState.saveViewStateToDisk(itemID, viewState),
    cleanupResources: (tabID) => this.tabCleanup.cleanup(tabID),
    registerNotifier: (callback) =>
      Zotero.Notifier.registerObserver(callback, ["tab"], "splitView", 20),
    unregisterNotifier: (id) => Zotero.Notifier.unregisterObserver(id),
    debug: (message) => Zotero.debug(message),
  });
  private static tabCleanup = new SplitTabCleanup({
    getState: (tabID) => this.stateStore.get(tabID) || null,
    removeState: (tabID) => this.stateStore.remove(tabID),
    hasState: (tabID) => this.stateStore.has(tabID),
    hasAnyState: () => this.stateStore.hasAny(),
    saveState: (state) => this.tabNotifier.save(state),
    pauseReader: (browser) =>
      this.readAloudCoordinator.pauseBrowser(browser, true),
    setAudioStatus: (tabID) =>
      setTabAudioStatus(
        tabID,
        { active: false, paused: false },
        this.stateStore.get(tabID)?.ownerWindow,
      ),
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
    getReader: (tabID) => readerApi.getByTabID(tabID),
    openReader: (itemID, options) => readerApi.open(itemID, undefined, options),
    waitForReaderReady: (reader, maxWaitMs) =>
      readerRuntime.waitForReaderReady(reader, maxWaitMs),
    applyViewState: (reader, viewState) =>
      readerView.applyViewStateToReader(reader, viewState),
    delay: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    debug: (message) => Zotero.debug(message),
  });
  private static lifecycle = new SplitViewLifecycle({
    getState: (tabID) => this.stateStore.get(tabID) || null,
    getTabs: () => tabsForWindow(Zotero.getMainWindow()),
    targets: this.separateTargets,
    captureViewState: (browser) =>
      readerView.getCurrentViewStateFromBrowser(browser),
    saveViewState: (itemID, viewState) =>
      attachmentState.saveViewStateToDisk(itemID, viewState),
    cleanup: (tabID) => this.tabCleanup.cleanup(tabID),
    prepareSingleReaderClose: (tabID, itemID) =>
      this.session.prepareClose(tabID, itemID),
    showClosed: () => this.notifications.showClosed(),
    debug: (message) => Zotero.debug(message),
  });
  private static tabTitles = new SplitTabTitleService({
    getStates: () => this.stateStore.values(),
    getState: (id) => this.stateStore.get(id),
    getItem: (itemID) => itemApi.get(itemID),
  });
  private static readAloudCoordinator = new SplitReadAloudCoordinator({
    states: () => this.stateStore.values(),
    getState: (id) => this.stateStore.get(id),
    getReader: (browser) => readerRuntime.getInternalReaderFromBrowser(browser),
    setAudioStatus: (id, status) =>
      setTabAudioStatus(id, status, this.stateStore.get(id)?.ownerWindow),
    pauseOtherReaders: pauseNativeReaders,
  });
  private static readerBrowser = new SplitReaderBrowserAdapter({
    getState: (tabID) => this.stateStore.get(tabID) || null,
    getReaderForBrowser: (browser) =>
      readerRuntime.getReaderForBrowser(browser),
    closeReader: (reader) => readerRuntime.closeReaderWithoutClosingTab(reader),
    clearReadAloudSide: (state, side) =>
      this.readAloudCoordinator.clearSide(state as SplitTabState, side),
  });
  private static tabHooks = new TabHooks({
    hasSplit: (id) => this.stateStore.hasActive(id),
    findRightItem: (itemID) =>
      this.stateStore.findByRightItem(itemID)?.tabID || null,
    getTitle: (tab) => this.tabTitles.getTitleForTab(tab),
    toggleAudio: (id) => this.readAloudCoordinator.toggleActive(id),
    pauseSplitAudio: () => this.readAloudCoordinator.pauseAll(),
  });
  private static tabContextMenu = new SplitTabContextMenu({
    isActiveSplitView: (id) => this.stateStore.hasActive(id),
    showInLibrary: (id, win) => this.librarySelection.showActiveItem(id, win),
  });
  private static menuPresentation = new ReaderMenuPresentation({
    getString: (key, options) =>
      options
        ? getString(key as Parameters<typeof getString>[0], options as any)
        : getString(key as Parameters<typeof getString>[0]),
    getAddonRef: () => addon.data.config.addonRef,
    getState: (id) => this.stateStore.get(id) ?? null,
    getPrimaryMenuConfig: (state, side) =>
      this.primaryView.getMenuConfig(state, side),
  });
  private static readerContextMenu = new SplitReaderContextMenu({
    isAlive: () => !!addon.data.alive,
    getState: (id) => this.stateStore.get(id) ?? null,
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
    swapPDFs: (id) => this.pdfSwap.swap(id),
    separateViews: (id, side) => void this.lifecycle.separate(id, side),
    handleSplitView: (reader) => void this.readerEntryFlow.open(reader),
    revertToSingleReader: (id, side) =>
      void this.lifecycle.revertToSingleReader(id, side),
    setPrimarySide: (id, side) => this.primaryView.setSide(id, side),
    selectAndLoadPDF: (id, side) => this.pdfReplacement.selectAndLoad(id, side),
    syncPositionAndScale: (id, side) =>
      this.sync.syncPositionAndScale(id, side),
    activateSide: (id, side, win) =>
      this.interactions.activateSide(id, side, win),
    refreshPrimaryMenuItem: (item, id, side) =>
      this.menuPresentation.refreshPrimaryMenuItem(item, id, side),
  });
  private static session = new SplitSession(
    (id, data) => this.sessionRestore.restore(id, data),
    (id) => this.stateStore.hasActive(id),
    (id) => this.stateStore.get(id),
  );
  private static layout = new SplitLayout(
    (id) => this.stateStore.get(id),
    (state) => this.session.write(state),
  );
  private static splitReaderTab = new SplitReaderTabAdapter({
    getState: (tabID) => this.stateStore.get(tabID) || null,
    getInternalReader: (browser) =>
      readerRuntime.getInternalReaderFromBrowser(browser),
    setContextPaneOpen: (browser, open) =>
      splitContextPane.setReaderOpen(browser, open),
  });
  private static resourceTracker = new SplitTabResourceTracker(() =>
    Zotero.getMainWindow(),
  );
  private static splitContextPane = new SplitViewContextPane({
    getState: (tabID) => this.stateStore.get(tabID),
    getMainWindow: () => Zotero.getMainWindow(),
    showForSplitView: (win) => splitContextPane.showForSplitView(win),
    toggleMainPane: (win) => splitContextPane.toggleMainPane(win),
    isMainPaneOpen: (win) => splitContextPane.isMainPaneOpen(win),
    setReaderOpen: (browser, open) =>
      splitContextPane.setReaderOpen(browser, open),
    trackTimeout: (...args) => this.resourceTracker.trackTimeout(...args),
  });
  private static sync = new SplitSync({
    getState: (id) => this.stateStore.get(id),
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
    getState: (tabID) => this.stateStore.get(tabID),
    getEffectivePrimarySide: (state) =>
      this.primaryView.getEffectiveSide(state),
    sync: this.sync,
    trackEventListener: (...args) =>
      this.resourceTracker.trackEventListener(...args),
    updateScrollbarColors: (tabID) => this.splitScrollbar.update(tabID),
  });
  private static primaryView = new SplitPrimaryView({
    getState: (tabID) => this.stateStore.get(tabID) || null,
    stopSyncPolling: (tabID) => this.sync.stopSyncPolling(tabID),
    updateScrollbarColors: (tabID) => this.splitScrollbar.update(tabID),
    initSyncState: (tabID) => this.sync.initSyncState(tabID),
    startSyncPolling: (tabID) => this.sync.startSyncPolling(tabID),
    updateSession: (tabID) => this.session.writeTab(tabID),
  });
  private static splitScrollbar = new SplitScrollbar({
    getState: (tabID) => this.stateStore.get(tabID) || null,
    getTabIDs: () => this.stateStore.keys(),
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
    getState: (tabID) => this.stateStore.get(tabID),
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
    getState: (tabID) => this.stateStore.get(tabID) || null,
    isBrowserAlive: (browser) => readerRuntime.isBrowserAlive(browser),
    hasActiveSplitState: (tabID) => this.stateStore.hasActive(tabID),
    getCloseLabel: () => this.menuPresentation.getCloseViewMenuLabel(),
    closeSide: (tabID, side) =>
      void this.lifecycle.revertToSingleReader(tabID, side),
    installButton: (browser, options) => installCloseButton(browser, options),
  });
  private static readerInitialization = new SplitReaderInitialization(
    this.readerHost,
    {
      getState: (tabID) => this.stateStore.get(tabID) || null,
      getReadAloudConfig: (browser, ftl, onStatus) =>
        this.readAloud.getReaderConfig(browser, ftl, onStatus),
      handleReadAloudStatus: (tabID, browser, status) =>
        this.readAloudCoordinator.handleStatus(tabID, browser, status),
      openContextMenu: (browser, popupset, params) =>
        this.readerPopupMenu.open(browser, popupset, params),
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
      toggleContextPane: (tabID) =>
        this.splitContextPane.toggleForReader(tabID),
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
    setState: (tabID, state) => this.stateStore.set(tabID, state),
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
      this.tabNotifier.ensureRegistered();
      this.splitContextPane.setupForCreatedTab(tabID, win);
    },
    initializeReader: (...args) =>
      this.readerInitialization.initialize(...args),
    showLoaded: (isSamePDF) => this.notifications.showCreated(isSamePDF),
    updateContextPane: (tabID, win, itemID) =>
      splitContextPane.updateItem(tabID, win, itemID),
    setupFocusListeners: (...args) =>
      this.interactions.setupFocusListeners(...args),
    bindAnnotations: (state) => bindSplitAnnotations(state),
    scheduleDelayedSetup: (...args) => this.delayedSetup.schedule(...args),
    writeSession: (state) => this.session.write(state),
    renameTab: (tabID) => this.tabTitles.renameTab(tabID),
    cleanup: (tabID) => this.tabCleanup.cleanup(tabID),
  });
  private static conversion = new SplitViewConversionService({
    getMainWindow: () => Zotero.getMainWindow(),
    getItem: (itemID) => itemApi.get(itemID) || undefined,
    getContainer: (win, tabID) =>
      this.splitReaderTab.getTabContainer(win, tabID),
    getViewState: (reader) => readerView.getViewStateFromReader(reader),
    getStoredViewState: (item) => attachmentState.getStoredViewState(item),
    closeReader: (reader) => readerRuntime.closeReaderWithoutClosingTab(reader),
    createShell: (...args) => this.splitReaderTab.create(...args),
    createAndInitialize: (options) =>
      this.creation.createAndInitialize(options),
    restoreReader: async (win, tabID, container, itemID, viewState) => {
      this.tabCleanup.cleanup(tabID);
      this.session.prepareClose(tabID, itemID, win);
      this.splitReaderTab.restore(win, tabID, container);
      const reader = await readerApi.open(itemID, undefined, {
        tabID,
        allowDuplicate: true,
        openInBackground: tabsForWindow(win).selectedID !== tabID,
      });
      if (!reader) throw new Error("Reader recovery did not return a reader");
      await readerRuntime.waitForReaderReady(reader);
      await readerView.applyViewStateToReader(reader, viewState);
    },
  });
  private static readerPopupMenu = new SplitReaderPopupMenu({
    isBrowserAlive: (browser) => readerRuntime.isBrowserAlive(browser),
    getMainWindow: () => Zotero.getMainWindow(),
    getStates: () => this.stateStore.entries(),
    getState: (tabID) => this.stateStore.get(tabID) || null,
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
    swapPDFs: (tabID) => this.pdfSwap.swap(tabID),
    separateViews: (tabID, side) => void this.lifecycle.separate(tabID, side),
    closeSide: (tabID, side) =>
      void this.lifecycle.revertToSingleReader(tabID, side),
    setPrimarySide: (tabID, side) => this.primaryView.setSide(tabID, side),
    selectAndLoadPDF: (tabID, side) =>
      this.pdfReplacement.selectAndLoad(tabID, side),
    syncPositionAndScale: (tabID, side) =>
      this.sync.syncPositionAndScale(tabID, side),
    activateSide: (tabID, side, win) =>
      this.interactions.activateSide(tabID, side, win),
    refreshPrimaryMenuItem: (item, tabID, side) =>
      this.menuPresentation.refreshPrimaryMenuItem(item, tabID, side),
    schedule: (callback) => setTimeout(callback),
  });
  private static pdfSwap = new PDFSwapService({
    getState: (tabID) => this.stateStore.get(tabID) || null,
    captureViewState: (browser) =>
      readerView.getCurrentViewStateFromBrowser(browser),
    replaceBrowser: (tabID, side) => this.readerBrowser.replace(tabID, side),
    getItem: (itemID) => itemApi.get(itemID) || undefined,
    getMainWindow: () => Zotero.getMainWindow(),
    initializeReader: (...args) =>
      this.readerInitialization.initialize(...args),
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
    updateSession: (tabID) => this.session.writeTab(tabID),
    renameTab: (tabID) => this.tabTitles.renameTab(tabID),
    scheduleSyncRestart: (tabID, state) =>
      this.delayedSetup.restartSync(tabID, state),
    showSwapped: () => this.notifications.showSwapped(),
    debug: (message) => Zotero.debug(message),
  });
  private static pdfReplacement = new PDFReplacementService({
    getState: (tabID) => this.stateStore.get(tabID) || null,
    getItem: (itemID) => itemApi.get(itemID) || undefined,
    selectPDF: (libraryID) => this.pdfSelector.select(libraryID),
    getStoredViewState: (item) => attachmentState.getStoredViewState(item),
    replaceBrowser: (tabID, side) => this.readerBrowser.replace(tabID, side),
    getMainWindow: () => Zotero.getMainWindow(),
    initializeReader: (...args) =>
      this.readerInitialization.initialize(...args),
    setupBrowserFocusListeners: (...args) =>
      this.interactions.setupBrowserFocusListeners(...args),
    setupCtrlKeyListener: (...args) =>
      this.interactions.setupCtrlKeyListener(...args),
    setupZoomButtonListeners: (tabID, browser) =>
      this.sync.setupZoomButtonListeners(tabID, browser),
    stopSyncPolling: (tabID) => this.sync.stopSyncPolling(tabID),
    updateScrollbarColors: (tabID) => this.splitScrollbar.update(tabID),
    bindAnnotations: (state) => bindSplitAnnotations(state),
    updateSession: (tabID) => this.session.writeTab(tabID),
    renameTab: (tabID) => this.tabTitles.renameTab(tabID),
    scheduleSyncRestart: (tabID, state) =>
      this.delayedSetup.restartSync(tabID, state),
    showLoaded: () => this.notifications.showLoadResult(true),
    showFailure: () => this.notifications.showLoadResult(false),
    debug: (message) => Zotero.debug(message),
  });
  private static sessionRestore = new SplitSessionRestore({
    getReader: (tabID) => readerApi.getByTabID(tabID),
    getInitializationPromise: (reader) =>
      readerRuntime.getInitializationPromise(reader),
    hasState: (tabID) => this.stateStore.has(tabID),
    itemExists: (itemID) => itemApi.exists(itemID),
    getItem: (itemID) => itemApi.get(itemID) || null,
    restoreSavedSplit: (reader, data) =>
      this.conversion.restoreSavedSplit(reader, data),
    getState: (tabID) => this.stateStore.get(tabID) || null,
    updateBrowserFlex: (state, ratio) =>
      this.layout.updateBrowserFlex(
        state.leftBrowser,
        state.rightBrowser,
        ratio,
      ),
    updateScrollbarColors: (tabID) => this.splitScrollbar.update(tabID),
    writeSession: (tabID) => this.session.writeTab(tabID),
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
    getTabs: () => tabsForWindowIfAvailable(Zotero.getMainWindow()),
    getReader: (tabID) => readerApi.getByTabID(tabID),
    openReader: (itemID) => readerApi.open(itemID),
    wait: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    waitForReaderReady: (reader) => readerRuntime.waitForReaderReady(reader),
    hasSplitState: (tabID) => this.stateStore.has(tabID),
    splitSamePDF: (reader) => this.conversion.convertSamePDF(reader),
    splitDifferentPDF: (reader, item) =>
      this.conversion.convertDifferentPDF(reader, item),
  });
  private static readerEntryFlow = new SplitReaderEntryFlow({
    getState: (tabID) => this.stateStore.get(tabID) || null,
    cleanup: (tabID) => this.tabCleanup.cleanupAndSave(tabID),
    wait: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    getItem: (itemID) => itemApi.get(itemID) || null,
    selectPDF: (libraryID) => this.pdfSelector.select(libraryID),
    convertSamePDF: (reader) => this.conversion.convertSamePDF(reader),
    convertDifferentPDF: (reader, item) =>
      this.conversion.convertDifferentPDF(reader, item),
  });
  private static commandEntry = new SplitCommandEntry({
    getReader: (win) => {
      const selectedID = tabsForWindow(win)?.selectedID;
      return selectedID ? readerApi.getByTabID(selectedID) : null;
    },
    openReader: (reader) => this.readerEntryFlow.open(reader),
    openLibrary: () => this.libraryFlow.open(),
  });
  private static shutdown = new SplitViewShutdown({
    disposePDFSelector: () => this.pdfSelector.dispose(),
    unregisterReaderContextMenu: () => this.readerContextMenu.unregister(),
    getStates: () => this.stateStore.values(),
    saveAll: (states) => this.tabNotifier.saveAll(states),
    getTabIDs: () => this.stateStore.keys(),
    restoreTabForDisable: (tabID) => this.restoreTabForDisable(tabID),
    cleanupTabResources: (tabID) => this.tabCleanup.cleanup(tabID),
    clearStates: () => this.stateStore.clear(),
    unregisterSession: () => this.session.unregister(),
    unregisterTabNotifier: () => this.tabNotifier.unregister(),
    unregisterScrollbarObservers: () =>
      this.splitScrollbar.unregisterObservers(),
    unregisterTabTitles: () => this.tabTitles.unregister(),
    unregisterReadAloud: () => this.readAloud.unregister(),
    unregisterTabLookup: (win) => {
      this.tabHooks.unregister(win);
      this.tabContextMenu.unregister(win);
    },
    unregisterCommandPalette: (win) => commandPalette.unregister(win),
    debug: (message) => Zotero.debug(message),
  });
  private static readAloud = new SplitReadAloudService({
    states: () => this.stateStore.values(),
    getReader: (browser) => readerRuntime.getInternalReaderFromBrowser(browser),
    isActive: (browser) =>
      !!this.readAloudCoordinator.getActiveReaderInfoByBrowser(browser),
  });
  private static registration = new SplitViewRegistration({
    registerSessionRestore: () => this.session.register(),
    registerTitleItemNotifier: () => this.tabTitles.registerItemNotifier(),
    registerReaderContextMenu: () =>
      this.readerContextMenu.register(addon.data.config.addonID),
    registerTabLookup: (win) => {
      this.tabHooks.register(win);
      this.tabContextMenu.register(win);
    },
    clearLegacySyncPreference: () => clearPref("syncEnabled"),
    registerScrollbarPreferences: (prefix) =>
      this.splitScrollbar.registerObservers(prefix),
    registerTitlePreference: (name) =>
      this.tabTitles.registerPreferenceObserver(name),
    registerReadAloud: () => this.readAloud.register(),
    registerCommandPalette: (win) =>
      commandPalette.register(win, () => this.commandEntry.execute(win)),
    unregisterAll: () => this.shutdown.unregisterAll(),
  });
  static refreshOpenSplitViewTabTitles(): void {
    this.tabTitles.refreshOpenTabs();
  }

  static registerSplitTabTitleItemNotifier() {
    this.registration.registerTitleItemNotifier();
  }

  static registerContextMenu() {
    this.registration.registerReaderContextMenu();
  }

  /**
   * Hook into Zotero_Tabs.getTabIDByItemID to support finding tabs by right-side itemID
   */
  static registerTabLookup(win: Window = Zotero.getMainWindow()) {
    this.registration.registerTabLookup(win);
  }
  static registerSessionRestore() {
    this.registration.registerSessionRestore();
  }

  /**
   * Register preference observers so that changes in the preference panel
   * take effect immediately on all existing split view tabs.
   */
  static registerPrefObservers() {
    this.registration.registerPreferences(config.prefsPrefix);
  }

  /**
   * Register a named command in the Shift+P command palette.
   * Context-aware: in a reader tab it starts the split view flow immediately;
   * in the library or any other tab it enters the two-step PDF selection flow.
   */
  static registerCommandPalette(win: Window) {
    this.registration.registerCommandPalette(win);
  }

  /**
   * Unregister all split view notifiers and cleanup.
   * This should be called during plugin shutdown.
   */
  static unregisterAll(): Promise<void> {
    return this.registration.unregisterAll();
  }

  private static async restoreTabForDisable(tabID: string): Promise<void> {
    const state = this.stateStore.get(tabID);
    if (!state) return;

    const win = state.ownerWindow;
    const tabs = tabsForWindow(win);
    const tab = tabs.lookup(tabID).tab;
    if (!tab || win.closed) {
      this.tabCleanup.cleanup(tabID);
      return;
    }

    const itemID =
      state.activeSide === "left" ? state.leftItemID : state.rightItemID;
    const item = itemApi.get(itemID);

    try {
      await this.tabNotifier.saveStateAndWait(state);
    } catch (error) {
      Zotero.debug(
        `Split view: disable - saving state for ${tabID} failed: ${error}`,
      );
    }
    this.session.write(state, itemID);
    const viewState =
      state.activeSide === "left" ? state.leftViewState : state.rightViewState;

    const originalTitle = state.originalTitle;
    const originalReaderContainer = state.originalReaderContainer;
    state.isCleaningUp = true;
    for (const browser of [state.leftBrowser, state.rightBrowser]) {
      try {
        this.readAloudCoordinator.pauseBrowser(browser, true);
        const reader = readerRuntime.getReaderForBrowser(browser);
        if (reader) await readerRuntime.closeReaderWithoutClosingTab(reader);
      } catch (error) {
        Zotero.debug(
          `Split view: disable - closing reader for ${tabID} failed: ${error}`,
        );
      }
    }
    state.isCleaningUp = false;

    this.tabCleanup.cleanup(tabID);
    this.splitReaderTab.restore(win, tabID, originalReaderContainer);

    const reader = await readerApi.open(itemID, undefined, {
      tabID,
      allowDuplicate: true,
      openInBackground: tabs.selectedID !== tabID,
    });
    if (!reader) throw new Error("Native reader was not restored");
    await readerRuntime.waitForReaderReady(reader);
    if (viewState) await readerView.applyViewStateToReader(reader, viewState);

    this.session.writeSavedState(state, itemID);
    if (originalTitle) await tabs.rename(tabID, originalTitle);
    if (item)
      splitContextPane.updateItem(tabID, win, item.parentItemID || item.id);
  }

  static unregisterWindow(win: Window) {
    this.shutdown.unregisterWindow(win);
  }
}
