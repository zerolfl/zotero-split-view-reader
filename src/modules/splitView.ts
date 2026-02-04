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
   */
  private static createReaderBrowser(win: Window): XULBrowserElement {
    const browser = win.document.createXULElement("browser");
    browser.setAttribute("flex", "1");
    browser.setAttribute("type", "content");
    browser.setAttribute("transparent", "true");
    browser.setAttribute("src", "resource://zotero/reader/reader.html");
    (browser as any).style.minWidth = "200px";
    return browser;
  }

  /**
   * Cache viewer container references to avoid repeated DOM queries during scroll sync
   */
  private static cacheViewerContainers() {
    if (!this.state) return;
    this.state.leftViewerContainer = this.getViewerContainerFromBrowser(this.state.leftBrowser);
    this.state.rightViewerContainer = this.getViewerContainerFromBrowser(this.state.rightBrowser);
  }

  static registerContextMenu() {
    Zotero.Reader.registerEventListener(
      "createViewContextMenu",
      (event) => {
        const { reader, append } = event;

        // Check if we have an active split view
        const isInSplitView = this.state !== null;

        const menuItems: any[] = [];

        // First item: "Split-View Reader" toggle
        menuItems.push({
          label: getString("splitview-menu-label"),
          checked: isInSplitView,
          onCommand: () => {
            if (isInSplitView) {
              this.closeSplitTab();
            } else {
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
              if (currentSide) {
                this.setPrimarySide(currentSide);
              }
            },
          });

          // Third item: "Scroll Sync" with 📌 if enabled
          menuItems.push({
            label: (this.state.syncEnabled ? "📌 " : "") + getString("splitview-sync-actions"),
            onCommand: () => {
              this.toggleSync();
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
    if (!this.state) return;

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
      if (this.state) {
        this.cleanup();
      }

      const selectedPDF = await this.showItemPrompt(reader);
      if (!selectedPDF) return;

      await this.openSplitTab(reader.itemID, selectedPDF);
    } catch {
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
    if (!this.state) return;

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
      // Search for button with zoom-in/zoom-out icons or titles
      const findButton = (type: "in" | "out"): Element | null => {
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
        ] : [
          '[data-l10n-id="pdfjs-zoom-out-button"]',
          '#zoomOut',
          '.zoomOut',
          'button[class*="zoomOut"]',
          'button[class*="zoom-out"]',
          '[title*="Zoom Out"]',
          '[title*="zoom out"]',
          '[aria-label*="Zoom Out"]',
          '[aria-label*="zoom out"]',
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
          } else {
            if (className.includes("zoomout") || className.includes("zoom-out") ||
                title.includes("zoom out") || ariaLabel.includes("zoom out") ||
                title.includes("缩小") || ariaLabel.includes("缩小")) {
              return btn;
            }
          }
        }

        return null;
      };

      const zoomInBtn = findButton("in");
      const zoomOutBtn = findButton("out");

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

    } catch (e) {
      ztoolkit.log("SplitView: Error setting up zoom button listeners", e);
    }
  }

  /**
   * Handle zoom button click - sync to secondary if this is primary
   */
  private static handleZoomButtonClick(isLeft: boolean, direction: "in" | "out") {
    if (!this.state) return;
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
    } else {
      this.zoomOutForBrowser(secondaryBrowser);
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
   * Open split view in a single tab with two side-by-side browsers
   */
  private static async openSplitTab(primaryItemID: number, secondaryPDF: Zotero.Item) {
    // Clean up existing state
    this.cleanup();

    const win = Zotero.getMainWindow();
    const Zotero_Tabs = (win as any).Zotero_Tabs;

    // Get item info for tab title
    const leftItem = Zotero.Items.get(primaryItemID);
    const rightItem = secondaryPDF;
    const leftTitle = String(leftItem.getField("title") || "PDF 1").substring(0, 30);
    const rightTitle = String(rightItem.getField("title") || "PDF 2").substring(0, 30);

    // Create custom tab
    const { id, container } = Zotero_Tabs.add({
      type: "split-reader",
      title: `Split: ${leftTitle} | ${rightTitle}`,
      data: {
        leftItemID: primaryItemID,
        rightItemID: secondaryPDF.id,
      },
      select: true,
      onClose: () => {
        this.cleanup();
      },
    });

    // Build main horizontal layout: [PDFs container] [Sidenav]
    const mainHbox = win.document.createXULElement("hbox") as XULElement;
    mainHbox.setAttribute("flex", "1");
    (mainHbox as any).style.width = "100%";
    (mainHbox as any).style.height = "100%";

    // Left and right browsers using helper
    const leftBrowser = this.createReaderBrowser(win);
    const rightBrowser = this.createReaderBrowser(win);

    // Splitter for resizing between PDFs
    const splitter = win.document.createXULElement("splitter") as XULElement;
    splitter.setAttribute("resizebefore", "flex");
    splitter.setAttribute("resizeafter", "flex");
    (splitter as any).style.width = "6px";
    (splitter as any).style.cursor = "col-resize";
    (splitter as any).style.backgroundColor = "var(--material-background)";
    (splitter as any).style.borderLeft = "1px solid var(--material-border)";
    (splitter as any).style.borderRight = "1px solid var(--material-border)";

    // Create popupsets for context menus
    const leftPopupset = win.document.createXULElement("popupset") as XULElement;
    const rightPopupset = win.document.createXULElement("popupset") as XULElement;

    mainHbox.appendChild(leftBrowser);
    mainHbox.appendChild(splitter);
    mainHbox.appendChild(rightBrowser);
    container.appendChild(mainHbox);
    container.appendChild(leftPopupset);
    container.appendChild(rightPopupset);

    // Handle bottom placeholder resize events
    container.addEventListener("tab-bottom-placeholder-resize", (event: any) => {
      event.stopPropagation();
      // Ignore in split view
    });

    // Get parent item IDs for context pane switching
    const leftParentItemID = leftItem.parentItemID || leftItem.id;
    const rightParentItemID = rightItem.parentItemID || rightItem.id;

    // Initialize state
    this.state = {
      tabID: id,
      container: container as XUL.Box,
      leftBrowser,
      rightBrowser,
      leftPopupset,
      rightPopupset,
      leftItemID: primaryItemID,
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
      // Resource tracking
      eventListeners: [],
      timeoutIds: [],
      // Cached containers (will be set after readers initialize)
      leftViewerContainer: null,
      rightViewerContainer: null,
      visibilityIntervalId: null,
    };

    // Set up focus listeners for context pane switching
    this.setupFocusListeners(leftBrowser, rightBrowser, win);

    // Register tab notifier to handle tab selection
    this.registerTabNotifier(win);

    // Set up context pane like a normal reader tab
    this.setupContextPane(win);

    // Wait for browsers to load and initialize readers
    try {
      await Promise.all([
        this.initializeReader(leftBrowser, leftItem, leftPopupset),
        this.initializeReader(rightBrowser, rightItem, rightPopupset),
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

      // Enable sync and set up listeners after a short delay (ensure iframes are ready)
      this.trackTimeout(() => {
        if (this.state && this.state.syncEnabled) {
          // Cache viewer containers for efficient scroll sync
          this.cacheViewerContainers();

          // Initialize scroll sync
          this.initSyncState();
          this.startSyncPolling();

          // Set up resize listener to pause sync during window resize
          // (e.g., when context pane expands/collapses)
          this.setupResizeListener(win);

          // Set up Ctrl key listeners for detecting Ctrl+wheel zoom
          this.setupCtrlKeyListener(leftBrowser);
          this.setupCtrlKeyListener(rightBrowser);

          // Set up zoom button listeners for reliable zoom sync
          this.setupZoomButtonListeners(leftBrowser);
          this.setupZoomButtonListeners(rightBrowser);
        }
      }, 500);

      this.trackTimeout(() => {
        if (this.state) {
          this.updateContextPane(win, this.state.leftParentItemID);
        }
      }, 300);
    } catch (e) {
      this.cleanup();
      throw e;
    }
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
   */
  private static async initializeReader(
    browser: XULBrowserElement,
    item: Zotero.Item,
    popupset: XULElement
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

    // Create internal reader config - all callbacks defined inline, clone entire object once
    const readerConfig = {
      type: "pdf",
      data,
      annotations: validAnnotations,
      readOnly: false,
      authorName: item.library.libraryType === "group" ? Zotero.Users.getCurrentName() : "",
      showContextPaneToggle: false,
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
      // Required callbacks - defined as regular functions
      onOpenContextMenu: () => {
        const params = wrappedWin.contextMenuParams;
        if (params) {
          self.openContextMenu(browserRef, popupsetRef, params);
        }
      },
      onToggleSidebar: (open: boolean) => {
        // Sync sidebar toggle when sync is enabled
        self.handleSidebarToggle(browserRef, open);
      },
      onChangeSidebarWidth: (_width: number) => {
        // No-op for split view
      },
      onChangeViewState: (viewState: any, _primary: boolean) => {
        // Sync zoom when scale changes (toolbar zoom in/out)
        self.handleViewStateChange(browserRef, viewState);
      },
      onSaveAnnotations: async (annotations: any[], callback: () => void) => {
        await self.handleAnnotationSave(itemRef, annotations);
        if (callback) callback();
      },
      onDeleteAnnotations: (ids: string[]) => {
        self.handleAnnotationDelete(itemRef, ids);
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
        Zotero.launchURL(url);
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
   * Open context menu for a reader
   */
  private static openContextMenu(
    browser: XULBrowserElement,
    popupset: XULElement,
    params: { x: number; y: number; itemGroups: any[][] }
  ) {
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

      // Close Split View
      const closeItem = mainWindow.document.createXULElement("menuitem");
      closeItem.setAttribute("label", getString("splitview-menu-label"));
      closeItem.setAttribute("type", "checkbox");
      closeItem.setAttribute("checked", "true");
      closeItem.addEventListener("command", () => {
        this.closeSplitTab();
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
    if (!this.state) return;
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
    if (!this.state) return;

    const primaryBrowser = this.state.primarySide === "left"
      ? this.state.leftBrowser
      : this.state.rightBrowser;

    const primaryContainer = this.getViewerContainerFromBrowser(primaryBrowser);
    if (!primaryContainer) return;

    this.state.scrollHandler = () => this.syncViews();
    primaryContainer.addEventListener("scroll", this.state.scrollHandler, { passive: true });
  }

  /**
   * Stop sync polling
   */
  private static stopSyncPolling() {
    if (!this.state) return;

    // Remove scroll listener
    if (this.state.scrollHandler) {
      const primaryBrowser = this.state.primarySide === "left"
        ? this.state.leftBrowser
        : this.state.rightBrowser;
      const primaryContainer = this.getViewerContainerFromBrowser(primaryBrowser);
      if (primaryContainer) {
        primaryContainer.removeEventListener("scroll", this.state.scrollHandler);
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
    if (!this.state) return;
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

      const self = this;
      const isLeft = browser === this.state.leftBrowser;

      const keydownHandler = (e: KeyboardEvent) => {
        if (!self.state) return;

        if (e.key === "Control") {
          self.state.ctrlPressed = true;
          return;
        }

        // Handle Ctrl+Plus/Minus for zoom sync (only from primary side)
        if (e.ctrlKey && self.state.syncEnabled) {
          const isPrimary = (isLeft && self.state.primarySide === "left") ||
                            (!isLeft && self.state.primarySide === "right");
          if (!isPrimary) return;

          // Zoom in: Ctrl+= or Ctrl++ (numpad)
          const isZoomIn = e.key === "+" || e.key === "=" ||
                           e.code === "Equal" || e.code === "NumpadAdd";
          // Zoom out: Ctrl+- or Ctrl+- (numpad)
          const isZoomOut = e.key === "-" ||
                            e.code === "Minus" || e.code === "NumpadSubtract";

          if (isZoomIn) {
            self.handleKeyboardZoom(isLeft, "in");
          } else if (isZoomOut) {
            self.handleKeyboardZoom(isLeft, "out");
          }
        }
      };
      this.trackEventListener(doc, "keydown", keydownHandler as EventListener);

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
    if (!this.state) return;
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
      if (!this.state) return;

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
   * Register a notifier to handle tab selection events
   * This ensures the context pane is shown when our tab is selected
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
          } else {
            win.document.documentElement?.classList.remove("split-view-active");
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
        /* Keep flex display when collapsed, just shrink width */
        display: flex !important;
        flex-direction: row !important;
        visibility: visible !important;
        /* Only show sidenav width (37px) */
        width: 37px !important;
        min-width: 37px !important;
        max-width: 37px !important;
      }
      :root.split-view-active #zotero-context-pane[collapsed="true"] > vbox {
        /* Completely hide the inner content vbox */
        display: none !important;
        width: 0 !important;
        min-width: 0 !important;
        flex: 0 !important;
      }
      /* Sidenav - use specific ID from zoteroPane.xhtml */
      :root.split-view-active #zotero-context-pane-sidenav {
        /* Always keep sidenav visible with its natural size */
        display: flex !important;
        flex-direction: column !important;
        visibility: visible !important;
        pointer-events: auto !important;
        width: 37px !important;
        min-width: 37px !important;
        flex-shrink: 0 !important;
      }
      /* Remove hidden attribute effect */
      :root.split-view-active #zotero-context-pane-sidenav[hidden] {
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

    const win = Zotero.getMainWindow();

    // Remove split-view-active class
    try {
      win.document.documentElement?.classList.remove("split-view-active");
    } catch {
      // Ignore errors
    }

    // Remove all tracked event listeners
    for (const { target, type, listener, options } of this.state.eventListeners) {
      try {
        target.removeEventListener(type, listener, options);
      } catch {
        // Ignore removal errors (target may be dead)
      }
    }
    this.state.eventListeners = [];

    // Clear all tracked timeouts
    for (const id of this.state.timeoutIds) {
      try {
        win.clearTimeout(id);
      } catch {
        // Ignore errors
      }
    }
    this.state.timeoutIds = [];

    // Clear sidebar toggle timers
    for (const timerId of this.state.sidebarToggleTimers) {
      try {
        win.clearTimeout(timerId);
      } catch {
        // Ignore errors
      }
    }
    this.state.sidebarToggleTimers = [];

    // Clear visibility check interval (if any legacy code set it)
    if (this.state.visibilityIntervalId !== null) {
      try {
        win.clearInterval(this.state.visibilityIntervalId);
      } catch {
        // Ignore errors
      }
      this.state.visibilityIntervalId = null;
    }

    // Clear cached viewer containers
    this.state.leftViewerContainer = null;
    this.state.rightViewerContainer = null;

    // Unregister tab notifier
    if (this.state.notifierID) {
      Zotero.Notifier.unregisterObserver(this.state.notifierID);
      this.state.notifierID = null;
    }

    this.stopSyncPolling();
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
