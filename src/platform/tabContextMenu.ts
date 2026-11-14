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
  private windows = new Map<Window, () => void>();

  constructor(private readonly callbacks: TabContextMenuCallbacks) {}

  register(win: Window): void {
    if (this.windows.has(win)) return;

    const document = win.document;
    let context: { tabID: string; openedAt: number; popup?: Element } | null =
      null;
    const showInLibraryLabel = Zotero.getString("general.showInLibrary");
    const moveTabLabel = Zotero.getString("tabs.move");
    const contextmenu = ((event: Event) => {
      const target = event.target as Element | null;
      const tab = target?.closest?.(
        "#tab-bar-container .tab[data-id]",
      ) as Element | null;
      const tabID = tab?.getAttribute("data-id");
      context = tabID ? { tabID, openedAt: Date.now() } : null;
    }) as EventListener;

    const popupshowing = ((event: Event) => {
      const popup = event.target as Element | null;
      if (!popup || popup.localName !== "menupopup") return;

      try {
        const current = context;
        if (!current || Date.now() - current.openedAt >= 5000) return;
        if (!this.callbacks.isActiveSplitView(current.tabID)) return;

        const tab = tabsForWindow(win).lookup(current.tabID)?.tab;
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

        current.popup = popup;
        const replacement = showInLibraryItem.cloneNode(true) as Element;
        replacement.addEventListener("command", (commandEvent: Event) => {
          commandEvent.preventDefault();
          commandEvent.stopPropagation();
          commandEvent.stopImmediatePropagation();

          const currentTab = tabsForWindow(win).lookup(current.tabID)?.tab;
          if (
            !this.callbacks.isActiveSplitView(current.tabID) ||
            !currentTab?.data?.isSplitView
          ) {
            return;
          }
          this.callbacks.showInLibrary(current.tabID, win);
        });
        showInLibraryItem.replaceWith(replacement);
      } catch {
        // Ignore popup decoration errors.
      }
    }) as EventListener;

    const popuphidden = ((event: Event) => {
      const target = event.target as Element | null;
      if (target?.localName === "menupopup" && context?.popup === target) {
        context = null;
      }
    }) as EventListener;

    document.addEventListener("contextmenu", contextmenu, true);
    document.addEventListener("popupshowing", popupshowing, true);
    document.addEventListener("popuphidden", popuphidden, true);
    this.windows.set(win, () => {
      context = null;
      const handlers: TabContextMenuHandlers = {
        contextmenu,
        popupshowing,
        popuphidden,
      };
      for (const [type, listener] of Object.entries(handlers)) {
        try {
          document.removeEventListener(type, listener, true);
        } catch (error) {
          Zotero.debug(`Split view: tab context menu cleanup failed: ${error}`);
        }
      }
    });
  }

  unregister(win?: Window): void {
    for (const [owner, dispose] of this.windows) {
      if (win && owner !== win) continue;
      dispose();
      this.windows.delete(owner);
    }
  }
}
