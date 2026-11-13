import { SplitViewFactory } from "./modules/splitView";
import { initLocale } from "./utils/locale";
import {
  registerPreferencePane,
  registerPrefsScripts,
} from "./modules/preferenceScript";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  SplitViewFactory.registerSessionRestore();
  SplitViewFactory.registerPrefObservers();
  SplitViewFactory.registerSplitTabTitleItemNotifier();

  registerPreferencePane();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  SplitViewFactory.registerContextMenu();
  SplitViewFactory.registerTabLookup(win);
  SplitViewFactory.registerCommandPalette(win);
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
}

async function onMainWindowUnload(win: Window): Promise<void> {
  // Clean up split-view resources when the main window is unloaded.
  // This prevents keeping references to DOM nodes and windows that
  // become "dead objects" after Zotero is closed and reopened.
  SplitViewFactory.unregisterAll();

  // Cleanup ztoolkit and any open dialog windows.
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  SplitViewFactory.unregisterAll();
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * Dispatcher for Preference UI events.
 * @param type event type
 * @param data event data
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
