import { readerRuntime } from "./readerRuntime";

export class ReaderScrollbarAdapter {
  setPrimaryColor(
    browser: XULBrowserElement,
    color: { red: number; green: number; blue: number } | null,
  ): void {
    try {
      if (!browser || !browser.contentWindow) return;
      if (
        Components.utils.isDeadWrapper(browser) ||
        Components.utils.isDeadWrapper(browser.contentWindow)
      )
        return;

      const internalReader =
        readerRuntime.getInternalReaderFromBrowser(browser);
      const primaryView = internalReader?._primaryView;
      const iframe = primaryView?._iframe;
      if (!iframe || Components.utils.isDeadWrapper(iframe)) return;

      const iframeWin = iframe.contentWindow;
      if (!iframeWin || Components.utils.isDeadWrapper(iframeWin)) return;

      const wrappedWin = (iframeWin as any).wrappedJSObject || iframeWin;
      if (Components.utils.isDeadWrapper(wrappedWin)) return;

      const document = wrappedWin.document;
      if (!document || Components.utils.isDeadWrapper(document)) return;

      const styleID = "split-view-scrollbar-style";
      const existingStyle = document.getElementById(styleID);
      if (!color) {
        if (existingStyle && !Components.utils.isDeadWrapper(existingStyle))
          existingStyle.remove();
        return;
      }

      const cssContent = `
        #viewerContainer {
          scrollbar-color: rgba(${color.red}, ${color.green}, ${color.blue}, 0.6) #f0f0f0 !important;
        }
      `;
      if (
        existingStyle &&
        !Components.utils.isDeadWrapper(existingStyle) &&
        existingStyle.textContent === cssContent
      )
        return;

      if (existingStyle && !Components.utils.isDeadWrapper(existingStyle))
        existingStyle.remove();

      const style = document.createElement("style");
      style.id = styleID;
      style.textContent = cssContent;
      if (document.head && !Components.utils.isDeadWrapper(document.head)) {
        document.head.appendChild(style);
      } else if (
        document.documentElement &&
        !Components.utils.isDeadWrapper(document.documentElement)
      ) {
        document.documentElement.appendChild(style);
      }
    } catch (error) {
      Zotero.debug(`Split view: set reader scrollbar color failed: ${error}`);
    }
  }
}

export const readerScrollbar = new ReaderScrollbarAdapter();
