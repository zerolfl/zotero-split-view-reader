import { getString } from "../utils/locale";

/**
 * Multi-PDF Split View using dual ReaderWindows with sync support.
 *
 * Features:
 * 1. Opens two independent ReaderWindow instances (each has full annotation support)
 * 2. Automatically positions windows side-by-side
 * 3. Bidirectional scroll/page sync (toggle via context menu)
 * 4. Each window has complete Zotero reader functionality
 */

interface SplitViewState {
  leftWindow: Window | null;
  rightWindow: Window | null;
  leftReader: any;
  rightReader: any;
  leftItemID: number;
  rightItemID: number;
  syncEnabled: boolean;
  primarySide: "left" | "right"; // Which side is the primary (controller)
  syncInterval: ReturnType<typeof setInterval> | null;
  scrollHandler: (() => void) | null; // Scroll event handler reference
  // Last known primary scroll position for incremental sync
  lastPrimaryScroll: { top: number; left: number } | null;
  // Zoom sync - last synced zoom level
  lastSyncedZoom: number | null;
}

export class SplitViewFactory {
  private static state: SplitViewState | null = null;

  /**
   * Check if a reader object is valid (not a dead object)
   */
  private static isReaderValid(reader: any): boolean {
    try {
      // Try accessing multiple properties - will throw if dead object
      const _ = reader.itemID;
      // Also check if reader has a valid window/tab
      if (reader._window) {
        // ReaderWindow - check if window is not closed
        if (reader._window.closed) {
          return false;
        }
      }
      // Try accessing internal reader to ensure it's not partially dead
      if (reader._internalReader) {
        const __ = reader._internalReader._primaryView;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the currently active reader from Zotero
   * Prioritizes tab readers over window readers, and finds valid non-closed readers
   */
  private static getCurrentReader(): any {
    try {
      const readers = (Zotero.Reader as any)._readers || [];
      // First pass: find a valid tab reader (preferred as it's in main window)
      for (const r of readers) {
        if (this.isReaderValid(r) && r.tabID) {
          return r;
        }
      }
      // Second pass: find any valid reader
      for (const r of readers) {
        if (this.isReaderValid(r)) {
          return r;
        }
      }
    } catch (e) {
      ztoolkit.log("SplitView: Error getting current reader", e);
    }
    return null;
  }

  static registerContextMenu() {
    // Register menu item in PDF reader context menu
    Zotero.Reader.registerEventListener(
      "createViewContextMenu",
      (event) => {
        const { reader, append } = event;

        // Check if this reader is part of an active split view
        const currentSide = this.getReaderSide(reader as any);
        const isInSplitView = currentSide !== null;

        // Build menu items array - all items in one append() call to avoid separators
        const menuItems: any[] = [];

        // First item: "Split-View Reader" with native checked property
        menuItems.push({
          label: getString("splitview-menu-label"),
          checked: isInSplitView,
          onCommand: () => {
            try {
              // Re-check reader validity and state at click time (not menu creation time)
              let activeReader = reader;
              if (!this.isReaderValid(reader)) {
                // Reader is dead, try to get a valid current reader
                activeReader = this.getCurrentReader();
                if (!activeReader) {
                  ztoolkit.log("SplitView: No valid reader found");
                  return;
                }
              }

              // Re-calculate current state at click time
              const currentSide = this.getReaderSide(activeReader);
              if (currentSide !== null) {
                // Close split view
                this.closeSplitView();
              } else {
                this.handleSplitView(activeReader);
              }
            } catch (e) {
              ztoolkit.log("SplitView: Error in menu command", e);
              // Try to cleanup if there's an error
              this.cleanup();
            }
          },
        });

        // If we have an active split view with this reader, add additional options
        if (isInSplitView && this.state) {
          // Second item: "Primary Window" with 📌 if this is primary
          const isPrimary = this.state.primarySide === currentSide;
          menuItems.push({
            label: (isPrimary ? "📌 " : "") + getString("splitview-set-primary"),
            onCommand: () => {
              this.setPrimarySide(currentSide);
            },
          });

          // Third item: "Scroll Sync" with 📌 if enabled
          menuItems.push({
            label: (this.state.syncEnabled ? "📌 " : "") + getString("splitview-sync-scroll"),
            onCommand: () => {
              this.toggleSync();
            },
          });
        }

        // Append all items in one call to keep them grouped (no separators)
        // Use spread syntax to pass multiple items as separate arguments
        (append as any)(...menuItems);
      },
      addon.data.config.addonID,
    );
  }

  /**
   * Determine which side (left/right) a reader belongs to
   */
  private static getReaderSide(reader: any): "left" | "right" | null {
    if (!this.state) return null;

    // Check if reader is valid first
    if (!this.isReaderValid(reader)) {
      return null;
    }

    try {
      // Check if windows are still valid (not dead objects)
      if (!this.state.leftWindow || this.state.leftWindow.closed) {
        if (!this.state.rightWindow || this.state.rightWindow.closed) {
          // Both windows are closed/invalid, cleanup
          this.cleanup();
          return null;
        }
      }

      // Compare by itemID
      if (reader.itemID === this.state.leftItemID) {
        return "left";
      }
      if (reader.itemID === this.state.rightItemID) {
        return "right";
      }

      // Also try comparing reader objects directly
      if (reader === this.state.leftReader) {
        return "left";
      }
      if (reader === this.state.rightReader) {
        return "right";
      }
    } catch (e) {
      // Dead object error, cleanup
      this.cleanup();
      return null;
    }

    return null;
  }

  /**
   * Set which side is the primary (controller) window
   */
  private static setPrimarySide(side: "left" | "right") {
    if (!this.state) return;

    this.state.primarySide = side;

    // Show notification
    const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
    })
      .createLine({
        text: getString("splitview-primary-set"),
        type: "default",
      })
      .show();
    popup.startCloseTimer(2000);
  }

  private static async handleSplitView(reader: any) {
    try {
      // First validate reader
      if (!this.isReaderValid(reader)) {
        ztoolkit.log("SplitView: Invalid reader, cannot open split view");
        return;
      }

      // Clean up any stale state first
      if (this.state) {
        try {
          // Check if windows are still valid
          const leftValid = this.state.leftWindow && !this.state.leftWindow.closed;
          const rightValid = this.state.rightWindow && !this.state.rightWindow.closed;
          if (!leftValid && !rightValid) {
            this.cleanup();
          }
        } catch (e) {
          // Dead object, cleanup
          this.cleanup();
        }
      }

      const selectedPDF = await this.showItemPrompt(reader);
      if (!selectedPDF) return;

      await this.openDualWindows(reader, selectedPDF);
    } catch (e) {
      ztoolkit.log("SplitView: Error in handleSplitView", e);
      // Cleanup on error
      this.cleanup();
    }
  }

  /**
   * Toggle scroll/page sync
   */
  private static toggleSync() {
    if (!this.state) return;

    this.state.syncEnabled = !this.state.syncEnabled;

    if (this.state.syncEnabled) {
      // Initialize sync state when enabling
      this.initSyncState();
      this.startSyncPolling();
    } else {
      this.stopSyncPolling();
      // Clear sync state
      this.state.lastPrimaryScroll = null;
    }

    // Show notification
    const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
    })
      .createLine({
        text: this.state.syncEnabled
          ? getString("splitview-sync-enabled")
          : getString("splitview-sync-disabled"),
        type: "default",
      })
      .show();
    popup.startCloseTimer(2000);
  }

  /**
   * Initialize sync state - record primary's current position and sync zoom
   */
  private static initSyncState() {
    if (!this.state) return;

    const primaryReader = this.state.primarySide === "left"
      ? this.state.leftReader
      : this.state.rightReader;
    const secondaryReader = this.state.primarySide === "left"
      ? this.state.rightReader
      : this.state.leftReader;

    // Get primary container and record its current scroll position
    const primaryContainer = this.getViewerContainerFromReader(primaryReader);
    if (primaryContainer) {
      this.state.lastPrimaryScroll = {
        top: primaryContainer.scrollTop,
        left: primaryContainer.scrollLeft,
      };
    }

    // Sync zoom immediately (zoom is absolute, not relative like scroll)
    const primaryZoom = this.getZoomLevel(primaryReader);
    if (primaryZoom !== null) {
      this.setZoomLevel(secondaryReader, primaryZoom);
      this.state.lastSyncedZoom = primaryZoom;
    }

    ztoolkit.log("SplitView: Sync initialized",
      "lastPrimaryScroll:", this.state.lastPrimaryScroll,
      "zoom:", this.state.lastSyncedZoom);
  }

  /**
   * Open two ReaderWindows side by side
   */
  private static async openDualWindows(reader: any, secondaryPDF: Zotero.Item) {
    const primaryItemID = reader.itemID;

    // Clean up existing state
    this.cleanup();

    // Get screen dimensions for positioning
    const mainWindow = Zotero.getMainWindow();
    const screenWidth = mainWindow.screen.availWidth;
    const screenHeight = mainWindow.screen.availHeight;
    const screenLeft = mainWindow.screen.availLeft || 0;
    const screenTop = mainWindow.screen.availTop || 0;

    const windowWidth = Math.floor(screenWidth / 2);
    const windowHeight = screenHeight;

    // Initialize state - left window (original PDF) is primary by default, sync enabled by default
    this.state = {
      leftWindow: null,
      rightWindow: null,
      leftReader: null,
      rightReader: null,
      leftItemID: primaryItemID,
      rightItemID: secondaryPDF.id,
      syncEnabled: true,
      primarySide: "left",
      syncInterval: null,
      scrollHandler: null,
      lastPrimaryScroll: null,
      lastSyncedZoom: null,
    };

    // Open first (left) window
    const leftReader = await Zotero.Reader.open(primaryItemID, undefined, {
      openInWindow: true,
    });

    // Open second (right) window
    const rightReader = await Zotero.Reader.open(secondaryPDF.id, undefined, {
      openInWindow: true,
    });

    // Wait for windows to be created and PDF to load
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Get window references
    let leftWindow = this.getReaderWindow(leftReader);
    let rightWindow = this.getReaderWindow(rightReader);

    // If windows not found, try to find them from Zotero.Reader._readers
    if (!leftWindow || !rightWindow) {
      const readers = (Zotero.Reader as any)._readers || [];

      for (const r of readers) {
        if (r.itemID === primaryItemID && !leftWindow) {
          leftWindow = this.getReaderWindow(r);
          this.state.leftReader = r;
        }
        if (r.itemID === secondaryPDF.id && !rightWindow) {
          rightWindow = this.getReaderWindow(r);
          this.state.rightReader = r;
        }
      }
    }

    if (leftWindow) {
      leftWindow.resizeTo(windowWidth, windowHeight);
      leftWindow.moveTo(screenLeft, screenTop);
      this.state.leftWindow = leftWindow;
      this.state.leftReader = leftReader;

      // Monitor window close
      leftWindow.addEventListener("unload", () => this.onWindowClosed("left"));
    }

    if (rightWindow) {
      rightWindow.resizeTo(windowWidth, windowHeight);
      rightWindow.moveTo(screenLeft + windowWidth, screenTop);
      this.state.rightWindow = rightWindow;
      this.state.rightReader = rightReader;

      // Monitor window close
      rightWindow.addEventListener("unload", () =>
        this.onWindowClosed("right"),
      );
    }

    // Show success notification
    const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
    })
      .createLine({
        text: getString("splitview-loaded"),
        type: "default",
      })
      .show();
    popup.startCloseTimer(3000);

    // Enable sync by default - initialize sync state and start polling
    // Use a short delay to ensure PDF viewers are fully loaded
    setTimeout(() => {
      if (this.state && this.state.syncEnabled) {
        this.initSyncState();
        this.startSyncPolling();
        ztoolkit.log("SplitView: Sync enabled by default");
      }
    }, 500);
  }

  /**
   * Get the window object for a reader
   */
  private static getReaderWindow(reader: any): Window | null {
    try {
      // ReaderWindow has a _window property
      if (reader._window) {
        return reader._window;
      }
      // Or try _iframeWindow for tab readers
      if (reader._iframeWindow) {
        return reader._iframeWindow;
      }
      // Check internal reader
      const internalReader = reader._internalReader;
      if (internalReader?._iframeWindow) {
        return internalReader._iframeWindow;
      }
      // For ReaderWindow, the window itself
      if (reader.window) {
        return reader.window;
      }
    } catch (e) {
      ztoolkit.log("SplitView: Error getting reader window", e);
    }
    return null;
  }

  /**
   * Handle window close event
   */
  private static onWindowClosed(side: "left" | "right") {
    if (!this.state) return;

    ztoolkit.log(`SplitView: ${side} window closed`);

    if (side === "left") {
      this.state.leftWindow = null;
      this.state.leftReader = null;
    } else {
      this.state.rightWindow = null;
      this.state.rightReader = null;
    }

    // If both windows are closed, cleanup
    if (!this.state.leftWindow && !this.state.rightWindow) {
      this.cleanup();
    }
  }

  /**
   * Close split view and both windows
   */
  private static closeSplitView() {
    if (!this.state) return;

    ztoolkit.log("SplitView: Closing split view");

    // Save reader references before cleanup
    const leftReader = this.state.leftReader;
    const rightReader = this.state.rightReader;

    // Cleanup state before closing readers
    this.cleanup();

    // Close readers properly using Zotero's API
    // This ensures readers are removed from _readers array and state is flushed
    try {
      if (leftReader && typeof leftReader.close === "function") {
        leftReader.close();
      }
    } catch (e) {
      ztoolkit.log("SplitView: Error closing left reader", e);
    }

    try {
      if (rightReader && typeof rightReader.close === "function") {
        rightReader.close();
      }
    } catch (e) {
      ztoolkit.log("SplitView: Error closing right reader", e);
    }

    // Show notification
    const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
    })
      .createLine({
        text: getString("splitview-closed"),
        type: "default",
      })
      .show();
    popup.startCloseTimer(2000);
  }

  /**
   * Start sync - use scroll event listener for smooth, immediate response
   */
  private static startSyncPolling() {
    if (!this.state) return;

    ztoolkit.log("SplitView: Starting scroll sync, primary side:", this.state.primarySide);

    const primaryReader = this.state.primarySide === "left"
      ? this.state.leftReader
      : this.state.rightReader;

    const primaryContainer = this.getViewerContainerFromReader(primaryReader);
    if (!primaryContainer) {
      ztoolkit.log("SplitView: Could not find primary container for scroll listener");
      return;
    }

    // Create scroll handler
    this.state.scrollHandler = () => this.syncViews();

    // Listen to scroll events on primary container
    primaryContainer.addEventListener("scroll", this.state.scrollHandler, { passive: true });

    // Also use a slower interval as backup for zoom sync
    this.state.syncInterval = setInterval(() => {
      this.syncZoomOnly();
    }, 200);
  }

  /**
   * Stop sync
   */
  private static stopSyncPolling() {
    if (!this.state) return;

    // Remove scroll listener
    if (this.state.scrollHandler) {
      const primaryReader = this.state.primarySide === "left"
        ? this.state.leftReader
        : this.state.rightReader;
      const primaryContainer = this.getViewerContainerFromReader(primaryReader);
      if (primaryContainer) {
        primaryContainer.removeEventListener("scroll", this.state.scrollHandler);
      }
      this.state.scrollHandler = null;
    }

    // Clear zoom sync interval
    if (this.state.syncInterval) {
      clearInterval(this.state.syncInterval);
      this.state.syncInterval = null;
    }
  }

  // Minimum delta to trigger sync (pixels) - keep very low for smooth sync
  private static SYNC_THRESHOLD = 1;

  /**
   * Sync scroll position between views using incremental deltas.
   * Called on every scroll event for immediate response.
   */
  private static syncViews() {
    if (!this.state) return;
    if (!this.state.leftReader || !this.state.rightReader) return;
    if (!this.state.lastPrimaryScroll) return;

    try {
      // Primary is the source, secondary is the target
      const primaryReader = this.state.primarySide === "left"
        ? this.state.leftReader
        : this.state.rightReader;
      const secondaryReader = this.state.primarySide === "left"
        ? this.state.rightReader
        : this.state.leftReader;

      // Get containers
      const primaryContainer = this.getViewerContainerFromReader(primaryReader);
      const secondaryContainer = this.getViewerContainerFromReader(secondaryReader);

      if (!primaryContainer || !secondaryContainer) return;

      // Calculate how much primary has moved since last check
      const deltaTop = primaryContainer.scrollTop - this.state.lastPrimaryScroll.top;
      const deltaLeft = primaryContainer.scrollLeft - this.state.lastPrimaryScroll.left;

      // Only sync if primary has moved
      if (Math.abs(deltaTop) >= this.SYNC_THRESHOLD || Math.abs(deltaLeft) >= this.SYNC_THRESHOLD) {
        // Apply delta incrementally to secondary's CURRENT position
        secondaryContainer.scrollTop = Math.max(0, secondaryContainer.scrollTop + deltaTop);
        secondaryContainer.scrollLeft = Math.max(0, secondaryContainer.scrollLeft + deltaLeft);

        // Update last known primary position
        this.state.lastPrimaryScroll = {
          top: primaryContainer.scrollTop,
          left: primaryContainer.scrollLeft,
        };
      }
    } catch (e) {
      // Ignore errors during sync
    }
  }

  /**
   * Sync zoom only (called on interval, separate from scroll sync)
   */
  private static syncZoomOnly() {
    if (!this.state) return;
    if (!this.state.leftReader || !this.state.rightReader) return;

    try {
      const primaryReader = this.state.primarySide === "left"
        ? this.state.leftReader
        : this.state.rightReader;
      const secondaryReader = this.state.primarySide === "left"
        ? this.state.rightReader
        : this.state.leftReader;

      this.syncZoom(primaryReader, secondaryReader);
    } catch (e) {
      // Ignore errors
    }
  }

  // Minimum zoom change to trigger sync
  private static ZOOM_THRESHOLD = 0.01;

  /**
   * Sync zoom level from primary to secondary reader (absolute value sync)
   */
  private static syncZoom(primaryReader: any, secondaryReader: any) {
    if (!this.state) return;

    const primaryZoom = this.getZoomLevel(primaryReader);
    if (primaryZoom === null) return;

    // Check if zoom has changed from last synced value
    if (this.state.lastSyncedZoom !== null &&
        Math.abs(primaryZoom - this.state.lastSyncedZoom) < this.ZOOM_THRESHOLD) {
      return;
    }

    // Apply same zoom level to secondary
    this.setZoomLevel(secondaryReader, primaryZoom);
    this.state.lastSyncedZoom = primaryZoom;
  }

  /**
   * Get the current zoom level from a reader
   */
  private static getZoomLevel(reader: any): number | null {
    try {
      if (!reader) return null;

      const internalReader = reader._internalReader || reader;
      if (!internalReader) return null;

      const primaryView = internalReader._primaryView;
      if (!primaryView) return null;

      const iframe = primaryView._iframe;
      if (!iframe) return null;

      const iframeWin = iframe.contentWindow;
      if (!iframeWin) return null;

      const wrappedWin = iframeWin.wrappedJSObject || iframeWin;
      if (!wrappedWin.document) return null;

      const pdfViewer = wrappedWin.PDFViewerApplication?.pdfViewer;
      if (pdfViewer && typeof pdfViewer.currentScale === "number") {
        return pdfViewer.currentScale;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Set the zoom level for a reader
   */
  private static setZoomLevel(reader: any, scale: number) {
    try {
      if (!reader) return;

      const internalReader = reader._internalReader || reader;
      if (!internalReader) return;

      const primaryView = internalReader._primaryView;
      if (!primaryView) return;

      // Try using Zotero's internal API first
      if (typeof primaryView.setScale === "function") {
        primaryView.setScale(scale);
        return;
      }

      const iframe = primaryView._iframe;
      if (!iframe) return;

      const iframeWin = iframe.contentWindow;
      if (!iframeWin) return;

      const wrappedWin = iframeWin.wrappedJSObject || iframeWin;
      if (!wrappedWin.document) return;

      const pdfViewer = wrappedWin.PDFViewerApplication?.pdfViewer;
      if (pdfViewer && typeof pdfViewer.currentScale === "number") {
        // Use setTimeout to avoid event handling issues
        wrappedWin.setTimeout(() => {
          try {
            pdfViewer.currentScale = scale;
          } catch (e) {
            // Ignore errors during scale setting
          }
        }, 0);
      }
    } catch (e) {
      // Ignore errors
    }
  }

  /**
   * Get the viewer container element from a reader
   * Uses the reader object directly to navigate the structure
   */
  private static getViewerContainerFromReader(reader: any): Element | null {
    try {
      // Get internal reader
      const internalReader = reader._internalReader || reader;

      // Get primary view's iframe
      const primaryView = internalReader._primaryView;
      if (!primaryView) return null;

      const iframe = primaryView._iframe;
      if (!iframe) return null;

      const iframeWin = iframe.contentWindow;
      if (!iframeWin) return null;

      const wrappedWin = iframeWin.wrappedJSObject || iframeWin;
      return wrappedWin.document?.getElementById("viewerContainer") || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get the viewer container element from a reader window (fallback)
   */
  private static getViewerContainer(win: Window): Element | null {
    try {
      // Try to find the PDF viewer container
      // The structure varies depending on whether it's a window or tab reader

      // For ReaderWindow, the PDF is in an iframe
      const iframes = win.document.querySelectorAll("iframe");

      for (const iframe of iframes) {
        const iframeWin = (iframe as any).contentWindow;
        if (iframeWin) {
          const wrappedWin = iframeWin.wrappedJSObject || iframeWin;
          const container = wrappedWin.document?.getElementById(
            "viewerContainer",
          );
          if (container) {
            return container;
          }

          // Try nested iframes (reader structure: window > reader iframe > pdf iframe)
          const nestedIframes = wrappedWin.document?.querySelectorAll("iframe");
          if (nestedIframes) {
            for (const nested of nestedIframes) {
              const nestedWin = (nested as any).contentWindow;
              if (nestedWin) {
                const nestedWrapped = nestedWin.wrappedJSObject || nestedWin;
                const nestedContainer = nestedWrapped.document?.getElementById("viewerContainer");
                if (nestedContainer) {
                  return nestedContainer;
                }
              }
            }
          }
        }
      }

      // Direct lookup
      const container = win.document.getElementById("viewerContainer");
      if (container) return container;

      // Try wrapped JSObject
      const wrappedWin = (win as any).wrappedJSObject || win;
      return wrappedWin.document?.getElementById("viewerContainer");
    } catch (e) {
      return null;
    }
  }

  /**
   * Cleanup state
   */
  private static cleanup() {
    if (!this.state) return;

    this.stopSyncPolling();
    this.state = null;
  }

  // === Methods below are retained for PDF selector UI ===

  /**
   * Get PDF attachment children of a regular item
   */
  private static getPDFAttachments(item: Zotero.Item): Zotero.Item[] {
    const attachmentIDs = item.getAttachments();
    const pdfs: Zotero.Item[] = [];
    for (const aid of attachmentIDs) {
      const att = Zotero.Items.get(aid);
      if (
        att &&
        att.isFileAttachment() &&
        att.attachmentContentType === "application/pdf"
      ) {
        pdfs.push(att);
      }
    }
    return pdfs;
  }

  /**
   * Get description string for an item (author, year, publication)
   */
  private static getItemDescription(item: Zotero.Item): string {
    const parts: string[] = [];
    if (item.firstCreator) {
      parts.push(item.firstCreator);
    }
    const date = item.getField("date", true, true) as string;
    if (date) {
      const year = date.substring(0, 4);
      if (year !== "0000") {
        parts.push(`(${parseInt(year)})`);
      }
    }
    const pubTitle = item.getField("publicationTitle", false, true);
    if (pubTitle) {
      parts.push(String(pubTitle));
    }
    return parts.join(", ");
  }

  private static showItemPrompt(reader: any): Promise<Zotero.Item | null> {
    return new Promise((resolve) => {
      // Validate reader first
      if (!this.isReaderValid(reader)) {
        resolve(null);
        return;
      }

      const currentItemID = reader.itemID;
      const currentItem = Zotero.Items.get(currentItemID);
      const libraryID = currentItem.libraryID;
      let resolved = false;

      const finish = (item: Zotero.Item | null) => {
        if (resolved) return;
        resolved = true;
        ztoolkit.Prompt.unregister("split-view-item-selector");
        resolve(item);
      };

      const win = Zotero.getMainWindow();
      const promptInstance = ztoolkit.Prompt.prompt;
      const { promptNode } = promptInstance;

      const buildItemList = (prompt: any, items: Zotero.Item[]) => {
        if (items.length === 0) {
          prompt.showTip(getString("splitview-not-found"));
          return;
        }

        const container = prompt.createCommandsContainer();
        container.classList.add("suggestions");

        items.slice(0, 30).forEach((item: Zotero.Item) => {
          const title = String(item.getField("title") || "Untitled");
          const description = this.getItemDescription(item);
          const pdfs = this.getPDFAttachments(item);
          const pdfCount = pdfs.length;

          const ele = ztoolkit.UI.createElement(win.document, "div", {
            namespace: "html",
            classList: ["command"],
            listeners: [
              {
                type: "mousemove",
                listener: function () {
                  prompt.selectItem(this as unknown as HTMLDivElement);
                },
              },
              {
                type: "click",
                listener: () => {
                  if (pdfCount === 0) {
                    prompt.showTip(getString("splitview-no-pdf"));
                    return;
                  }
                  if (pdfCount === 1) {
                    promptNode.style.display = "none";
                    finish(pdfs[0]);
                  } else {
                    buildPDFList(prompt, pdfs, item);
                  }
                },
              },
            ],
            styles: {
              display: "flex",
              flexDirection: "column",
              justifyContent: "start",
            },
            children: [
              {
                tag: "span",
                styles: {
                  fontWeight: "bold",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                },
                properties: {
                  innerText:
                    title + (pdfCount > 1 ? ` [${pdfCount} PDFs]` : ""),
                },
              },
              {
                tag: "span",
                styles: {
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  opacity: "0.7",
                  fontSize: "0.9em",
                },
                properties: {
                  innerText: description,
                },
              },
            ],
          });
          container.appendChild(ele);
        });
      };

      const buildPDFList = (
        prompt: any,
        pdfs: Zotero.Item[],
        parentItem: Zotero.Item,
      ) => {
        const container = prompt.createCommandsContainer();
        container.classList.add("suggestions");

        pdfs.forEach((pdf: Zotero.Item) => {
          const pdfTitle = String(
            pdf.getField("title") ||
              (pdf as any).attachmentFilename ||
              "PDF",
          );

          const ele = ztoolkit.UI.createElement(win.document, "div", {
            namespace: "html",
            classList: ["command"],
            listeners: [
              {
                type: "mousemove",
                listener: function () {
                  prompt.selectItem(this as unknown as HTMLDivElement);
                },
              },
              {
                type: "click",
                listener: () => {
                  promptNode.style.display = "none";
                  finish(pdf);
                },
              },
            ],
            styles: {
              display: "flex",
              flexDirection: "column",
              justifyContent: "start",
            },
            children: [
              {
                tag: "span",
                styles: {
                  fontWeight: "bold",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                },
                properties: {
                  innerText: pdfTitle,
                },
              },
              {
                tag: "span",
                styles: {
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  opacity: "0.7",
                  fontSize: "0.9em",
                },
                properties: {
                  innerText: String(parentItem.getField("title") || ""),
                },
              },
            ],
          });
          container.appendChild(ele);
        });
      };

      ztoolkit.Prompt.register([
        {
          id: "split-view-item-selector",
          callback: async (prompt) => {
            const text = prompt.inputNode.value;
            prompt.showTip(getString("splitview-searching"));

            const s = new Zotero.Search();
            s.addCondition("libraryID", "is", String(libraryID));
            s.addCondition("itemType", "isNot", "attachment");
            s.addCondition("itemType", "isNot", "note");
            if (text.trim()) {
              s.addCondition(
                "quicksearch-titleCreatorYear",
                "contains",
                text,
              );
            }

            const ids = await s.search();
            const itemsWithPDF: Zotero.Item[] = [];
            for (const id of ids) {
              const item = Zotero.Items.get(id);
              if (!item || !item.isRegularItem()) continue;
              const pdfs = this.getPDFAttachments(item);
              if (pdfs.length > 0) {
                itemsWithPDF.push(item);
              }
              if (itemsWithPDF.length >= 30) break;
            }

            buildItemList(prompt, itemsWithPDF);
          },
        },
      ]);

      promptNode.style.display = "flex";
      promptInstance.showCommands(promptInstance.commands, true);
      promptInstance.inputNode.value = "";
      promptInstance.inputNode.focus();

      (async () => {
        const s = new Zotero.Search();
        s.addCondition("libraryID", "is", String(libraryID));
        s.addCondition("itemType", "isNot", "attachment");
        s.addCondition("itemType", "isNot", "note");
        const ids = await s.search();
        if (promptNode.style.display === "none") return;
        if (promptInstance.inputNode.value.trim()) return;

        const itemsWithPDF: Zotero.Item[] = [];
        for (const id of ids) {
          const item = Zotero.Items.get(id);
          if (!item || !item.isRegularItem()) continue;
          const pdfs = this.getPDFAttachments(item);
          if (pdfs.length > 0) {
            itemsWithPDF.push(item);
          }
          if (itemsWithPDF.length >= 30) break;
        }
        buildItemList(promptInstance, itemsWithPDF);
      })();

      const observer = new win.MutationObserver(() => {
        if (promptNode.style.display === "none") {
          observer.disconnect();
          finish(null);
        }
      });
      observer.observe(promptNode, {
        attributes: true,
        attributeFilter: ["style"],
      });
    });
  }
}
