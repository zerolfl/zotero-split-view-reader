import { tabsForWindow } from "./tabs";

interface TabContextMenuCallbacks {
  isActiveSplitView: (tabID: string) => boolean;
  showInLibrary: (tabID: string, win: Window) => void;
}

interface TabContextMenuHandlers {
  contextmenu: EventListener;
  popupshowing: EventListener;
  popuphidden: EventListener;
}

export class SplitTabContextMenu {
  private context: { tabID: string; openedAt: number; popup?: Element } | null =
    null;
  private handlers: TabContextMenuHandlers | null = null;
  private document: Document | null = null;

  constructor(private readonly callbacks: TabContextMenuCallbacks) {}

  register(win: Window): void {
    if (this.handlers) return;

    const document = win.document;
    const showInLibraryLabel = Zotero.getString("general.showInLibrary");
    const moveTabLabel = Zotero.getString("tabs.move");
    const contextmenu = ((event: Event) => {
      const target = event.target as Element | null;
      const tab = target?.closest?.(
        "#tab-bar-container .tab[data-id]",
      ) as Element | null;
      const tabID = tab?.getAttribute("data-id");
      this.context = tabID ? { tabID, openedAt: Date.now() } : null;
    }) as EventListener;

    const popupshowing = ((event: Event) => {
      const popup = event.target as Element | null;
      if (!popup || popup.localName !== "menupopup") return;

      try {
        const context = this.context;
        if (!context || Date.now() - context.openedAt >= 5000) return;
        if (!this.callbacks.isActiveSplitView(context.tabID)) return;

        const tab = tabsForWindow(win).lookup(context.tabID)?.tab;
        if (!tab?.data?.isSplitView) return;

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

        context.popup = popup;
        const replacement = showInLibraryItem.cloneNode(true) as Element;
        replacement.addEventListener("command", (commandEvent: Event) => {
          commandEvent.preventDefault();
          commandEvent.stopPropagation();
          commandEvent.stopImmediatePropagation();

          const currentTab = tabsForWindow(win).lookup(context.tabID)?.tab;
          if (
            !this.callbacks.isActiveSplitView(context.tabID) ||
            !currentTab?.data?.isSplitView
          ) {
            return;
          }
          this.callbacks.showInLibrary(context.tabID, win);
        });
        showInLibraryItem.replaceWith(replacement);
      } catch {
        // Ignore popup decoration errors.
      }
    }) as EventListener;

    const popuphidden = ((event: Event) => {
      const target = event.target as Element | null;
      if (target?.localName === "menupopup" && this.context?.popup === target) {
        this.context = null;
      }
    }) as EventListener;

    document.addEventListener("contextmenu", contextmenu, true);
    document.addEventListener("popupshowing", popupshowing, true);
    document.addEventListener("popuphidden", popuphidden, true);
    this.document = document;
    this.handlers = { contextmenu, popupshowing, popuphidden };
  }

  unregister(): void {
    try {
      if (this.document && this.handlers) {
        this.document.removeEventListener(
          "contextmenu",
          this.handlers.contextmenu,
          true,
        );
        this.document.removeEventListener(
          "popupshowing",
          this.handlers.popupshowing,
          true,
        );
        this.document.removeEventListener(
          "popuphidden",
          this.handlers.popuphidden,
          true,
        );
      }
    } catch (error) {
      Zotero.debug(`Split view: tab context menu cleanup failed: ${error}`);
    } finally {
      this.context = null;
      this.handlers = null;
      this.document = null;
    }
  }
}
