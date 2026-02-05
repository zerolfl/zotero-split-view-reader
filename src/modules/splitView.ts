import { getString } from "../utils/locale";

/**
 * Split View Tab - Single tab with two side-by-side PDF readers.
 *
 * Features:
 * 1. Opens two PDF readers in a single Zotero tab
 * 2. Horizontal split layout with draggable splitter
 * 3. Bidirectional scroll/page sync (toggle via context menu)
 * 4. Each reader has complete annotation support
 */

interface TrackedEventListener {
  target: EventTarget;
  type: string;
  listener: EventListener;
  options?: boolean | AddEventListenerOptions;
}

interface SplitTabState {
  tabID: string;
  container: XUL.Box;
  leftBrowser: XULBrowserElement;
  rightBrowser: XULBrowserElement;
  leftPopupset: XULElement;
  rightPopupset: XULElement;
  leftItemID: number;
  rightItemID: number;
  leftParentItemID: number;
  rightParentItemID: number;
  syncEnabled: boolean;
  primarySide: "left" | "right";
  activeSide: "left" | "right";
  scrollHandler: (() => void) | null;
  lastPrimaryScroll: { top: number; left: number } | null;
  notifierID: string | null;
  syncPaused: boolean;
  sidebarToggleTimers: number[];
  ctrlPressed: boolean;
  zoomingCount: number;
  // Resource tracking for proper cleanup
  eventListeners: TrackedEventListener[];
  timeoutIds: number[];
  // Cached viewer containers to avoid repeated DOM queries
  leftViewerContainer: Element | null;
  rightViewerContainer: Element | null;
  // Visibility check interval (replacing _visibilityInterval)
  visibilityIntervalId: number | null;
  // Split ratio for proportional resizing (0-1, left side proportion)
  splitRatio: number;
  // Track view states for saving to disk
  leftViewState: any;
  rightViewState: any;
  // Track if cleanup is in progress to avoid dead object errors
  isCleaningUp: boolean;
}

export class SplitViewFactory {
  private static state: SplitTabState | null = null;

  /**
   * Register an event listener and track it for cleanup
   */
  private static trackEventListener(
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions
  ) {
    if (!this.state) return;
    target.addEventListener(type, listener, options);
    this.state.eventListeners.push({ target, type, listener, options });
  }

  /**
   * Register a timeout and track it for cleanup
   */
  private static trackTimeout(callback: () => void, delay: number): number {
    if (!this.state) return 0;
    const win = Zotero.getMainWindow();
    const id = win.setTimeout(callback, delay);
    this.state.timeoutIds.push(id);
    return id;
  }

  /**
   * Create a browser element for the reader
   * Uses CSS flex layout for automatic proportional resizing
   */
  private static createReaderBrowser(win: Window): XULBrowserElement {
    const browser = win.document.createXULElement("browser");
    // Don't set XUL flex attribute - use CSS flex instead
    browser.setAttribute("type", "content");
    browser.setAttribute("transparent", "true");
    browser.setAttribute("src", "resource://zotero/reader/reader.html");
    // Initial flex: equal distribution, will be updated by updateBrowserFlex
    // Use flex-basis: 0 to ensure proportional sizing regardless of content
    (browser as any).style.flex = "1 1 0%";
    (browser as any).style.minWidth = "200px";
    (browser as any).style.maxWidth = "none";
    (browser as any).style.overflow = "hidden";
    (browser as any).style.boxSizing = "border-box";
    return browser;
  }

  /**
   * Update browser flex values to achieve the desired split ratio
   * Uses flex layout for automatic proportional resizing when window changes
   */
  private static updateBrowserFlex(
    leftBrowser: XULBrowserElement,
    rightBrowser: XULBrowserElement,
    splitRatio: number
  ) {
    // Use flex-grow to control proportions (flex-shrink=1, flex-basis=0%)
    // flex-basis: 0% ensures both browsers start at 0 and grow proportionally
    // This guarantees equal width when splitRatio is 0.5
    const leftFlex = splitRatio * 100;
    const rightFlex = (1 - splitRatio) * 100;
    (leftBrowser as any).style.flex = `${leftFlex} 1 0%`;
    (rightBrowser as any).style.flex = `${rightFlex} 1 0%`;
  }

  /**
   * Set up drag functionality for the resizer
   * - Uses requestAnimationFrame for smooth performance
   * - Uses flex layout for automatic proportional resizing
   * - PDF scale is preserved (PDF.js handles relative vs absolute scaling)
   */
  private static setupResizerDrag(
    resizer: XULElement | HTMLElement,
    leftBrowser: XULBrowserElement,
    rightBrowser: XULBrowserElement,
    mainHbox: XULElement,
    win: Window
  ) {
    let isDragging = false;
    let startX = 0;
    let startRatio = 0;
    let overlay: HTMLElement | null = null;
    let rafPending = false;
    let onKeyDown: ((e: KeyboardEvent) => void) | null = null;

    const self = this;

    const removeOverlay = () => {
      isDragging = false;
      if (overlay) {
        overlay.remove();
        overlay = null;
      }
      win.removeEventListener("mouseup", onMouseUp);
      win.removeEventListener("blur", onMouseUp);
      win.document.removeEventListener("mouseleave", onMouseUp);
      if (onKeyDown) {
        win.removeEventListener("keydown", onKeyDown);
        onKeyDown = null;
      }
    };

    const createOverlay = () => {
      // Remove any existing overlay first (but don't reset isDragging)
      if (overlay) {
        overlay.remove();
        overlay = null;
      }
      win.removeEventListener("mouseup", onMouseUp);
      win.removeEventListener("blur", onMouseUp);
      win.document.removeEventListener("mouseleave", onMouseUp);
      if (onKeyDown) {
        win.removeEventListener("keydown", onKeyDown);
      }

      overlay = win.document.createElement("div");
      overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 99999;
        cursor: ew-resize;
        background: transparent;
      `;
      const target = win.document.documentElement || win.document.body;
      if (target) target.appendChild(overlay);
      overlay.addEventListener("mousemove", onMouseMove);
      overlay.addEventListener("mouseup", onMouseUp);

      // Also listen on window in case mouseup happens outside overlay
      win.addEventListener("mouseup", onMouseUp);

      // Add additional stop listeners (following Zotero's createDragHandler pattern)
      win.addEventListener("blur", onMouseUp);
      win.document.addEventListener("mouseleave", onMouseUp);

      // Escape key to cancel drag and restore original ratio
      onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          // Restore original ratio
          if (self.state) {
            self.state.splitRatio = startRatio;
            self.updateBrowserFlex(leftBrowser, rightBrowser, startRatio);
          }
          removeOverlay();
        }
      };
      win.addEventListener("keydown", onKeyDown);
    };

    const onMouseDown = (e: MouseEvent) => {
      isDragging = true;
      startX = e.clientX;
      // Store the starting ratio for Escape key restoration
      startRatio = self.state?.splitRatio ?? 0.5;

      createOverlay();
      e.preventDefault();
      e.stopPropagation();
    };

    const onWindowMouseDown = (e: MouseEvent) => {
      if (isDragging) return;
      if (!self.state) return;

      // Only handle when our tab is visible (resizer has non-zero dimensions)
      const resizerRect = resizer.getBoundingClientRect();
      if (resizerRect.width === 0 || resizerRect.height === 0) return;

      const leftBrowserRect = leftBrowser.getBoundingClientRect();

      const edgeX = leftBrowserRect.right;
      const isNearEdge = Math.abs(e.clientX - edgeX) <= 15 &&
                         e.clientY >= resizerRect.top &&
                         e.clientY <= resizerRect.bottom;

      if (isNearEdge) {
        onMouseDown(e);
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging || !self.state) return;
      if (rafPending) return;

      rafPending = true;
      win.requestAnimationFrame(() => {
        rafPending = false;
        if (!isDragging || !self.state) return;

        // Use real-time container width instead of cached start widths
        // This ensures correct ratio calculation even if window is resized during drag
        const containerWidth = mainHbox.getBoundingClientRect().width;
        const resizerWidth = 1;
        const availableWidth = containerWidth - resizerWidth;

        // Calculate new left width based on mouse position
        // Use Math.floor with integer percentage like Zotero's split-view-resizer.js:
        // let p = Math.floor((br.width - (x - br.left)) / br.width * 100);
        const containerRect = mainHbox.getBoundingClientRect();
        const relativeX = e.clientX - containerRect.left;

        // Calculate percentage and floor to integer (1% step, matching Zotero)
        let percent = Math.floor(relativeX / availableWidth * 100);

        // Apply min/max constraints (20-80% like Zotero's VIEW_MIN_SIZE)
        const minPercent = Math.ceil(200 / availableWidth * 100); // At least 200px
        const maxPercent = 100 - minPercent;
        percent = Math.max(minPercent, Math.min(maxPercent, percent));

        // Update split ratio and flex values
        self.state.splitRatio = percent / 100;
        self.updateBrowserFlex(leftBrowser, rightBrowser, self.state.splitRatio);
      });
    };

    const onMouseUp = () => {
      removeOverlay();
    };

    // Track resizer mousedown listener for proper cleanup
    resizer.addEventListener("mousedown", onMouseDown);
    if (this.state) {
      this.state.eventListeners.push({
        target: resizer,
        type: "mousedown",
        listener: onMouseDown as EventListener,
        options: undefined
      });
    }

    this.trackEventListener(win, "mousedown", onWindowMouseDown as EventListener, true);
  }

  /**
   * Cache viewer container references to avoid repeated DOM queries during scroll sync
   */
  private static cacheViewerContainers() {
    if (!this.state || this.state.isCleaningUp) return;
    try {
      this.state.leftViewerContainer = this.getViewerContainerFromBrowser(this.state.leftBrowser);
      this.state.rightViewerContainer = this.getViewerContainerFromBrowser(this.state.rightBrowser);
    } catch {
      // Browsers may be dead
    }
  }


  static registerContextMenu() {
    Zotero.Reader.registerEventListener(
      "createViewContextMenu",
      (event) => {
        const { reader, append } = event;

        // Check if we have an active split view (and not cleaning up)
        const isInSplitView = this.state !== null && !this.state.isCleaningUp;

        const menuItems: any[] = [];

        // First item: "Split-View Reader" toggle
        menuItems.push({
          label: getString("splitview-menu-label"),
          checked: isInSplitView,
          onCommand: () => {
            // Re-check state at command time to avoid stale references
            const currentlyInSplitView = this.state !== null && !this.state.isCleaningUp;
            if (currentlyInSplitView) {
              // Uncheck = close split view, keep the focused reader
              this.revertToSingleReader();
            } else {
              // Check = open split view
              this.handleSplitView(reader);
            }
          },
        });

        // If we have an active split view, add additional options
        if (isInSplitView && this.state) {
          // Determine which side this reader is on
          const currentSide = this.getReaderSide(reader as any);

          // Second item: "Primary Window" with 📌 if this is primary
          const isPrimary = currentSide && this.state.primarySide === currentSide;
          menuItems.push({
            label: (isPrimary ? "📌 " : "") + getString("splitview-set-primary"),
            onCommand: () => {
              // Re-check state at command time
              if (this.state && !this.state.isCleaningUp && currentSide) {
                this.setPrimarySide(currentSide);
              }
            },
          });

          // Third item: "Scroll Sync" with 📌 if enabled
          menuItems.push({
            label: (this.state.syncEnabled ? "📌 " : "") + getString("splitview-sync-actions"),
            onCommand: () => {
              // Re-check state at command time
              if (this.state && !this.state.isCleaningUp) {
                this.toggleSync();
              }
            },
          });
        }

        (append as any)(...menuItems);
      },
      addon.data.config.addonID,
    );
  }

  /**
   * Determine which side (left/right) a reader belongs to based on itemID
   */
  private static getReaderSide(reader: any): "left" | "right" | null {
    if (!this.state) return null;

    try {
      if (reader.itemID === this.state.leftItemID) {
        return "left";
      }
      if (reader.itemID === this.state.rightItemID) {
        return "right";
      }
    } catch {
      return null;
    }

    return null;
  }

  /**
   * Set which side is the primary (controller)
   */
  private static setPrimarySide(side: "left" | "right") {
    if (!this.state || this.state.isCleaningUp) return;

    // Stop current sync before changing
    this.stopSyncPolling();

    this.state.primarySide = side;

    // Restart sync with new primary
    if (this.state.syncEnabled) {
      this.initSyncState();
      this.startSyncPolling();
    }

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
      // Clean up any stale state first
      if (this.state && !this.state.isCleaningUp) {
        this.cleanup();
      }

      // Wait a bit for cleanup to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      const selectedPDF = await this.showItemPrompt(reader);
      if (!selectedPDF) return;

      // Convert current tab to split view (instead of opening new tab)
      await this.convertToSplitView(reader, selectedPDF);
    } catch {
      if (this.state && !this.state.isCleaningUp) {
        this.cleanup();
      }
    }
  }

  /**
   * Convert current reader tab to split view
   * Keeps the current PDF on the left side and adds the secondary PDF on the right
   */
  private static async convertToSplitView(currentReader: any, secondaryPDF: Zotero.Item) {
    const win = Zotero.getMainWindow();
    const Zotero_Tabs = (win as any).Zotero_Tabs;

    // 1. Get current tab and reader info
    const tabID = currentReader.tabID;
    const leftItemID = currentReader.itemID;
    const leftItem = Zotero.Items.get(leftItemID);
    const container = win.document.getElementById(tabID);

    if (!container) {
      throw new Error("Tab container not found");
    }

    // 2. Save current reader's viewState (position info)
    const leftViewState = await this.getViewStateFromReader(currentReader);

    // 3. Get right PDF's stored state
    const rightViewState = await this.getStoredViewState(secondaryPDF);

    // 4. Close current reader (but don't close tab)
    await this.closeReaderWithoutClosingTab(currentReader);

    // 5. Clear tab container and reset its styles
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
    // Reset container styles to ensure proper flex layout
    (container as any).style.display = "flex";
    (container as any).style.flexDirection = "row";
    (container as any).style.width = "100%";
    (container as any).style.height = "100%";
    (container as any).style.overflow = "hidden";

    // 6. Get item info for tab title
    const leftTitle = String(leftItem.getField("title") || "PDF 1").substring(0, 30);
    const rightTitle = String(secondaryPDF.getField("title") || "PDF 2").substring(0, 30);

    // 7. Build split view layout
    const mainHbox = win.document.createXULElement("hbox") as XULElement;
    (mainHbox as any).style.display = "flex";
    (mainHbox as any).style.flexDirection = "row";
    (mainHbox as any).style.flex = "1 1 100%";
    (mainHbox as any).style.width = "100%";
    (mainHbox as any).style.height = "100%";
    (mainHbox as any).style.minWidth = "0";
    (mainHbox as any).style.overflow = "hidden";
    (mainHbox as any).style.boxSizing = "border-box";

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

    const leftPopupset = win.document.createXULElement("popupset") as XULElement;
    const rightPopupset = win.document.createXULElement("popupset") as XULElement;

    mainHbox.appendChild(leftBrowser);
    mainHbox.appendChild(resizer);
    mainHbox.appendChild(rightBrowser);
    container.appendChild(mainHbox);
    container.appendChild(leftPopupset);
    container.appendChild(rightPopupset);

    // Handle bottom placeholder resize events
    container.addEventListener("tab-bottom-placeholder-resize", (event: any) => {
      event.stopPropagation();
    });

    // Get parent item IDs for context pane switching
    const leftParentItemID = leftItem.parentItemID || leftItem.id;
    const rightParentItemID = secondaryPDF.parentItemID || secondaryPDF.id;

    // 8. Initialize state (reuse current tabID)
    this.state = {
      tabID,
      container: container as XUL.Box,
      leftBrowser,
      rightBrowser,
      leftPopupset,
      rightPopupset,
      leftItemID,
      rightItemID: secondaryPDF.id,
      leftParentItemID,
      rightParentItemID,
      syncEnabled: true,
      primarySide: "left",
      activeSide: "left",
      scrollHandler: null,
      lastPrimaryScroll: null,
      notifierID: null,
      syncPaused: false,
      sidebarToggleTimers: [],
      ctrlPressed: false,
      zoomingCount: 0,
      eventListeners: [],
      timeoutIds: [],
      leftViewerContainer: null,
      rightViewerContainer: null,
      visibilityIntervalId: null,
      splitRatio: 0.5,
      leftViewState: leftViewState,
      rightViewState: rightViewState,
      isCleaningUp: false,
    };

    // Set up drag functionality
    this.setupResizerDrag(resizer, leftBrowser, rightBrowser, mainHbox, win);

    // Set initial flex values
    this.updateBrowserFlex(leftBrowser, rightBrowser, this.state.splitRatio);

    // Register tab notifier
    this.registerTabNotifier(win);

    // Set up context pane
    this.setupContextPane(win);

    // 9. Initialize both readers (with viewState)
    try {
      await Promise.all([
        this.initializeReader(leftBrowser, leftItem, leftPopupset, false, leftViewState),
        this.initializeReader(rightBrowser, secondaryPDF, rightPopupset, true, rightViewState),
      ]);

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

      // Initialize context pane with left item
      if (this.state) {
        this.state.activeSide = "left";
        this.updateContextPane(win, this.state.leftParentItemID);
      }

      // Set up focus listeners
      this.setupFocusListeners(leftBrowser, rightBrowser, win);

      // Enable sync after delay
      this.trackTimeout(() => {
        if (this.state && this.state.syncEnabled) {
          this.cacheViewerContainers();
          this.initSyncState();
          this.startSyncPolling();
          this.setupResizeListener(win);
          this.setupCtrlKeyListener(leftBrowser);
          this.setupCtrlKeyListener(rightBrowser);
          this.setupMainWindowKeyboardListener(win);
          this.setupZoomButtonListeners(leftBrowser);
          this.setupZoomButtonListeners(rightBrowser);
          this.setupContextPaneObserver(win);
        }
      }, 500);

      // 10. Update tab data and title
      Zotero_Tabs.setTabData(tabID, {
        itemID: leftItemID,
        leftItemID,
        rightItemID: secondaryPDF.id,
      });
      Zotero_Tabs.rename(tabID, `Split: ${leftTitle} | ${rightTitle}`);

    } catch (e) {
      this.cleanup();
      throw e;
    }
  }

  /**
   * Toggle scroll/page sync
   */
  private static toggleSync() {
    if (!this.state || this.state.isCleaningUp) return;

    this.state.syncEnabled = !this.state.syncEnabled;

    if (this.state.syncEnabled) {
      this.initSyncState();
      this.startSyncPolling();
    } else {
      this.stopSyncPolling();
      this.state.lastPrimaryScroll = null;
    }

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
   * Initialize sync state - record primary's current position
   */
  private static initSyncState() {
    if (!this.state || this.state.isCleaningUp) return;

    try {
      const primaryBrowser = this.state.primarySide === "left"
        ? this.state.leftBrowser
        : this.state.rightBrowser;
      const primaryContainer = this.getViewerContainerFromBrowser(primaryBrowser);

      if (primaryContainer) {
        this.state.lastPrimaryScroll = {
          top: primaryContainer.scrollTop,
          left: primaryContainer.scrollLeft,
        };
      }
    } catch {
      // Browser may be dead
    }
  }

  /**
   * Set up zoom button listeners on a browser's toolbar
   * This directly hooks into zoom button clicks for reliable sync
   */
  private static setupZoomButtonListeners(browser: XULBrowserElement) {
    if (!this.state) return;

    try {
      // The zoom buttons are in the reader's main document (browser.contentWindow),
      // NOT in the inner PDF.js iframe
      const win = browser.contentWindow;
      if (!win) return;

      const wrappedWin = (win as any).wrappedJSObject || win;
      const doc = wrappedWin.document;
      if (!doc) return;

      // Find zoom buttons in the toolbar
      // Try multiple selectors as Zotero's reader may use different ones
      // Search for button with zoom-in/zoom-out/zoom-reset icons or titles
      const findButton = (type: "in" | "out" | "reset"): Element | null => {
        const selectors = type === "in" ? [
          '[data-l10n-id="pdfjs-zoom-in-button"]',
          '#zoomIn',
          '.zoomIn',
          'button[class*="zoomIn"]',
          'button[class*="zoom-in"]',
          '[title*="Zoom In"]',
          '[title*="zoom in"]',
          '[aria-label*="Zoom In"]',
          '[aria-label*="zoom in"]',
          // Zotero reader specific
          'button[data-tabstop="1"][class*="zoom"]',
        ] : type === "out" ? [
          '[data-l10n-id="pdfjs-zoom-out-button"]',
          '#zoomOut',
          '.zoomOut',
          'button[class*="zoomOut"]',
          'button[class*="zoom-out"]',
          '[title*="Zoom Out"]',
          '[title*="zoom out"]',
          '[aria-label*="Zoom Out"]',
          '[aria-label*="zoom out"]',
        ] : [
          // Reset zoom selectors (Zotero reader uses zoomAuto)
          '#zoomAuto',
          '.zoomAuto',
          'button[class*="zoomAuto"]',
          'button[class*="zoom-auto"]',
          '[title*="Zoom Reset"]',
          '[title*="zoom reset"]',
          '[title*="Reset Zoom"]',
          '[title*="reset zoom"]',
          '[aria-label*="Zoom Reset"]',
          '[aria-label*="Reset Zoom"]',
        ];

        for (const selector of selectors) {
          try {
            const btn = doc.querySelector(selector);
            if (btn) return btn;
          } catch {
            // Invalid selector, skip
          }
        }

        // Try finding by icon class patterns
        const allButtons = doc.querySelectorAll('button, [role="button"]');
        for (const btn of allButtons) {
          const className = (btn.className || "").toLowerCase();
          const title = (btn.getAttribute("title") || "").toLowerCase();
          const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();

          if (type === "in") {
            if (className.includes("zoomin") || className.includes("zoom-in") ||
                title.includes("zoom in") || ariaLabel.includes("zoom in") ||
                title.includes("放大") || ariaLabel.includes("放大")) {
              return btn;
            }
          } else if (type === "out") {
            if (className.includes("zoomout") || className.includes("zoom-out") ||
                title.includes("zoom out") || ariaLabel.includes("zoom out") ||
                title.includes("缩小") || ariaLabel.includes("缩小")) {
              return btn;
            }
          } else {
            if (className.includes("zoomauto") || className.includes("zoom-auto") ||
                className.includes("zoomreset") || className.includes("zoom-reset") ||
                title.includes("zoom reset") || title.includes("reset zoom") ||
                ariaLabel.includes("zoom reset") || ariaLabel.includes("reset zoom") ||
                title.includes("重置") || ariaLabel.includes("重置")) {
              return btn;
            }
          }
        }

        return null;
      };

      const zoomInBtn = findButton("in");
      const zoomOutBtn = findButton("out");
      const zoomResetBtn = findButton("reset");

      const self = this;
      const isLeft = browser === this.state.leftBrowser;

      if (zoomInBtn) {
        const zoomInHandler = () => {
          self.handleZoomButtonClick(isLeft, "in");
        };
        this.trackEventListener(zoomInBtn, "click", zoomInHandler as EventListener, true);
      }

      if (zoomOutBtn) {
        const zoomOutHandler = () => {
          self.handleZoomButtonClick(isLeft, "out");
        };
        this.trackEventListener(zoomOutBtn, "click", zoomOutHandler as EventListener, true);
      }

      if (zoomResetBtn) {
        const zoomResetHandler = () => {
          self.handleZoomButtonClick(isLeft, "reset");
        };
        this.trackEventListener(zoomResetBtn, "click", zoomResetHandler as EventListener, true);
      }

    } catch {
      // Ignore errors setting up zoom button listeners
    }
  }

  /**
   * Handle zoom button click - sync to secondary if this is primary
   */
  private static handleZoomButtonClick(isLeft: boolean, direction: "in" | "out" | "reset") {
    if (!this.state || this.state.isCleaningUp) return;
    if (!this.state.syncEnabled) return;

    // Only sync from primary to secondary
    const isPrimary = (isLeft && this.state.primarySide === "left") ||
                      (!isLeft && this.state.primarySide === "right");
    if (!isPrimary) return;

    // Skip if Ctrl is pressed (user doing Ctrl+wheel zoom shouldn't sync)
    if (this.state.ctrlPressed) return;

    const secondaryBrowser = this.state.primarySide === "left"
      ? this.state.rightBrowser
      : this.state.leftBrowser;

    // Pause scroll sync during zoom
    this.state.zoomingCount++;

    // Sync zoom action to secondary immediately
    if (direction === "in") {
      this.zoomInForBrowser(secondaryBrowser);
    } else if (direction === "out") {
      this.zoomOutForBrowser(secondaryBrowser);
    } else {
      this.zoomResetForBrowser(secondaryBrowser);
    }

    // Resume scroll sync after a delay, and reinitialize sync state
    // to prevent position jump (zoom changes scroll positions)
    this.trackTimeout(() => {
      if (this.state) {
        this.state.zoomingCount = Math.max(0, this.state.zoomingCount - 1);
        // Reinitialize sync state after zoom completes
        // This updates lastPrimaryScroll to current position
        if (this.state.zoomingCount === 0) {
          this.initSyncState();
        }
      }
    }, 150); // Slightly longer to ensure zoom animation completes
  }

  /**
   * Wait for browser to load reader.html
   */
  private static waitForBrowserLoad(browser: XULBrowserElement): Promise<void> {
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

  /**
   * Initialize a reader in a browser element
   * @param showContextPaneToggle - Whether to show context pane toggle button (for right reader)
   * @param viewState - Optional view state to restore position
   */
  private static async initializeReader(
    browser: XULBrowserElement,
    item: Zotero.Item,
    popupset: XULElement,
    showContextPaneToggle: boolean = false,
    viewState?: any
  ): Promise<void> {
    await this.waitForBrowserLoad(browser);

    const win = browser.contentWindow;
    if (!win) throw new Error("Browser contentWindow not available");

    const wrappedWin = (win as any).wrappedJSObject || win;
    const mainWindow = Zotero.getMainWindow();

    // Get PDF data URL
    const data = {
      url: `zotero://attachment/${Zotero.API.getLibraryPrefix(item.libraryID)}/items/${item.key}/`,
    };

    // Get annotations - match Zotero's _getAnnotation method
    const annotationItems = item.getAnnotations();
    const annotations = await Promise.all(
      annotationItems.map(async (annot: Zotero.Item) => {
        try {
          if (!annot || !annot.isAnnotation()) {
            return null;
          }
          const json: any = await Zotero.Annotations.toJSON(annot);
          json.id = annot.key;
          delete json.key;
          // Ensure no undefined values for non-array properties (match Zotero's behavior)
          for (const key in json) {
            if (!Array.isArray(json[key])) {
              json[key] = json[key] || "";
            }
          }
          json.tags = json.tags || [];
          return json;
        } catch {
          return null;
        }
      })
    );
    const validAnnotations = annotations.filter((a) => a !== null);

    // Prepare Fluent localization data
    let ftl: string[] = [];
    try {
      ftl.push(Zotero.File.getContentsFromURL("chrome://zotero/locale/zotero.ftl"));
    } catch {
      // Ignore FTL loading errors
    }
    try {
      ftl.push(Zotero.File.getContentsFromURL("chrome://zotero/locale/reader.ftl"));
    } catch {
      // Ignore FTL loading errors
    }

    // Store references for callbacks
    const self = this;
    const itemRef = item;
    const browserRef = browser;
    const popupsetRef = popupset;

    // Get current context pane state
    const mainWin = Zotero.getMainWindow();
    const contextPaneOpen = showContextPaneToggle
      ? !((mainWin as any).ZoteroContextPane?.collapsed ?? true)
      : false;

    // Create internal reader config - all callbacks defined inline, clone entire object once
    const readerConfig = {
      type: "pdf",
      data,
      annotations: validAnnotations,
      readOnly: false,
      authorName: item.library.libraryType === "group" ? Zotero.Users.getCurrentName() : "",
      showContextPaneToggle,
      contextPaneOpen, // When true, hides toggle button in toolbar (sidenav shows it instead)
      sidebarWidth: 240,
      sidebarOpen: false, // Default to collapsed in split view
      bottomPlaceholderHeight: 0,
      rtl: (Zotero as any).rtl,
      fontSize: Zotero.Prefs.get("fontSize"),
      ftl,
      showAnnotations: true,
      // Additional reader preferences
      textSelectionAnnotationMode: Zotero.Prefs.get("reader.textSelectionAnnotationMode"),
      customThemes: (Zotero as any).SyncedSettings?.get(Zotero.Libraries.userLibraryID, "readerCustomThemes") ?? [],
      lightTheme: Zotero.Prefs.get("reader.lightTheme"),
      darkTheme: Zotero.Prefs.get("reader.darkTheme"),
      fontFamily: Zotero.Prefs.get("reader.ebookFontFamily"),
      hyphenate: Zotero.Prefs.get("reader.ebookHyphenate"),
      autoDisableNoteTool: Zotero.Prefs.get("reader.autoDisableTool.note"),
      autoDisableTextTool: Zotero.Prefs.get("reader.autoDisableTool.text"),
      autoDisableImageTool: Zotero.Prefs.get("reader.autoDisableTool.image"),
      sidebarView: Zotero.Prefs.get("reader.lastSidebarTab"),
      // Pass viewState to restore position
      primaryViewState: viewState,
      // Required callbacks - all callbacks check if browser is still alive
      onOpenContextMenu: () => {
        if (!self.state || self.state.isCleaningUp || !self.isBrowserAlive(browserRef)) return;
        try {
          const params = wrappedWin.contextMenuParams;
          if (params) {
            self.openContextMenu(browserRef, popupsetRef, params);
          }
        } catch { /* Ignore dead object errors */ }
      },
      onToggleSidebar: (open: boolean) => {
        if (!self.state || self.state.isCleaningUp || !self.isBrowserAlive(browserRef)) return;
        try {
          self.handleSidebarToggle(browserRef, open);
        } catch { /* Ignore dead object errors */ }
      },
      onChangeSidebarWidth: (_width: number) => {
        // No-op for split view
      },
      onChangeViewState: (viewState: any, _primary: boolean) => {
        if (!self.state || self.state.isCleaningUp || !self.isBrowserAlive(browserRef)) return;
        try {
          // Track view state for saving to disk later
          const isLeft = browserRef === self.state.leftBrowser;
          const stateCopy = JSON.parse(JSON.stringify(viewState));
          if (isLeft) {
            self.state.leftViewState = stateCopy;
          } else {
            self.state.rightViewState = stateCopy;
          }
          // Sync zoom when scale changes (toolbar zoom in/out)
          self.handleViewStateChange(browserRef, viewState);
        } catch { /* Ignore dead object errors */ }
      },
      onSaveAnnotations: async (annotations: any[], callback: () => void) => {
        try {
          await self.handleAnnotationSave(itemRef, annotations);
          if (callback) callback();
        } catch { /* Ignore errors */ }
      },
      onDeleteAnnotations: (ids: string[]) => {
        try {
          self.handleAnnotationDelete(itemRef, ids);
        } catch { /* Ignore errors */ }
      },
      onAddToNote: (_annotations: any[]) => {
        // No-op for split view
      },
      onOpenTagsPopup: (_id: string, _x: number, _y: number) => {
        // Tags popup not implemented for split view
      },
      onClosePopup: () => {
        // No-op
      },
      onOpenLink: (url: string) => {
        try {
          Zotero.launchURL(url);
        } catch { /* Ignore errors */ }
      },
      onCopyImage: (_dataURL: string) => {
        // Image copy not implemented for split view
      },
      onSaveImageAs: (_dataURL: string) => {
        // Save image not implemented for split view
      },
      onSetDataTransferAnnotations: (_dataTransfer: any, _annotations: any[], _fromText: boolean) => {
        // Drag-drop not implemented for split view
      },
      onToggleContextPane: () => {
        if (!self.state || self.state.isCleaningUp) return;
        try {
          // Toggle global context pane
          const mainWin = Zotero.getMainWindow();
          if ((mainWin as any).ZoteroContextPane) {
            (mainWin as any).ZoteroContextPane.togglePane();
            // Update right reader's contextPaneOpen state after toggle
            // This controls whether the toggle button shows in the toolbar
            setTimeout(() => {
              if (self.state && !self.state.isCleaningUp && self.isBrowserAlive(self.state.rightBrowser)) {
                const isOpen = !((mainWin as any).ZoteroContextPane?.collapsed ?? true);
                self.setContextPaneOpenForBrowser(self.state.rightBrowser, isOpen);
              }
            }, 50);
          }
        } catch { /* Ignore dead object errors */ }
      },
    };

    // Clone entire config once with wrapReflectors and cloneFunctions
    wrappedWin.createReader(Components.utils.cloneInto(readerConfig, win, {
      wrapReflectors: true,
      cloneFunctions: true
    }));

    // Wait for internal reader to be ready
    await this.waitForInternalReader(browser);

    // Hide the reader's internal sidenav (we use the global context pane instead)
    this.hideReaderSidenav(browser);
  }

  /**
   * Hide the sidenav inside a reader browser
   * This prevents each reader from having its own context pane toggle
   */
  private static hideReaderSidenav(browser: XULBrowserElement) {
    try {
      const win = browser.contentWindow;
      if (!win) return;

      const wrappedWin = (win as any).wrappedJSObject || win;
      const doc = wrappedWin.document;
      if (!doc) return;

      const sidenav = doc.querySelector(".sidenav, reader-sidenav, #sidenav, [class*='sidenav']");
      if (sidenav) {
        sidenav.style.display = "none";
      }

      // Also try to find any context pane toggle buttons
      const toggleBtns = doc.querySelectorAll("[class*='context-pane'], [data-action='toggle-pane']");
      toggleBtns.forEach((btn: any) => {
        btn.style.display = "none";
      });

      // Check the internal reader object for sidenav
      const internalReader = this.getInternalReaderFromBrowser(browser);
      if (internalReader) {
        // Try to hide sidenav via the reader API if available
        if (internalReader._sidenav) {
          internalReader._sidenav.style.display = "none";
        }
        // Some readers have a toolbarRight that contains the sidenav
        if (internalReader._toolbarRight) {
          // Only hide context pane related items, not all toolbar items
          const contextItems = internalReader._toolbarRight.querySelectorAll?.("[class*='context'], [data-action='toggle-pane']");
          contextItems?.forEach((item: any) => {
            item.style.display = "none";
          });
        }
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Wait for internal reader to initialize
   */
  private static waitForInternalReader(browser: XULBrowserElement): Promise<void> {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 100;

      const check = () => {
        attempts++;
        try {
          const internalReader = this.getInternalReaderFromBrowser(browser);
          if (internalReader && internalReader._primaryView) {
            resolve();
            return;
          }
        } catch {
          // Ignore errors
        }

        if (attempts >= maxAttempts) {
          reject(new Error("Timeout waiting for internal reader"));
          return;
        }

        setTimeout(check, 100);
      };

      check();
    });
  }

  /**
   * Get internal reader object from browser
   */
  private static getInternalReaderFromBrowser(browser: XULBrowserElement): any {
    try {
      const win = browser.contentWindow;
      if (!win) return null;
      const wrappedWin = (win as any).wrappedJSObject || win;
      return wrappedWin._reader || null;
    } catch {
      return null;
    }
  }

  /**
   * Check if a browser element is still alive (not destroyed)
   */
  private static isBrowserAlive(browser: XULBrowserElement | null): boolean {
    if (!browser) return false;
    try {
      // Try to access a property - if it throws, the browser is dead
      const win = browser.contentWindow;
      return win !== null;
    } catch {
      return false;
    }
  }

  /**
   * Uninitialize the internal reader to prevent callbacks from firing
   * This nulls out the reader's callbacks and disconnects observers
   */
  private static uninitInternalReader(browser: XULBrowserElement): void {
    try {
      if (!this.isBrowserAlive(browser)) return;

      const internalReader = this.getInternalReaderFromBrowser(browser);
      if (!internalReader) return;

      // Null out all callbacks to prevent them from firing
      const callbackNames = [
        'onOpenContextMenu', 'onToggleSidebar', 'onChangeSidebarWidth',
        'onChangeViewState', 'onSaveAnnotations', 'onDeleteAnnotations',
        'onAddToNote', 'onOpenTagsPopup', 'onClosePopup', 'onOpenLink',
        'onCopyImage', 'onSaveImageAs', 'onSetDataTransferAnnotations',
        'onToggleContextPane'
      ];
      for (const name of callbackNames) {
        try {
          if (internalReader[name]) {
            internalReader[name] = () => {};
          }
        } catch { /* Ignore */ }
      }

      // Try to disconnect any observers on the internal reader
      try {
        if (internalReader._resizeObserver) {
          internalReader._resizeObserver.disconnect();
          internalReader._resizeObserver = null;
        }
      } catch { /* Ignore */ }

      try {
        if (internalReader._mutationObserver) {
          internalReader._mutationObserver.disconnect();
          internalReader._mutationObserver = null;
        }
      } catch { /* Ignore */ }

      // Also clean up the primaryView which might have its own observers
      try {
        const primaryView = internalReader._primaryView;
        if (primaryView) {
          if (primaryView._resizeObserver) {
            primaryView._resizeObserver.disconnect();
            primaryView._resizeObserver = null;
          }
          if (primaryView._mutationObserver) {
            primaryView._mutationObserver.disconnect();
            primaryView._mutationObserver = null;
          }
          // Disconnect intersection observer if any
          if (primaryView._intersectionObserver) {
            primaryView._intersectionObserver.disconnect();
            primaryView._intersectionObserver = null;
          }
        }
      } catch { /* Ignore */ }

      // Try to unset the internal reader reference
      try {
        const win = browser.contentWindow;
        if (win) {
          const wrappedWin = (win as any).wrappedJSObject || win;
          wrappedWin._reader = null;
        }
      } catch { /* Ignore */ }

    } catch {
      // Ignore errors
    }
  }

  /**
   * Unload browser content to prevent dead object errors
   * First uninitializes the internal reader, then sets src to about:blank
   */
  private static unloadBrowser(browser: XULBrowserElement): void {
    try {
      // First uninitialize the internal reader to stop callbacks
      this.uninitInternalReader(browser);

      // Then unload the browser content
      if (this.isBrowserAlive(browser)) {
        browser.setAttribute("src", "about:blank");
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Close a Zotero reader without closing its tab
   * Cleans up the reader (flushes state to disk, unregisters listeners)
   * and removes it from Zotero.Reader._readers array
   */
  private static async closeReaderWithoutClosingTab(reader: any): Promise<void> {
    try {
      // 1. Call uninit() to clean up reader (flush state to disk, unregister listeners)
      if (typeof reader.uninit === "function") {
        reader.uninit();
      }
      // 2. Remove from Zotero.Reader._readers array
      const readers = (Zotero.Reader as any)._readers;
      const index = readers.indexOf(reader);
      if (index !== -1) {
        readers.splice(index, 1);
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Get view state from a reader (real-time position info)
   */
  private static async getViewStateFromReader(reader: any): Promise<any> {
    try {
      // Prefer using _getState() method (syncs to disk)
      if (typeof reader._getState === "function") {
        return await reader._getState();
      }
      // Fallback: get from internal reader
      const internalReader = reader._internalReader;
      if (internalReader?._state?.primaryViewState) {
        return internalReader._state.primaryViewState;
      }
    } catch {
      // Ignore errors
    }
    return null;
  }

  /**
   * Get stored view state from disk for an attachment item
   */
  private static async getStoredViewState(item: Zotero.Item): Promise<any> {
    try {
      const dir = Zotero.Attachments.getStorageDirectory(item);
      const stateFile = PathUtils.join(dir.path, '.zotero-reader-state');
      if (await IOUtils.exists(stateFile)) {
        return await IOUtils.readJSON(stateFile);
      }
    } catch {
      // Ignore errors
    }
    return null;
  }

  /**
   * Save view state to disk for an attachment item
   * Mirrors Zotero's ReaderInstance._setState behavior
   */
  private static async saveViewStateToDisk(itemID: number, viewState: any): Promise<void> {
    if (!viewState) return;
    try {
      const item = Zotero.Items.get(itemID);
      if (!item) return;

      // Update last page index (like Zotero does)
      if (viewState.pageIndex !== undefined) {
        item.setAttachmentLastPageIndex(viewState.pageIndex);
      }

      const dir = Zotero.Attachments.getStorageDirectory(item);
      if (!dir.exists()) {
        await Zotero.Attachments.createDirectoryForItem(item);
      }
      const stateFile = PathUtils.join(dir.path, '.zotero-reader-state');

      Zotero.debug('Split view: Writing reader state to ' + stateFile);
      await IOUtils.writeJSON(stateFile, viewState);
    } catch (e) {
      Zotero.debug('Split view: Failed to save view state: ' + e);
    }
  }

  /**
   * Get current view state from internal reader in browser
   */
  private static getCurrentViewStateFromBrowser(browser: XULBrowserElement): any {
    try {
      const internalReader = this.getInternalReaderFromBrowser(browser);
      if (internalReader?._state?.primaryViewState) {
        return JSON.parse(JSON.stringify(internalReader._state.primaryViewState));
      }
    } catch {
      // Ignore errors
    }
    return null;
  }

  /**
   * Open context menu for a reader
   */
  private static openContextMenu(
    browser: XULBrowserElement,
    popupset: XULElement,
    params: { x: number; y: number; itemGroups: any[][] }
  ) {
    if (!this.isBrowserAlive(browser)) return;
    if (!this.state || this.state.isCleaningUp) return;

    const mainWindow = Zotero.getMainWindow();
    const { x, y, itemGroups } = params;

    const popup = mainWindow.document.createXULElement("menupopup");
    popupset.appendChild(popup);

    popup.addEventListener("popuphidden", function () {
      popup.remove();
    });

    const appendItems = (parentNode: Element, groups: any[][]) => {
      for (let i = 0; i < groups.length; i++) {
        const itemGroup = groups[i];
        for (const item of itemGroup) {
          if (item.groups) {
            // Submenu
            const menu = mainWindow.document.createXULElement("menu");
            menu.setAttribute("label", item.label);
            const menupopup = mainWindow.document.createXULElement("menupopup");
            menu.appendChild(menupopup);
            appendItems(menupopup, item.groups);
            parentNode.appendChild(menu);
          } else {
            // Menu item
            const menuitem = mainWindow.document.createXULElement("menuitem");
            menuitem.setAttribute("label", item.label);
            if (item.disabled) {
              menuitem.setAttribute("disabled", "true");
            }
            if (item.checked) {
              menuitem.setAttribute("type", "checkbox");
              menuitem.setAttribute("checked", "true");
            }
            menuitem.addEventListener("command", () => {
              if (item.onCommand) item.onCommand();
            });
            parentNode.appendChild(menuitem);
          }
        }
        // Add separator between groups (but not after the last group)
        if (i < groups.length - 1) {
          const separator = mainWindow.document.createXULElement("menuseparator");
          parentNode.appendChild(separator);
        }
      }
    };

    appendItems(popup, itemGroups);

    // Add Split View menu items
    if (this.state) {
      const separator = mainWindow.document.createXULElement("menuseparator");
      popup.appendChild(separator);

      // Determine which side this browser is on
      const isLeft = browser === this.state.leftBrowser;
      const currentSide = isLeft ? "left" : "right";
      const isPrimary = this.state.primarySide === currentSide;

      // Close Split View (revert to single reader)
      const closeItem = mainWindow.document.createXULElement("menuitem");
      closeItem.setAttribute("label", getString("splitview-menu-label"));
      closeItem.setAttribute("type", "checkbox");
      closeItem.setAttribute("checked", "true");
      closeItem.addEventListener("command", () => {
        this.revertToSingleReader();
      });
      popup.appendChild(closeItem);

      // Set Primary
      const primaryItem = mainWindow.document.createXULElement("menuitem");
      primaryItem.setAttribute("label", (isPrimary ? "📌 " : "") + getString("splitview-set-primary"));
      primaryItem.addEventListener("command", () => {
        this.setPrimarySide(currentSide);
      });
      popup.appendChild(primaryItem);

      // Toggle Sync
      const syncItem = mainWindow.document.createXULElement("menuitem");
      syncItem.setAttribute("label", (this.state.syncEnabled ? "📌 " : "") + getString("splitview-sync-actions"));
      syncItem.addEventListener("command", () => {
        this.toggleSync();
      });
      popup.appendChild(syncItem);
    }

    // Calculate screen position
    const browserRect = browser.getBoundingClientRect();
    const screenX = browserRect.left + x;
    const screenY = browserRect.top + y;

    // Convert to screen coordinates
    const windowUtils = (mainWindow as any).windowUtils;
    if (windowUtils && windowUtils.toScreenRectInCSSUnits) {
      const rect = windowUtils.toScreenRectInCSSUnits(screenX, screenY, 0, 0);
      setTimeout(() => (popup as any).openPopupAtScreen(rect.x, rect.y, true));
    } else {
      // Fallback
      setTimeout(() => (popup as any).openPopupAtScreen(screenX, screenY, true));
    }
  }

  /**
   * Handle annotation save callback
   * Uses the same approach as Zotero's reader
   */
  private static async handleAnnotationSave(item: Zotero.Item, annotations: any[]) {
    const attachment = Zotero.Items.get(item.id);
    try {
      for (const annotation of annotations) {
        annotation.key = annotation.id;
        delete annotation.authorName;
        await Zotero.Annotations.saveFromJSON(attachment, annotation);
      }
    } catch {
      // Ignore annotation save errors
    }
  }

  /**
   * Handle annotation delete callback
   * Uses the same approach as Zotero's reader
   */
  private static async handleAnnotationDelete(item: Zotero.Item, ids: string[]) {
    const attachment = Zotero.Items.get(item.id);
    const libraryID = attachment.libraryID;
    try {
      for (const key of ids) {
        const annotation = Zotero.Items.getByLibraryAndKey(libraryID, key);
        if (annotation && annotation.isAnnotation() && annotation.parentID === item.id) {
          await annotation.eraseTx();
        }
      }
    } catch {
      // Ignore annotation delete errors
    }
  }

  /**
   * Handle sidebar toggle - sync to the other reader when sync is enabled
   * Pauses scroll sync during sidebar animation to prevent position drift
   */
  private static handleSidebarToggle(sourceBrowser: XULBrowserElement, open: boolean) {
    if (!this.state || this.state.isCleaningUp) return;
    if (!this.state.syncEnabled) return;

    // Determine if this is the primary browser
    const isLeft = sourceBrowser === this.state.leftBrowser;
    const isPrimary = (isLeft && this.state.primarySide === "left") ||
                      (!isLeft && this.state.primarySide === "right");

    // Only sync from primary to secondary
    if (!isPrimary) return;

    // Cancel any pending timers from previous toggle (debounce)
    const win = Zotero.getMainWindow();
    for (const timerId of this.state.sidebarToggleTimers) {
      win.clearTimeout(timerId);
    }
    this.state.sidebarToggleTimers = [];

    // Pause sync during sidebar toggle to prevent position drift
    this.state.syncPaused = true;

    // Get the secondary browser
    const secondaryBrowser = isLeft ? this.state.rightBrowser : this.state.leftBrowser;

    // Toggle sidebar on secondary reader
    try {
      const internalReader = this.getInternalReaderFromBrowser(secondaryBrowser);
      if (internalReader && typeof internalReader.toggleSidebar === "function") {
        internalReader.toggleSidebar(open);
      } else if (internalReader && internalReader._primaryView) {
        const primaryView = internalReader._primaryView;
        if (primaryView && typeof primaryView.setSidebarOpen === "function") {
          primaryView.setSidebarOpen(open);
        }
      }
    } catch {
      // Ignore errors
    }

    // Resume sync after sidebar animation completes and reinitialize position
    // Only set one timer - the final one that resumes sync
    const timerId = win.setTimeout(() => {
      if (!this.state) return;
      // Reinitialize sync state with current positions
      this.initSyncState();
      this.state.syncPaused = false;
      // Clear timer list
      this.state.sidebarToggleTimers = [];
    }, 200);

    this.state.sidebarToggleTimers.push(timerId);
  }

  /**
   * Revert split view to single reader
   * Called when user unchecks "Split-View Reader" in context menu
   * Keeps the focused reader and closes the other one
   */
  private static async revertToSingleReader() {
    if (!this.state || this.state.isCleaningUp) return;

    // Mark as cleaning up to prevent dead object errors
    this.state.isCleaningUp = true;

    const win = Zotero.getMainWindow();
    const tabID = this.state.tabID;

    // 1. Determine which reader to keep (based on activeSide)
    const keepLeft = this.state.activeSide === "left";
    const keepItemID = keepLeft ? this.state.leftItemID : this.state.rightItemID;

    // 2. Save current view states to disk before closing
    try {
      // Get the most current state from browsers
      const leftCurrentState = this.getCurrentViewStateFromBrowser(this.state.leftBrowser);
      const rightCurrentState = this.getCurrentViewStateFromBrowser(this.state.rightBrowser);

      // Save both states
      await Promise.all([
        this.saveViewStateToDisk(this.state.leftItemID, leftCurrentState || this.state.leftViewState),
        this.saveViewStateToDisk(this.state.rightItemID, rightCurrentState || this.state.rightViewState),
      ]);
    } catch (e) {
      Zotero.debug('Split view: Error saving states: ' + e);
    }

    // 3. Clean up split state (but don't close tab yet)
    this.cleanupWithoutClosingTab();

    // 4. Close current tab and open the kept reader in a new tab
    // Note: Zotero.Reader.open creates its own tab, so we close ours first
    const Zotero_Tabs = (win as any).Zotero_Tabs;
    Zotero_Tabs.close(tabID);

    // 5. Open the kept reader (viewState will auto-restore from .zotero-reader-state)
    await Zotero.Reader.open(keepItemID, undefined, {});

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
   * Clean up split view state without closing the tab
   * Used when reverting to single reader
   */
  private static cleanupWithoutClosingTab() {
    if (!this.state) return;

    // Mark as cleaning up to prevent further operations
    this.state.isCleaningUp = true;

    // Unload browsers FIRST to prevent dead object errors from callbacks
    // This stops the internal readers from firing more callbacks
    const leftBrowser = this.state.leftBrowser;
    const rightBrowser = this.state.rightBrowser;
    this.unloadBrowser(leftBrowser);
    this.unloadBrowser(rightBrowser);

    // Store references before nulling state
    const eventListeners = [...this.state.eventListeners];
    const timeoutIds = [...this.state.timeoutIds];
    const sidebarToggleTimers = [...this.state.sidebarToggleTimers];
    const visibilityIntervalId = this.state.visibilityIntervalId;
    const notifierID = this.state.notifierID;
    const contextPaneObserver = (this.state as any).contextPaneObserver;

    // Clear state arrays first to prevent re-entry
    this.state.eventListeners = [];
    this.state.timeoutIds = [];
    this.state.sidebarToggleTimers = [];
    this.state.leftViewerContainer = null;
    this.state.rightViewerContainer = null;
    this.state.visibilityIntervalId = null;
    this.state.notifierID = null;
    (this.state as any).contextPaneObserver = null;

    // Stop sync polling before other cleanup
    this.stopSyncPolling();

    let win: Window | null = null;
    try {
      win = Zotero.getMainWindow();
    } catch {
      // Window may be dead
    }

    // Remove split-view-active class
    if (win) {
      try {
        win.document.documentElement?.classList.remove("split-view-active");
      } catch {
        // Ignore errors - document may be dead
      }
    }

    // Remove all tracked event listeners
    for (const { target, type, listener, options } of eventListeners) {
      try {
        target.removeEventListener(type, listener, options);
      } catch {
        // Ignore removal errors - target may be dead
      }
    }

    // Clear all tracked timeouts
    if (win) {
      for (const id of timeoutIds) {
        try {
          win.clearTimeout(id);
        } catch {
          // Ignore errors
        }
      }

      // Clear sidebar toggle timers
      for (const timerId of sidebarToggleTimers) {
        try {
          win.clearTimeout(timerId);
        } catch {
          // Ignore errors
        }
      }

      // Clear visibility check interval
      if (visibilityIntervalId !== null) {
        try {
          win.clearInterval(visibilityIntervalId);
        } catch {
          // Ignore errors
        }
      }
    }

    // Unregister tab notifier
    if (notifierID) {
      try {
        Zotero.Notifier.unregisterObserver(notifierID);
      } catch {
        // Ignore errors
      }
    }

    // Disconnect context pane observer
    if (contextPaneObserver) {
      try {
        contextPaneObserver.disconnect();
      } catch {
        // Ignore errors
      }
    }

    this.state = null;
  }

  /**
   * Close split tab
   */
  private static closeSplitTab() {
    if (!this.state) return;

    const tabID = this.state.tabID;

    // Cleanup state first
    this.cleanup();

    try {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = (win as any).Zotero_Tabs;
      Zotero_Tabs.close(tabID);
    } catch {
      // Ignore errors
    }

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
   * Start sync polling
   */
  private static startSyncPolling() {
    if (!this.state || this.state.isCleaningUp) return;

    try {
      const primaryBrowser = this.state.primarySide === "left"
        ? this.state.leftBrowser
        : this.state.rightBrowser;

      const primaryContainer = this.getViewerContainerFromBrowser(primaryBrowser);
      if (!primaryContainer) return;

      this.state.scrollHandler = () => this.syncViews();
      primaryContainer.addEventListener("scroll", this.state.scrollHandler, { passive: true });
    } catch {
      // Browser may be dead
    }
  }

  /**
   * Stop sync polling
   */
  private static stopSyncPolling() {
    if (!this.state) return;

    // Remove scroll listener
    if (this.state.scrollHandler) {
      try {
        const primaryBrowser = this.state.primarySide === "left"
          ? this.state.leftBrowser
          : this.state.rightBrowser;
        const primaryContainer = this.getViewerContainerFromBrowser(primaryBrowser);
        if (primaryContainer) {
          primaryContainer.removeEventListener("scroll", this.state.scrollHandler);
        }
      } catch {
        // Browser may be dead
      }
      this.state.scrollHandler = null;
    }
  }

  private static SYNC_THRESHOLD = 1;

  /**
   * Sync scroll position between views
   * Uses cached viewer containers for performance
   */
  private static syncViews() {
    if (!this.state || this.state.isCleaningUp) return;
    if (!this.state.lastPrimaryScroll) return;
    if (this.state.syncPaused) return; // Skip sync during sidebar toggle

    // Skip scroll sync when Ctrl is pressed (user is doing Ctrl+wheel zoom)
    if (this.state.ctrlPressed) return;

    // Skip scroll sync during zoom operations
    if (this.state.zoomingCount > 0) return;

    try {
      // Use cached containers for performance (avoid repeated DOM queries during scroll)
      const primaryContainer = this.state.primarySide === "left"
        ? this.state.leftViewerContainer
        : this.state.rightViewerContainer;
      const secondaryContainer = this.state.primarySide === "left"
        ? this.state.rightViewerContainer
        : this.state.leftViewerContainer;

      if (!primaryContainer || !secondaryContainer) return;

      const deltaTop = primaryContainer.scrollTop - this.state.lastPrimaryScroll.top;
      const deltaLeft = primaryContainer.scrollLeft - this.state.lastPrimaryScroll.left;

      if (Math.abs(deltaTop) >= this.SYNC_THRESHOLD || Math.abs(deltaLeft) >= this.SYNC_THRESHOLD) {
        secondaryContainer.scrollTop = Math.max(0, secondaryContainer.scrollTop + deltaTop);
        secondaryContainer.scrollLeft = Math.max(0, secondaryContainer.scrollLeft + deltaLeft);

        this.state.lastPrimaryScroll = {
          top: primaryContainer.scrollTop,
          left: primaryContainer.scrollLeft,
        };
      }
    } catch {
      // Ignore sync errors
    }
  }

  /**
   * Call zoomIn on a browser's internal reader
   */
  private static zoomInForBrowser(browser: XULBrowserElement) {
    if (!this.isBrowserAlive(browser)) return;
    try {
      const internalReader = this.getInternalReaderFromBrowser(browser);
      if (internalReader && typeof internalReader.zoomIn === "function") {
        internalReader.zoomIn();
      }
    } catch {
      // Ignore zoom errors
    }
  }

  /**
   * Call zoomOut on a browser's internal reader
   */
  private static zoomOutForBrowser(browser: XULBrowserElement) {
    if (!this.isBrowserAlive(browser)) return;
    try {
      const internalReader = this.getInternalReaderFromBrowser(browser);
      if (internalReader && typeof internalReader.zoomOut === "function") {
        internalReader.zoomOut();
      }
    } catch {
      // Ignore zoom errors
    }
  }

  /**
   * Call zoomReset on a browser's internal reader
   */
  private static zoomResetForBrowser(browser: XULBrowserElement) {
    if (!this.isBrowserAlive(browser)) return;
    try {
      const internalReader = this.getInternalReaderFromBrowser(browser);
      if (internalReader && typeof internalReader.zoomReset === "function") {
        internalReader.zoomReset();
      }
    } catch {
      // Ignore zoom errors
    }
  }

  /**
   * Set contextPaneOpen state on a browser's internal reader
   * This controls whether the toggle button shows in the toolbar
   */
  private static setContextPaneOpenForBrowser(browser: XULBrowserElement, open: boolean) {
    if (!this.isBrowserAlive(browser)) return;
    try {
      const internalReader = this.getInternalReaderFromBrowser(browser);
      if (internalReader && typeof internalReader.setContextPaneOpen === "function") {
        internalReader.setContextPaneOpen(open);
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Set up observer to watch context pane collapsed state changes
   * When context pane is toggled via sidenav, update right reader's toggle button visibility
   */
  private static setupContextPaneObserver(win: Window) {
    if (!this.state || this.state.isCleaningUp) return;

    try {
      const contextPane = win.document.getElementById("zotero-context-pane");
      if (!contextPane) return;

      const self = this;
      const observer = new win.MutationObserver((mutations: MutationRecord[]) => {
        // Check state validity in callback
        if (!self.state || self.state.isCleaningUp) return;
        if (!self.isBrowserAlive(self.state.rightBrowser)) return;

        for (const mutation of mutations) {
          if (mutation.type === "attributes" && mutation.attributeName === "collapsed") {
            try {
              const isOpen = contextPane.getAttribute("collapsed") !== "true";
              self.setContextPaneOpenForBrowser(self.state.rightBrowser, isOpen);
            } catch {
              // Ignore dead object errors
            }
          }
        }
      });

      observer.observe(contextPane, {
        attributes: true,
        attributeFilter: ["collapsed"]
      });

      // Store observer for cleanup
      if (this.state) {
        (this.state as any).contextPaneObserver = observer;
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Set up Ctrl key listener on a browser's iframe to detect Ctrl+wheel zoom
   * and Ctrl+Plus/Minus keyboard shortcuts for zoom sync
   */
  private static setupCtrlKeyListener(browser: XULBrowserElement) {
    if (!this.state) return;

    try {
      const internalReader = this.getInternalReaderFromBrowser(browser);
      if (!internalReader) return;

      const primaryView = internalReader._primaryView;
      if (!primaryView) return;

      const iframe = primaryView._iframe;
      if (!iframe) return;

      const iframeWin = iframe.contentWindow;
      if (!iframeWin) return;

      const wrappedWin = (iframeWin as any).wrappedJSObject || iframeWin;
      const doc = wrappedWin.document;
      if (!doc) return;

      // Also get the reader.html window for keyboard events
      const readerWin = browser.contentWindow;
      const wrappedReaderWin = readerWin ? ((readerWin as any).wrappedJSObject || readerWin) : null;

      const self = this;
      const isLeft = browser === this.state.leftBrowser;

      const keydownHandler = (e: KeyboardEvent) => {
        if (!self.state) return;

        if (e.key === "Control") {
          self.state.ctrlPressed = true;
          return;
        }

        // Note: Ctrl+Plus/Minus zoom sync is handled by setupMainWindowKeyboardListener
        // to avoid duplicate handling when events propagate through multiple layers
      };
      // Use capture phase to intercept before Zotero/PDF.js handlers
      // Listen on both PDF iframe doc and reader window for better coverage
      this.trackEventListener(doc, "keydown", keydownHandler as EventListener, true);
      if (wrappedReaderWin && wrappedReaderWin.document) {
        this.trackEventListener(wrappedReaderWin.document, "keydown", keydownHandler as EventListener, true);
      }

      const keyupHandler = (e: KeyboardEvent) => {
        if (e.key === "Control" && self.state) {
          self.state.ctrlPressed = false;
        }
      };
      this.trackEventListener(doc, "keyup", keyupHandler as EventListener);

      const blurHandler = () => {
        if (self.state) {
          self.state.ctrlPressed = false;
        }
      };
      this.trackEventListener(wrappedWin, "blur", blurHandler as EventListener);
    } catch {
      // Ignore errors
    }
  }

  /**
   * Handle keyboard zoom (Ctrl+Plus/Minus) - sync to secondary
   */
  private static handleKeyboardZoom(isLeft: boolean, direction: "in" | "out") {
    if (!this.state || this.state.isCleaningUp) return;
    if (!this.state.syncEnabled) return;

    const secondaryBrowser = this.state.primarySide === "left"
      ? this.state.rightBrowser
      : this.state.leftBrowser;

    // Pause scroll sync during zoom
    this.state.zoomingCount++;

    // Sync zoom action to secondary
    if (direction === "in") {
      this.zoomInForBrowser(secondaryBrowser);
    } else {
      this.zoomOutForBrowser(secondaryBrowser);
    }

    // Resume scroll sync after zoom completes
    this.trackTimeout(() => {
      if (this.state) {
        this.state.zoomingCount = Math.max(0, this.state.zoomingCount - 1);
        if (this.state.zoomingCount === 0) {
          this.initSyncState();
        }
      }
    }, 150);
  }

  /**
   * Set up resize listener to pause scroll sync during window resize
   * This prevents false scroll sync when context pane expands/collapses
   */
  private static setupResizeListener(win: Window) {
    if (!this.state) return;

    const self = this;
    let resizeTimer: number | null = null;

    const resizeHandler = () => {
      if (!self.state) return;

      // Pause sync during resize
      self.state.syncPaused = true;

      // Clear any existing timer
      if (resizeTimer !== null) {
        win.clearTimeout(resizeTimer);
      }

      // Resume sync after resize settles and reinitialize sync state
      resizeTimer = win.setTimeout(() => {
        if (self.state) {
          // Reinitialize sync state with new positions after resize
          self.initSyncState();
          self.state.syncPaused = false;
        }
        resizeTimer = null;
      }, 200);
    };

    this.trackEventListener(win, "resize", resizeHandler as EventListener);
  }

  /**
   * Set up main window keyboard listener for Ctrl+=/- zoom sync
   * This catches keyboard events at the top level before they're consumed
   */
  private static setupMainWindowKeyboardListener(win: Window) {
    if (!this.state) return;

    const self = this;

    const keydownHandler = (e: KeyboardEvent) => {
      if (!self.state) return;
      if (!self.state.syncEnabled) return;
      if (!e.ctrlKey || e.altKey || e.metaKey) return;

      // Check if zoom key (support both Ctrl+=/- and Ctrl+Shift+=/-)
      // With Shift: key is "+" or "_"
      // Without Shift: key is "=" or "-"
      const isZoomIn = e.key === "+" || e.key === "=" ||
                       e.code === "Equal" || e.code === "NumpadAdd";
      const isZoomOut = e.key === "-" || e.key === "_" ||
                        e.code === "Minus" || e.code === "NumpadSubtract";

      if (!isZoomIn && !isZoomOut) return;

      // Determine which browser has focus to check if it's primary
      const activeElement = win.document.activeElement;
      const leftBrowserFocused = self.state.leftBrowser.contains(activeElement) ||
                                  self.state.leftBrowser === activeElement;
      const rightBrowserFocused = self.state.rightBrowser.contains(activeElement) ||
                                   self.state.rightBrowser === activeElement;

      // If neither browser is focused, use activeSide
      let isLeft: boolean;
      if (leftBrowserFocused) {
        isLeft = true;
      } else if (rightBrowserFocused) {
        isLeft = false;
      } else {
        isLeft = self.state.activeSide === "left";
      }

      const isPrimary = (isLeft && self.state.primarySide === "left") ||
                        (!isLeft && self.state.primarySide === "right");
      if (!isPrimary) return;

      // Sync zoom to secondary
      if (isZoomIn) {
        self.handleKeyboardZoom(isLeft, "in");
      } else if (isZoomOut) {
        self.handleKeyboardZoom(isLeft, "out");
      }
    };

    // Use capture phase at main window level
    this.trackEventListener(win, "keydown", keydownHandler as EventListener, true);
  }

  /**
   * Handle view state change (no-op, zoom sync is done via button listeners)
   */
  private static handleViewStateChange(_sourceBrowser: XULBrowserElement, _viewState: any) {
    // Zoom sync is handled by setupZoomButtonListeners for reliability
  }

  /**
   * Get viewer container from browser
   */
  private static getViewerContainerFromBrowser(browser: XULBrowserElement): Element | null {
    try {
      const internalReader = this.getInternalReaderFromBrowser(browser);
      if (!internalReader) return null;

      const primaryView = internalReader._primaryView;
      if (!primaryView) return null;

      const iframe = primaryView._iframe;
      if (!iframe) return null;

      const iframeWin = iframe.contentWindow;
      if (!iframeWin) return null;

      const wrappedWin = (iframeWin as any).wrappedJSObject || iframeWin;
      return wrappedWin.document?.getElementById("viewerContainer") || null;
    } catch {
      return null;
    }
  }

  /**
   * Cleanup state
   */
  /**
   * Set up focus listeners for context pane switching
   */
  private static setupFocusListeners(
    leftBrowser: XULBrowserElement,
    rightBrowser: XULBrowserElement,
    win: Window
  ) {
    if (!this.state) return;

    const self = this;

    // Helper function to handle focus change
    const handleFocus = (side: "left" | "right") => {
      if (!self.state) return;
      if (self.state.activeSide === side) return; // Already active

      self.state.activeSide = side;
      const parentItemID = side === "left"
        ? self.state.leftParentItemID
        : self.state.rightParentItemID;
      self.updateContextPane(win, parentItemID);
    };

    const leftClickHandler = () => handleFocus("left");
    const rightClickHandler = () => handleFocus("right");
    const leftFocusHandler = () => handleFocus("left");
    const rightFocusHandler = () => handleFocus("right");

    this.trackEventListener(leftBrowser, "click", leftClickHandler as EventListener, true);
    this.trackEventListener(rightBrowser, "click", rightClickHandler as EventListener, true);
    this.trackEventListener(leftBrowser, "focus", leftFocusHandler as EventListener, true);
    this.trackEventListener(rightBrowser, "focus", rightFocusHandler as EventListener, true);
  }

  /**
   * Update context pane to show the specified item
   * Based on Zotero's contextPane.js implementation
   */
  private static updateContextPane(win: Window, parentItemID: number) {
    try {
      if (!this.state || this.state.isCleaningUp) return;

      const document = win.document;
      const item = Zotero.Items.get(parentItemID);
      if (!item) return;

      const contextPaneElement = document.querySelector("context-pane") as any;
      if (!contextPaneElement) return;

      const itemPaneDeck = contextPaneElement._itemPaneDeck;
      if (!itemPaneDeck) return;

      let itemDetails = itemPaneDeck.querySelector(`[data-tab-id="${this.state.tabID}"]`) as any;

      if (itemDetails) {
        itemDetails.item = item;
        if (typeof itemDetails.render === "function") {
          itemDetails.render();
        }
      } else {

        itemDetails = document.createXULElement("item-details");
        itemDetails.id = this.state.tabID + "-context";
        itemDetails.dataset.tabId = this.state.tabID;
        itemDetails.className = "zotero-item-pane-content";
        itemPaneDeck.appendChild(itemDetails);

        // Set up the item-details properties
        const libraryID = item.libraryID;
        const library = Zotero.Libraries.get(libraryID);
        const editable = library && library.editable && !item.deleted;

        itemDetails.editable = editable;
        itemDetails.tabID = this.state.tabID;
        itemDetails.tabType = "reader"; // Use reader type for proper rendering
        itemDetails.item = item;

        if (contextPaneElement._sidenav) {
          itemDetails.sidenav = contextPaneElement._sidenav;
        }
      }

      itemPaneDeck.selectedPanel = itemDetails;
    } catch {
      // Ignore context pane errors
    }
  }

  /**
   * Register a notifier to handle tab selection and close events
   * This ensures the context pane is shown when our tab is selected
   * and cleanup happens when our tab is closed
   */
  private static registerTabNotifier(win: Window) {
    if (!this.state) return;

    const self = this;

    // Create a notifier observer for tab events
    const notifierCallback = {
      notify: (action: string, type: string, ids: (string | number)[], extraData: any) => {
        if (type !== "tab") return;
        if (!self.state) return;

        if (action === "select") {
          const selectedTabID = String(ids[0]);
          if (selectedTabID === self.state.tabID) {
            win.document.documentElement?.classList.add("split-view-active");
            self.showContextPaneForSplitView(win);
            // Update context pane content to show the active side's item
            const parentItemID = self.state.activeSide === "left"
              ? self.state.leftParentItemID
              : self.state.rightParentItemID;
            self.updateContextPane(win, parentItemID);
          } else {
            win.document.documentElement?.classList.remove("split-view-active");
          }
        } else if (action === "close") {
          // Handle tab close - cleanup our state
          const closedTabID = String(ids[0]);
          if (closedTabID === self.state.tabID && !self.state.isCleaningUp) {
            // Save states before cleanup
            const leftItemID = self.state.leftItemID;
            const rightItemID = self.state.rightItemID;
            const leftViewState = self.state.leftViewState;
            const rightViewState = self.state.rightViewState;

            // Try to get current state from browsers
            let leftCurrentState: any = null;
            let rightCurrentState: any = null;
            try {
              leftCurrentState = self.getCurrentViewStateFromBrowser(self.state.leftBrowser);
            } catch { /* Browser may be dead */ }
            try {
              rightCurrentState = self.getCurrentViewStateFromBrowser(self.state.rightBrowser);
            } catch { /* Browser may be dead */ }

            // Save states asynchronously
            Promise.all([
              self.saveViewStateToDisk(leftItemID, leftCurrentState || leftViewState),
              self.saveViewStateToDisk(rightItemID, rightCurrentState || rightViewState),
            ]).catch(() => { /* Ignore save errors */ });

            self.cleanupWithoutClosingTab();
          }
        }
      },
    };

    const notifierID = Zotero.Notifier.registerObserver(notifierCallback, ["tab"], "splitView", 20);
    this.state.notifierID = notifierID;
  }

  /**
   * Show context pane elements for our split view tab
   */
  private static showContextPaneForSplitView(win: Window) {
    const document = win.document;
    const ZoteroContextPane = (win as any).ZoteroContextPane;
    if (!ZoteroContextPane) return;

    const splitter = ZoteroContextPane.splitter;
    if (splitter) {
      splitter.setAttribute("hidden", "false");
    }

    const sidenav = ZoteroContextPane.sidenav;
    if (sidenav) {
      sidenav.hidden = false;
      sidenav.removeAttribute("hidden");
      sidenav.style.display = "";
      sidenav.style.visibility = "visible";
    }

    const sidenavById = document.getElementById("zotero-context-pane-sidenav") as HTMLElement | null;
    if (sidenavById) {
      (sidenavById as any).hidden = false;
      sidenavById.removeAttribute("hidden");
    }

    const contextPaneBox = document.getElementById("zotero-context-pane");
    if (contextPaneBox) {
      contextPaneBox.removeAttribute("hidden");
    }

    this.injectSidenavCSS(document);
  }

  /**
   * Inject CSS to keep sidenav visible when context pane is collapsed
   * Only applies when split-view tab is active (body has .split-view-active class)
   */
  private static injectSidenavCSS(document: Document) {
    const styleId = "split-view-sidenav-style";
    if (document.getElementById(styleId)) {
      // CSS already injected, just ensure the active class is set
      document.documentElement?.classList.add("split-view-active");
      return;
    }

    const style = document.createElement("style");
    style.id = styleId;
    // Override XUL's collapsed behavior for context pane
    // Zotero uses display:flex for context pane, we need to maintain that
    // when collapsed to keep sidenav visible
    style.textContent = `
      /* Override XUL collapse behavior - ONLY when split-view is active */
      /* Use the same display:flex as Zotero's _contextPane.scss */
      :root.split-view-active #zotero-context-pane {
        display: flex !important;
        flex-direction: row !important;
        flex-grow: 0 !important;
        flex-shrink: 0 !important;
      }
      :root.split-view-active #zotero-context-pane[collapsed="true"] {
        /* When collapsed, completely hide context pane (no sidenav) */
        display: none !important;
        width: 0 !important;
        min-width: 0 !important;
      }
      /* Sidenav - only show when context pane is NOT collapsed */
      :root.split-view-active #zotero-context-pane:not([collapsed="true"]) #zotero-context-pane-sidenav {
        display: flex !important;
        flex-direction: column !important;
        visibility: visible !important;
        pointer-events: auto !important;
        width: 37px !important;
        min-width: 37px !important;
        flex-shrink: 0 !important;
      }
      /* Remove hidden attribute effect when not collapsed */
      :root.split-view-active #zotero-context-pane:not([collapsed="true"]) #zotero-context-pane-sidenav[hidden] {
        display: flex !important;
        visibility: visible !important;
      }
      /* Also ensure the splitter behaves correctly */
      :root.split-view-active #zotero-context-splitter {
        display: flex !important;
        visibility: visible !important;
      }
      :root.split-view-active #zotero-context-splitter[hidden="true"] {
        display: none !important;
      }
      /* Dragging cursor for resizer */
      body.split-view-dragging,
      body.split-view-dragging * {
        cursor: ew-resize !important;
        user-select: none !important;
      }
    `;
    const target = document.head || document.documentElement;
    if (target) {
      target.appendChild(style);
    }

    document.documentElement?.classList.add("split-view-active");
  }

  /**
   * Set up context pane for our split view tab
   * Note: Polling removed - tab notifier handles tab selection events
   */
  private static setupContextPane(win: Window) {
    if (!this.state) return;

    // Initialize immediately
    this.showContextPaneForSplitView(win);

    // Single delayed call to ensure async updates complete
    // (Replaced multiple 50ms/150ms/300ms calls with a single 300ms call)
    this.trackTimeout(() => this.showContextPaneForSplitView(win), 300);

    // Note: Polling interval removed - registerTabNotifier() already handles
    // tab selection events and calls showContextPaneForSplitView() when needed
  }

  private static cleanup() {
    if (!this.state) return;

    // Prevent re-entry and dead object access
    if (this.state.isCleaningUp) return;
    this.state.isCleaningUp = true;

    // Save view states to disk before cleanup (fire and forget)
    const leftItemID = this.state.leftItemID;
    const rightItemID = this.state.rightItemID;
    const leftViewState = this.state.leftViewState;
    const rightViewState = this.state.rightViewState;

    // Try to get current state from browsers (may fail if dead)
    let leftCurrentState: any = null;
    let rightCurrentState: any = null;
    try {
      leftCurrentState = this.getCurrentViewStateFromBrowser(this.state.leftBrowser);
    } catch {
      // Browser may be dead
    }
    try {
      rightCurrentState = this.getCurrentViewStateFromBrowser(this.state.rightBrowser);
    } catch {
      // Browser may be dead
    }

    // Save states asynchronously (don't await)
    Promise.all([
      this.saveViewStateToDisk(leftItemID, leftCurrentState || leftViewState),
      this.saveViewStateToDisk(rightItemID, rightCurrentState || rightViewState),
    ]).catch(() => { /* Ignore save errors */ });

    // Unload browsers FIRST to prevent dead object errors from callbacks
    const leftBrowser = this.state.leftBrowser;
    const rightBrowser = this.state.rightBrowser;
    this.unloadBrowser(leftBrowser);
    this.unloadBrowser(rightBrowser);

    // Store references before nulling state
    const eventListeners = [...this.state.eventListeners];
    const timeoutIds = [...this.state.timeoutIds];
    const sidebarToggleTimers = [...this.state.sidebarToggleTimers];
    const visibilityIntervalId = this.state.visibilityIntervalId;
    const notifierID = this.state.notifierID;
    const contextPaneObserver = (this.state as any).contextPaneObserver;

    // Clear state arrays first
    this.state.eventListeners = [];
    this.state.timeoutIds = [];
    this.state.sidebarToggleTimers = [];
    this.state.leftViewerContainer = null;
    this.state.rightViewerContainer = null;
    this.state.visibilityIntervalId = null;
    this.state.notifierID = null;
    (this.state as any).contextPaneObserver = null;

    // Stop sync polling before other cleanup
    this.stopSyncPolling();

    let win: Window | null = null;
    try {
      win = Zotero.getMainWindow();
    } catch {
      // Window may be dead
    }

    // Remove split-view-active class
    if (win) {
      try {
        win.document.documentElement?.classList.remove("split-view-active");
      } catch {
        // Ignore errors - document may be dead
      }
    }

    // Remove all tracked event listeners
    for (const { target, type, listener, options } of eventListeners) {
      try {
        target.removeEventListener(type, listener, options);
      } catch {
        // Ignore removal errors (target may be dead)
      }
    }

    // Clear all tracked timeouts
    if (win) {
      for (const id of timeoutIds) {
        try {
          win.clearTimeout(id);
        } catch {
          // Ignore errors
        }
      }

      // Clear sidebar toggle timers
      for (const timerId of sidebarToggleTimers) {
        try {
          win.clearTimeout(timerId);
        } catch {
          // Ignore errors
        }
      }

      // Clear visibility check interval
      if (visibilityIntervalId !== null) {
        try {
          win.clearInterval(visibilityIntervalId);
        } catch {
          // Ignore errors
        }
      }
    }

    // Unregister tab notifier
    if (notifierID) {
      try {
        Zotero.Notifier.unregisterObserver(notifierID);
      } catch {
        // Ignore errors
      }
    }

    // Disconnect context pane observer
    if (contextPaneObserver) {
      try {
        contextPaneObserver.disconnect();
      } catch {
        // Ignore errors
      }
    }

    this.state = null;
  }

  // === PDF selector UI methods (retained from original) ===

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
