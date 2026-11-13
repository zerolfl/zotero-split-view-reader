function waitForBrowserLoad(browser: XULBrowserElement): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = 200; // 20 seconds max

    const check = () => {
      attempts++;
      try {
        const win = browser.contentWindow;
        if (win && win.document && win.document.readyState === "complete") {
          // Check if createReader function exists
          const wrappedWin = (win as any).wrappedJSObject || win;
          if (typeof wrappedWin.createReader === "function") {
            resolve();
            return;
          }
        }
      } catch {
        // Ignore errors during check
      }

      if (attempts >= maxAttempts) {
        reject(new Error("Timeout waiting for browser to load"));
        return;
      }

      setTimeout(check, 100);
    };

    check();
  });
}

async function waitForInternalReader(
  browser: XULBrowserElement,
): Promise<void> {
  const maxAttempts = 100;
  let attempts = 0;

  // First, wait for _primaryView to exist
  while (attempts < maxAttempts) {
    attempts++;
    try {
      const internalReader = getInternalReaderFromBrowser(browser);
      if (internalReader && internalReader._primaryView) {
        // Found _primaryView, now wait for it to fully initialize
        // This ensures the PDF.js viewer iframe is loaded and pdfjsLib is available
        if (internalReader._primaryView.initializedPromise) {
          try {
            await internalReader._primaryView.initializedPromise;
          } catch (e) {
            Zotero.debug(`Split view: primaryView initialization failed: ${e}`);
            // Continue anyway, the view might still be usable
          }
        }
        return;
      }
    } catch {
      // Ignore errors during check
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timeout waiting for internal reader");
}

function getInternalReaderFromBrowser(browser: XULBrowserElement): any {
  if (!isBrowserAlive(browser)) return null;
  try {
    const win = browser.contentWindow;
    if (!win) return null;
    const wrappedWin = (win as any).wrappedJSObject || win;
    return wrappedWin._reader || null;
  } catch (e) {
    Zotero.debug(`Split view: getInternalReaderFromBrowser error: ${e}`);
    return null;
  }
}

function isBrowserAlive(browser: XULBrowserElement): boolean {
  try {
    // Try to access a property - this will throw if the object is dead
    const _test = browser.contentWindow;
    return true;
  } catch {
    return false;
  }
}

function unloadBrowser(browser: XULBrowserElement): void {
  try {
    if (isBrowserAlive(browser)) {
      browser.setAttribute("src", "about:blank");
    }
  } catch {
    // Ignore errors
  }
}

async function closeReaderWithoutClosingTab(reader: any): Promise<void> {
  try {
    const win = reader._window;

    // 1. Remove window-level event listeners FIRST
    if (win) {
      try {
        if (reader._handleLoad) {
          win.removeEventListener("DOMContentLoaded", reader._handleLoad);
        }
        if (reader._handlePointerDown) {
          win.removeEventListener("pointerdown", reader._handlePointerDown);
        }
        if (reader._handlePointerUp) {
          win.removeEventListener("pointerup", reader._handlePointerUp);
        }
      } catch (e) {
        Zotero.debug(
          `Split view: closeReader - removeEventListener failed: ${e}`,
        );
      }
    }

    // 2. Call uninit() to flush state to disk and clean up observers
    if (typeof reader.uninit === "function") {
      try {
        reader.uninit();
      } catch (e) {
        Zotero.debug(`Split view: closeReader - uninit failed: ${e}`);
      }
    }

    // 3. Now unload the reader's iframe
    if (reader._iframe) {
      unloadBrowser(reader._iframe);
      // Wait a bit for pending callbacks to complete
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // 4. Clear internal references AFTER uninit and unload
    try {
      reader._internalReader = null;
      reader._iframeWindow = null;
    } catch (e) {
      Zotero.debug(`Split view: closeReader - clear refs failed: ${e}`);
    }

    // 5. Remove from Zotero.Reader._readers array
    const readers = (Zotero.Reader as any)._readers;
    const index = readers.indexOf(reader);
    if (index !== -1) {
      readers.splice(index, 1);
    }
  } catch (e) {
    Zotero.debug(`Split view: closeReaderWithoutClosingTab failed: ${e}`);
  }
}

async function waitForReaderReady(
  reader: any,
  maxWaitMs = 10000,
): Promise<void> {
  let timeoutID: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutID = setTimeout(() => reject(new Error("timeout")), maxWaitMs);
  });

  try {
    // Method 1: Use _initPromise if available (most reliable for basic init)
    await Promise.race([reader._initPromise, timeoutPromise]);

    // Method 2: Wait for _internalReader._primaryView.initializedPromise
    // This is the pattern Zotero uses internally (see reader.js line 2039-2053)
    const pollInterval = 10;
    let attempts = 0;
    const maxAttempts = maxWaitMs / pollInterval;

    while (!reader._internalReader?._primaryView?._iframeWindow) {
      if (attempts >= maxAttempts) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      attempts++;
    }

    // Wait for the primary view's initialized promise if available
    if (reader._internalReader?._primaryView?.initializedPromise) {
      await Promise.race([
        reader._internalReader._primaryView.initializedPromise,
        timeoutPromise,
      ]);
    }
  } catch {
    // The reader may still be usable after a failed optional initialization.
  } finally {
    clearTimeout(timeoutID);
  }
}

function getInitializationPromise(reader: any): Promise<void> | null {
  return reader?._initPromise || null;
}

function getReaderForBrowser(browser: XULBrowserElement): any {
  try {
    const readers = (Zotero.Reader as any)._readers;
    if (!readers || !Array.isArray(readers)) return null;
    return readers.find((r: any) => r._iframe === browser) || null;
  } catch {
    return null;
  }
}

export const readerRuntime = {
  waitForBrowserLoad,
  waitForInternalReader,
  getInternalReaderFromBrowser,
  isBrowserAlive,
  unloadBrowser,
  closeReaderWithoutClosingTab,
  waitForReaderReady,
  getInitializationPromise,
  getReaderForBrowser,
};
