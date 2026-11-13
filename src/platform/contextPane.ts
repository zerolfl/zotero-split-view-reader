import { readerRuntime } from "./readerRuntime";

export class ContextPaneAdapter {
  toggleMainPane(win: Window): boolean {
    const contextPane = (win as any).ZoteroContextPane;
    if (!contextPane) return false;
    contextPane.togglePane();
    return true;
  }

  isMainPaneOpen(win: Window): boolean {
    return !((win as any).ZoteroContextPane?.collapsed ?? true);
  }

  hideReaderSidenav(browser: XULBrowserElement) {
    try {
      const win = browser.contentWindow;
      if (!win) return;

      const wrappedWin = (win as any).wrappedJSObject || win;
      const doc = wrappedWin.document;
      if (!doc) return;

      const sidenav = doc.querySelector(
        ".sidenav, reader-sidenav, #sidenav, [class*='sidenav']",
      );
      if (sidenav) sidenav.style.display = "none";

      const toggleBtns = doc.querySelectorAll(
        "[class*='context-pane'], [data-action='toggle-pane']",
      );
      toggleBtns.forEach((btn: any) => {
        btn.style.display = "none";
      });

      const internalReader =
        readerRuntime.getInternalReaderFromBrowser(browser);
      if (internalReader?._sidenav) {
        internalReader._sidenav.style.display = "none";
      }
      if (internalReader?._toolbarRight) {
        const contextItems = internalReader._toolbarRight.querySelectorAll?.(
          "[class*='context'], [data-action='toggle-pane']",
        );
        contextItems?.forEach((item: any) => {
          item.style.display = "none";
        });
      }
    } catch {
      // Ignore errors from unloaded reader documents.
    }
  }

  injectReaderHandler(browser: XULBrowserElement) {
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
      script.remove();
    } catch (e) {
      Zotero.debug(`Split view: injectContextPaneHandler error: ${e}`);
    }
  }

  setReaderOpen(browser: XULBrowserElement, open: boolean) {
    if (!readerRuntime.isBrowserAlive(browser)) return;
    try {
      const win = browser.contentWindow;
      if (!win) return;
      const wrappedWin = (win as any).wrappedJSObject || win;
      const doc = wrappedWin.document;
      if (!doc) return;

      const eventInit = Components.utils.cloneInto({ detail: { open } }, win);
      doc.dispatchEvent(
        new wrappedWin.CustomEvent("__splitview_context_pane", eventInit),
      );
    } catch (e) {
      Zotero.debug(`Split view: setContextPaneOpenForBrowser error: ${e}`);
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
        // Ignore fallback errors.
      }
    }
  }

  observeCollapsed(
    win: Window,
    onChange: (isOpen: boolean) => void,
  ): MutationObserver | null {
    try {
      const contextPane = win.document.getElementById("zotero-context-pane");
      if (!contextPane) return null;

      const observer = new win.MutationObserver(
        (mutations: MutationRecord[]) => {
          for (const mutation of mutations) {
            if (
              mutation.type === "attributes" &&
              mutation.attributeName === "collapsed"
            ) {
              onChange(contextPane.getAttribute("collapsed") !== "true");
            }
          }
        },
      );
      observer.observe(contextPane, {
        attributes: true,
        attributeFilter: ["collapsed"],
      });
      return observer;
    } catch {
      return null;
    }
  }

  disconnectObserver(observer: MutationObserver | null) {
    try {
      observer?.disconnect();
    } catch {
      // Ignore an observer from a closed window.
    }
  }

  updateItem(tabID: string, win: Window, parentItemID: number) {
    try {
      const item = Zotero.Items.get(parentItemID);
      if (!item) return;

      const document = win.document;
      const contextPaneElement = document.querySelector("context-pane") as any;
      const itemPaneDeck = contextPaneElement?._itemPaneDeck;
      if (!itemPaneDeck) return;

      let itemDetails = itemPaneDeck.querySelector(
        `[data-tab-id="${tabID}"]`,
      ) as any;
      if (itemDetails) {
        itemDetails.item = item;
        if (typeof itemDetails.render === "function") itemDetails.render();
      } else {
        itemDetails = document.createXULElement("item-details");
        itemDetails.id = tabID + "-context";
        itemDetails.dataset.tabId = tabID;
        itemDetails.className = "zotero-item-pane-content";
        itemPaneDeck.appendChild(itemDetails);

        const library = Zotero.Libraries.get(item.libraryID);
        itemDetails.editable = library && library.editable && !item.deleted;
        itemDetails.tabID = tabID;
        itemDetails.tabType = "reader";
        itemDetails.item = item;
        if (contextPaneElement._sidenav) {
          itemDetails.sidenav = contextPaneElement._sidenav;
        }
      }
      itemPaneDeck.selectedPanel = itemDetails;
    } catch {
      // Ignore errors while Zotero rebuilds the context pane.
    }
  }

  showForSplitView(win: Window) {
    const document = win.document;
    const contextPane = (win as any).ZoteroContextPane;
    if (!contextPane) return;

    if (contextPane.splitter) {
      contextPane.splitter.setAttribute("hidden", "false");
    }
    if (contextPane.sidenav) {
      contextPane.sidenav.hidden = false;
      contextPane.sidenav.removeAttribute("hidden");
      contextPane.sidenav.style.display = "";
      contextPane.sidenav.style.visibility = "visible";
    }

    const sidenav = document.getElementById(
      "zotero-context-pane-sidenav",
    ) as HTMLElement | null;
    if (sidenav) {
      (sidenav as any).hidden = false;
      sidenav.removeAttribute("hidden");
    }
    document.getElementById("zotero-context-pane")?.removeAttribute("hidden");
    this.injectSidenavCSS(document);
  }

  private injectSidenavCSS(document: Document) {
    const styleId = "split-view-sidenav-style";
    if (document.getElementById(styleId)) {
      document.documentElement?.classList.add("split-view-active");
      return;
    }

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      /* Preserve the native collapsed state while exposing the split sidenav. */
      :root.split-view-active #zotero-context-pane:not([collapsed="true"]) {
        display: flex !important;
        flex-direction: row !important;
        flex-grow: 0 !important;
        flex-shrink: 0 !important;
      }
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
      :root.split-view-active #zotero-context-splitter[state="open"] {
        display: flex !important;
        visibility: visible !important;
      }
      body.split-view-dragging,
      body.split-view-dragging * {
        cursor: ew-resize !important;
        user-select: none !important;
      }
    `;
    (document.head || document.documentElement)?.appendChild(style);
    document.documentElement?.classList.add("split-view-active");
  }
}

export const contextPane = new ContextPaneAdapter();
