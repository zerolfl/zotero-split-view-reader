import { readerRuntime } from "../../platform/readerRuntime";
import { annotationStore } from "../../platform/annotationStore";
import { createGetSDTPack } from "../../platform/readerSDT";
import { buildSplitReaderConfig } from "./readerConfig";

interface ReaderHostCallbacks {
  onReadAloudStatus: (status: any) => void;
  openContextMenu: (params: any) => void;
  toggleSidebar: (open: boolean) => void;
  onViewStateChange: (viewState: any) => void;
  saveAnnotations: (
    annotations: any[],
    callback: () => void,
    win: Window,
  ) => Promise<void>;
  deleteAnnotations: (ids: string[]) => void;
  toggleContextPane: () => void;
  afterReady: () => void;
}

interface ReaderHostConfig {
  browser: XULBrowserElement;
  item: Zotero.Item;
  viewState?: any;
  isRight: boolean;
  getReadAloudConfig: (
    ftl: string[],
    onStatus: (status: any) => void,
  ) => Promise<Record<string, any>>;
  callbacks: ReaderHostCallbacks;
}

export class SplitReaderHost {
  async initialize(options: ReaderHostConfig): Promise<void> {
    const { browser, item, viewState, isRight, callbacks } = options;
    await readerRuntime.waitForBrowserLoad(browser);

    const win = browser.contentWindow;
    if (!win) throw new Error("Browser contentWindow not available");
    const wrappedWin = (win as any).wrappedJSObject || win;

    const data = {
      url: `zotero://attachment/${Zotero.API.getLibraryPrefix(item.libraryID)}/items/${item.key}/`,
    };
    const ftl: string[] = [];
    try {
      ftl.push(
        await Zotero.File.getContentsFromURLAsync(
          "chrome://zotero/locale/zotero.ftl",
        ),
      );
    } catch {
      // Ignore FTL loading errors.
    }
    try {
      ftl.push(
        await Zotero.File.getContentsFromURLAsync(
          "chrome://zotero/locale/reader.ftl",
        ),
      );
    } catch {
      // Ignore FTL loading errors.
    }

    const readAloudConfig = await options.getReadAloudConfig(
      ftl,
      callbacks.onReadAloudStatus,
    );
    const mainWindow = Zotero.getMainWindow();
    const showContextPaneToggle = isRight;
    const contextPaneOpen = isRight
      ? !((mainWindow as any).ZoteroContextPane?.collapsed ?? true)
      : false;
    const isStacked = Zotero.Prefs.get("layout") === "stacked";
    const bottomPlaceholderHeight = isStacked ? 0 : null;

    const readerConfig = buildSplitReaderConfig({
      data,
      annotations: await annotationStore.load(item),
      readOnly: annotationStore.isReadOnly(item),
      authorName:
        item.library.libraryType === "group"
          ? Zotero.Users.getCurrentName()
          : "",
      showContextPaneToggle,
      contextPaneOpen,
      bottomPlaceholderHeight,
      rtl: (Zotero as any).rtl,
      fontSize: Zotero.Prefs.get("fontSize"),
      ftl,
      readerWindow: win,
      preferences: {
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
        readAloudHighlightGranularity: Zotero.Prefs.get(
          "reader.readAloud.highlightGranularity",
        ),
      },
      readAloudConfig,
      getSDTPack: createGetSDTPack(item.id, win),
      viewState,
      callbacks: {
        openContextMenu: () => {
          const params = wrappedWin.contextMenuParams;
          if (params) callbacks.openContextMenu(params);
        },
        toggleSidebar: callbacks.toggleSidebar,
        onViewStateChange: (currentViewState) =>
          callbacks.onViewStateChange(currentViewState),
        saveAnnotations: (annotations, callback) =>
          callbacks.saveAnnotations(annotations, callback, win),
        deleteAnnotations: callbacks.deleteAnnotations,
        toggleContextPane: callbacks.toggleContextPane,
      },
    });

    wrappedWin.createReader(
      Components.utils.cloneInto(readerConfig, win, {
        wrapReflectors: true,
        cloneFunctions: true,
      }),
    );
    await readerRuntime.waitForInternalReader(browser);
    callbacks.afterReady();
  }
}
