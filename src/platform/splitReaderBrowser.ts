export type SplitSide = "left" | "right";

interface TrackedBrowserListener {
  target: EventTarget;
  type: string;
  listener: EventListener;
  options?: boolean | AddEventListenerOptions;
}

interface SplitReaderBrowserState {
  leftBrowser: XULBrowserElement;
  rightBrowser: XULBrowserElement;
  disposeAnnotations?: () => void;
  eventListeners: TrackedBrowserListener[];
}

export interface SplitReaderBrowserDependencies {
  getState(tabID: string): SplitReaderBrowserState | null;
  getReaderForBrowser(browser: XULBrowserElement): any;
  closeReader(reader: any): Promise<void>;
  clearReadAloudSide(state: SplitReaderBrowserState, side: SplitSide): void;
}

export class SplitReaderBrowserAdapter {
  constructor(private readonly deps: SplitReaderBrowserDependencies) {}

  async replace(
    tabID: string,
    side: SplitSide,
  ): Promise<XULBrowserElement | null> {
    const state = this.deps.getState(tabID);
    if (!state) return null;

    const oldBrowser = side === "left" ? state.leftBrowser : state.rightBrowser;
    const container = oldBrowser.parentNode;
    if (!container) return null;

    state.disposeAnnotations?.();
    state.disposeAnnotations = undefined;

    const oldReader = this.deps.getReaderForBrowser(oldBrowser);
    if (oldReader) await this.deps.closeReader(oldReader);
    this.deps.clearReadAloudSide(state, side);

    const doc = oldBrowser.ownerDocument;
    if (!doc) return null;
    const newBrowser = doc.createXULElement("browser") as XULBrowserElement;
    newBrowser.setAttribute("type", "content");
    newBrowser.setAttribute("transparent", "true");
    newBrowser.setAttribute("src", "resource://zotero/reader/reader.html");
    newBrowser.className = oldBrowser.className;

    const oldStyle = (oldBrowser as any).style;
    const newStyle = (newBrowser as any).style;
    for (const property of [
      "flex",
      "minWidth",
      "maxWidth",
      "overflow",
      "boxSizing",
    ])
      newStyle[property] = oldStyle[property];

    state.eventListeners = state.eventListeners.filter((entry) => {
      if (entry.target !== oldBrowser) return true;
      try {
        entry.target.removeEventListener(
          entry.type,
          entry.listener,
          entry.options,
        );
      } catch {
        // The replaced browser may already be dead.
      }
      return false;
    });

    container.replaceChild(newBrowser, oldBrowser);
    if (side === "left") state.leftBrowser = newBrowser;
    else state.rightBrowser = newBrowser;
    return newBrowser;
  }
}
