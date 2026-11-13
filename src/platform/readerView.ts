import { readerRuntime } from "./readerRuntime";
function getPdfViewerFromReader(internalReader: any): any {
  try {
    const primaryView = internalReader?._primaryView;
    if (!primaryView) return null;

    const iframe = primaryView._iframe;
    if (!iframe) return null;

    const iframeWin = iframe.contentWindow;
    if (!iframeWin) return null;

    const wrappedWin = (iframeWin as any).wrappedJSObject || iframeWin;
    return wrappedWin.PDFViewerApplication?.pdfViewer || null;
  } catch (e) {
    Zotero.debug(`Split view: getPdfViewerFromReader error: ${e}`);
    return null;
  }
}

async function getViewStateFromReader(reader: any): Promise<any> {
  try {
    const internal = reader?._internalReader || reader;
    const cached = internal?._state?.primaryViewState;
    const visible = getImmediateViewStateFromReader(reader);
    if (cached || visible) {
      return {
        ...(cached ? JSON.parse(JSON.stringify(cached)) : {}),
        ...visible,
      };
    }
    if (typeof reader?._getState === "function")
      return await reader._getState();
  } catch (error) {
    Zotero.debug(`Split view: getViewStateFromReader failed: ${error}`);
  }
  return null;
}

function getImmediateViewStateFromBrowser(browser: XULBrowserElement): any {
  try {
    const internalReader = readerRuntime.getInternalReaderFromBrowser(browser);
    return getImmediateViewStateFromReader(internalReader);
  } catch {
    // Ignore errors and let callers fall back to cached state
  }
  return null;
}

function getImmediateViewStateFromReader(reader: any): any {
  try {
    const internalReader = reader?._internalReader || reader;
    const primaryView = internalReader?._primaryView;
    const iframeWindow = primaryView?._iframeWindow;
    const pdfViewer = iframeWindow?.PDFViewerApplication?.pdfViewer;
    if (!pdfViewer) return null;

    const location = pdfViewer._location;
    if (!location) return null;

    const viewState: Record<string, any> = {
      pageIndex: Math.max(0, (location.pageNumber || 1) - 1),
      scale:
        location.scale !== undefined
          ? location.scale
          : pdfViewer.currentScaleValue,
      scrollMode: pdfViewer.scrollMode,
      spreadMode: pdfViewer.spreadMode,
    };
    if (location.top !== undefined) {
      viewState.top = location.top;
    }
    if (location.left !== undefined) {
      viewState.left = location.left;
    }
    return viewState;
  } catch {
    // Ignore errors and let callers fall back to cached state
  }
  return null;
}

function getCurrentViewStateFromBrowser(browser: XULBrowserElement): any {
  try {
    const internalReader = readerRuntime.getInternalReaderFromBrowser(browser);
    if (internalReader?._state?.primaryViewState) {
      return JSON.parse(JSON.stringify(internalReader._state.primaryViewState));
    }
  } catch {
    // Ignore errors
  }
  return null;
}

async function applyViewStateToReader(
  reader: any,
  viewState: any,
): Promise<{
  pageIndexClamped: boolean;
  requestedPageIndex: number;
  appliedPageIndex: number;
} | null> {
  if (!reader || !viewState) return null;

  try {
    const internalReader = reader._internalReader || reader;
    const targetPrimaryView = internalReader?._primaryView;
    if (!targetPrimaryView?._setState) return null;

    const pdfViewer = getPdfViewerFromReader(internalReader);
    const statsPagesCount =
      internalReader?._state?.primaryViewStats?.pagesCount;
    const requestedPageIndex = Math.max(0, viewState.pageIndex ?? 0);
    let pageIndex = requestedPageIndex;
    let pageIndexClamped = false;

    const pagesCount = pdfViewer?.pagesCount ?? statsPagesCount;
    if (Number.isInteger(pagesCount) && pagesCount > 0) {
      const maxPageIndex = pagesCount - 1;
      if (pageIndex > maxPageIndex) {
        pageIndex = maxPageIndex;
        pageIndexClamped = true;
      }
    }

    const stateToApply: Record<string, any> = {
      pageIndex,
      scale: viewState.scale,
    };
    if (!pageIndexClamped && viewState.top !== undefined) {
      stateToApply.top = viewState.top;
    }
    if (!pageIndexClamped && viewState.left !== undefined) {
      stateToApply.left = viewState.left;
    }
    if (Number.isInteger(viewState.scrollMode)) {
      stateToApply.scrollMode = viewState.scrollMode;
    }
    if (Number.isInteger(viewState.spreadMode)) {
      stateToApply.spreadMode = viewState.spreadMode;
    }

    let clonedState = stateToApply;
    try {
      const targetWin =
        targetPrimaryView._iframeWindow ||
        internalReader?._iframeWindow ||
        reader._iframeWindow ||
        null;
      if (targetWin) {
        clonedState = Components.utils.cloneInto(stateToApply, targetWin, {
          wrapReflectors: true,
        });
      }
    } catch (e) {
      Zotero.debug(`Split view: applyViewStateToReader cloneInto failed: ${e}`);
    }

    if (pageIndexClamped) {
      Zotero.debug(
        `Split view: clamped pageIndex ${requestedPageIndex} to ${pageIndex}`,
      );
    }

    await targetPrimaryView._setState(clonedState);
    pdfViewer?.update?.();
    const appliedViewState = getImmediateViewStateFromReader(internalReader);
    const appliedPageIndex = Math.max(
      0,
      appliedViewState?.pageIndex ?? pageIndex,
    );
    return {
      pageIndexClamped:
        pageIndexClamped || appliedPageIndex !== requestedPageIndex,
      requestedPageIndex,
      appliedPageIndex,
    };
  } catch (e) {
    Zotero.debug(`Split view: applyViewStateToReader failed: ${e}`);
  }
  return null;
}

function getViewerContainerFromBrowser(
  browser: XULBrowserElement,
): Element | null {
  try {
    const internalReader = readerRuntime.getInternalReaderFromBrowser(browser);
    if (!internalReader) return null;

    const primaryView = internalReader._primaryView;
    if (!primaryView) return null;

    const iframe = primaryView._iframe;
    if (!iframe) return null;

    const iframeWin = iframe.contentWindow;
    if (!iframeWin) return null;

    const wrappedWin = (iframeWin as any).wrappedJSObject || iframeWin;
    return wrappedWin.document?.getElementById("viewerContainer") || null;
  } catch (e) {
    Zotero.debug(`Split view: getViewerContainerFromBrowser error: ${e}`);
    return null;
  }
}

export const readerView = {
  getPdfViewerFromReader,
  getViewStateFromReader,
  getImmediateViewStateFromBrowser,
  getImmediateViewStateFromReader,
  getCurrentViewStateFromBrowser,
  applyViewStateToReader,
  getViewerContainerFromBrowser,
};
