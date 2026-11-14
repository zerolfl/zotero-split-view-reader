interface TrackedTabListener {
  target: EventTarget;
  type: string;
  listener: EventListener;
}

interface SplitReaderTabState {
  leftBrowser: XULBrowserElement;
  rightBrowser: XULBrowserElement;
  isCleaningUp: boolean;
}

export interface SplitReaderTabShell {
  container: HTMLElement;
  mainHbox: XULElement;
  leftBrowser: XULBrowserElement;
  rightBrowser: XULBrowserElement;
  resizer: XULElement;
  leftPopupset: XULElement;
  rightPopupset: XULElement;
  eventListeners: TrackedTabListener[];
}

export interface SplitReaderTabDependencies {
  getState(tabID: string): SplitReaderTabState | null;
  getInternalReader(browser: XULBrowserElement): any;
  setContextPaneOpen(browser: XULBrowserElement, open: boolean): void;
}

export class SplitReaderTabAdapter {
  constructor(private readonly deps: SplitReaderTabDependencies) {}

  getTabContainer(win: Window, tabID: string): Element | null {
    return win.document.getElementById(tabID);
  }

  create(
    win: Window,
    tabID: string,
    oldContainer: Element,
  ): SplitReaderTabShell {
    // Cloning drops the closed reader's listeners from the original tab content.
    const container = oldContainer.cloneNode(false) as HTMLElement;
    oldContainer.parentNode?.replaceChild(container, oldContainer);

    // Restore TabContent methods that Zotero calls on the cloned container.
    (container as any).setContextPaneOpen = (open: boolean) => {
      container.dispatchEvent(
        new win.CustomEvent("tab-context-pane-toggle", { detail: { open } }),
      );
    };
    (container as any).setBottomPlaceholderHeight = (height: number) => {
      container.dispatchEvent(
        new win.CustomEvent("tab-bottom-placeholder-resize", {
          detail: { height },
        }),
      );
    };
    (container as any).onTabSelectionChanged = (selected: boolean) => {
      container.dispatchEvent(
        new win.CustomEvent("tab-selection-change", { detail: { selected } }),
      );
    };

    Object.assign((container as any).style, {
      display: "flex",
      flexDirection: "row",
      width: "100%",
      height: "100%",
      overflow: "hidden",
    });

    const mainHbox = win.document.createXULElement("hbox") as XULElement;
    Object.assign((mainHbox as any).style, {
      display: "flex",
      flexDirection: "row",
      flex: "1 1 100%",
      width: "100%",
      height: "100%",
      minWidth: "0",
      overflow: "hidden",
      boxSizing: "border-box",
    });

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
    container.appendChild(mainHbox);
    container.appendChild(leftPopupset);
    container.appendChild(rightPopupset);

    const eventListeners: TrackedTabListener[] = [];
    const listen = (type: string, listener: EventListener) => {
      container.addEventListener(type, listener);
      eventListeners.push({ target: container, type, listener });
    };
    listen("tab-bottom-placeholder-resize", (event) => {
      const state = this.deps.getState(tabID);
      if (!state || state.isCleaningUp) return;
      const detail = (event as CustomEvent<{ height?: number }>).detail;
      const height = detail?.height !== undefined ? detail.height : null;
      try {
        for (const browser of [state.leftBrowser, state.rightBrowser]) {
          const reader = this.deps.getInternalReader(browser);
          reader?.setBottomPlaceholderHeight?.(height);
        }
      } catch {
        // Readers may not be ready when Zotero updates the placeholder.
      }
    });
    listen("tab-context-pane-toggle", (event) => {
      const state = this.deps.getState(tabID);
      if (!state || state.isCleaningUp) return;
      const open =
        (event as CustomEvent<{ open?: boolean }>).detail?.open ?? false;
      this.deps.setContextPaneOpen(state.rightBrowser, open);
    });
    listen("tab-selection-change", () => {
      // Split tabs do not need additional selection handling.
    });

    return {
      container,
      mainHbox,
      leftBrowser,
      rightBrowser,
      resizer,
      leftPopupset,
      rightPopupset,
      eventListeners,
    };
  }

  private createReaderBrowser(win: Window): XULBrowserElement {
    const browser = win.document.createXULElement("browser");
    browser.setAttribute("type", "content");
    browser.setAttribute("transparent", "true");
    browser.setAttribute("src", "resource://zotero/reader/reader.html");
    (browser as any).style.flex = "1 1 0";
    (browser as any).style.minWidth = "200px";
    (browser as any).style.maxWidth = "none";
    (browser as any).style.overflow = "hidden";
    (browser as any).style.boxSizing = "border-box";
    return browser as XULBrowserElement;
  }
}
