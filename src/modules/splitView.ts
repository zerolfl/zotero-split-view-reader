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
  leftInternalReader: any;
  rightInternalReader: any;
  syncEnabled: boolean;
  primarySide: "left" | "right";
  activeSide: "left" | "right"; // Which PDF is currently focused/active
  syncInterval: ReturnType<typeof setInterval> | null;
  scrollHandler: (() => void) | null;
  lastPrimaryScroll: { top: number; left: number } | null;
  lastSyncedZoom: number | null;
  notifierID: string | null;
}

export class SplitViewFactory {
  private static state: SplitTabState | null = null;

  /**
   * Check if a browser/reader is valid
   */
  private static isBrowserValid(browser: XULBrowserElement | null): boolean {
    try {
      if (!browser) return false;
      // Check if browser element is still in DOM
      if (!browser.parentNode) return false;
      // Check if contentWindow exists
      if (!browser.contentWindow) return false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the currently active reader from Zotero (for context menu)
   */
  private static getCurrentReader(): any {
    try {
      const readers = (Zotero.Reader as any)._readers || [];
      for (const r of readers) {
        try {
          if (r.itemID && r.tabID) {
            return r;
          }
        } catch {
          continue;
        }
      }
      for (const r of readers) {
        try {
          if (r.itemID) {
            return r;
          }
        } catch {
          continue;
        }
      }
    } catch (e) {
      ztoolkit.log("SplitView: Error getting current reader", e);
    }
    return null;
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
            try {
              if (isInSplitView) {
                this.closeSplitTab();
              } else {
                this.handleSplitView(reader);
              }
            } catch (e) {
              ztoolkit.log("SplitView: Error in menu command", e);
              this.cleanup();
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
    } catch (e) {
      ztoolkit.log("SplitView: Error in handleSplitView", e);
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
   * Initialize sync state - record primary's current position and sync zoom
   */
  private static initSyncState() {
    if (!this.state) return;

    const primaryContainer = this.state.primarySide === "left"
      ? this.getViewerContainerFromBrowser(this.state.leftBrowser)
      : this.getViewerContainerFromBrowser(this.state.rightBrowser);
    const secondaryBrowser = this.state.primarySide === "left"
      ? this.state.rightBrowser
      : this.state.leftBrowser;

    if (primaryContainer) {
      this.state.lastPrimaryScroll = {
        top: primaryContainer.scrollTop,
        left: primaryContainer.scrollLeft,
      };
    }

    // Sync zoom immediately
    const primaryZoom = this.state.primarySide === "left"
      ? this.getZoomLevelFromBrowser(this.state.leftBrowser)
      : this.getZoomLevelFromBrowser(this.state.rightBrowser);
    if (primaryZoom !== null) {
      this.setZoomLevelForBrowser(secondaryBrowser, primaryZoom);
      this.state.lastSyncedZoom = primaryZoom;
    }

    ztoolkit.log("SplitView: Sync initialized",
      "lastPrimaryScroll:", this.state.lastPrimaryScroll,
      "zoom:", this.state.lastSyncedZoom);
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
        ztoolkit.log("SplitView: Tab closed");
        this.cleanup();
      },
    });

    // Build main horizontal layout: [PDFs container] [Sidenav]
    const mainHbox = win.document.createXULElement("hbox") as XULElement;
    mainHbox.setAttribute("flex", "1");
    (mainHbox as any).style.width = "100%";
    (mainHbox as any).style.height = "100%";

    // Left browser
    const leftBrowser = win.document.createXULElement("browser");
    leftBrowser.setAttribute("flex", "1");
    leftBrowser.setAttribute("type", "content");
    leftBrowser.setAttribute("transparent", "true");
    leftBrowser.setAttribute("src", "resource://zotero/reader/reader.html");
    (leftBrowser as any).style.minWidth = "200px";

    // Splitter for resizing between PDFs
    const splitter = win.document.createXULElement("splitter") as XULElement;
    splitter.setAttribute("resizebefore", "flex");
    splitter.setAttribute("resizeafter", "flex");
    (splitter as any).style.width = "6px";
    (splitter as any).style.cursor = "col-resize";
    (splitter as any).style.backgroundColor = "var(--material-background)";
    (splitter as any).style.borderLeft = "1px solid var(--material-border)";
    (splitter as any).style.borderRight = "1px solid var(--material-border)";

    // Right browser
    const rightBrowser = win.document.createXULElement("browser");
    rightBrowser.setAttribute("flex", "1");
    rightBrowser.setAttribute("type", "content");
    rightBrowser.setAttribute("transparent", "true");
    rightBrowser.setAttribute("src", "resource://zotero/reader/reader.html");
    (rightBrowser as any).style.minWidth = "200px";

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
      leftInternalReader: null,
      rightInternalReader: null,
      syncEnabled: true,
      primarySide: "left",
      activeSide: "left", // Left is initially active
      syncInterval: null,
      scrollHandler: null,
      lastPrimaryScroll: null,
      lastSyncedZoom: null,
      notifierID: null,
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

      // Store internal reader references
      this.state.leftInternalReader = this.getInternalReaderFromBrowser(leftBrowser);
      this.state.rightInternalReader = this.getInternalReaderFromBrowser(rightBrowser);

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

      // Enable sync by default after a short delay
      setTimeout(() => {
        if (this.state && this.state.syncEnabled) {
          this.initSyncState();
          this.startSyncPolling();
          ztoolkit.log("SplitView: Sync enabled by default");
        }
      }, 500);

      // Initialize context pane with left (primary) PDF's parent item
      setTimeout(() => {
        if (this.state) {
          this.updateContextPane(win, this.state.leftParentItemID);
        }
      }, 300);
    } catch (e) {
      ztoolkit.log("SplitView: Error initializing readers", e);
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
          // Ensure tags is always an array
          json.tags = json.tags || [];
          return json;
        } catch (e) {
          ztoolkit.log("SplitView: Error getting annotation", e);
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
      onChangeViewState: (_state: any, _primary: boolean) => {
        // No-op for split view - we don't persist view state
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

      // Find and hide the sidenav element inside the reader
      const sidenav = doc.querySelector(".sidenav, reader-sidenav, #sidenav, [class*='sidenav']");
      if (sidenav) {
        sidenav.style.display = "none";
        ztoolkit.log("SplitView: Hidden reader internal sidenav");
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
    } catch (e) {
      ztoolkit.log("SplitView: Error hiding reader sidenav", e);
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
        // Set key from id (reader uses id, Zotero uses key)
        annotation.key = annotation.id;
        // Remove authorName to prevent setting annotationAuthorName unnecessarily
        delete annotation.authorName;
        // Save annotation using Zotero's API
        await Zotero.Annotations.saveFromJSON(attachment, annotation);
      }
    } catch (e) {
      ztoolkit.log("SplitView: Error saving annotations", e);
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
        // Make sure the annotation actually belongs to the current PDF
        if (annotation && annotation.isAnnotation() && annotation.parentID === item.id) {
          await annotation.eraseTx();
        }
      }
    } catch (e) {
      ztoolkit.log("SplitView: Error deleting annotations", e);
    }
  }

  /**
   * Handle sidebar toggle - sync to the other reader when sync is enabled
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

    // Get the secondary browser
    const secondaryBrowser = isLeft ? this.state.rightBrowser : this.state.leftBrowser;

    // Toggle sidebar on secondary reader
    try {
      const internalReader = this.getInternalReaderFromBrowser(secondaryBrowser);
      if (internalReader && typeof internalReader.toggleSidebar === "function") {
        internalReader.toggleSidebar(open);
      } else if (internalReader && internalReader._primaryView) {
        // Try alternative method - set sidebar state directly
        const primaryView = internalReader._primaryView;
        if (primaryView && typeof primaryView.setSidebarOpen === "function") {
          primaryView.setSidebarOpen(open);
        }
      }
    } catch (e) {
      ztoolkit.log("SplitView: Error syncing sidebar toggle", e);
    }
  }

  /**
   * Close split tab
   */
  private static closeSplitTab() {
    if (!this.state) return;

    ztoolkit.log("SplitView: Closing split tab");

    const tabID = this.state.tabID;

    // Cleanup state first
    this.cleanup();

    // Close the tab
    try {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = (win as any).Zotero_Tabs;
      Zotero_Tabs.close(tabID);
    } catch (e) {
      ztoolkit.log("SplitView: Error closing tab", e);
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

    ztoolkit.log("SplitView: Starting scroll sync, primary side:", this.state.primarySide);

    const primaryBrowser = this.state.primarySide === "left"
      ? this.state.leftBrowser
      : this.state.rightBrowser;

    const primaryContainer = this.getViewerContainerFromBrowser(primaryBrowser);
    if (!primaryContainer) {
      ztoolkit.log("SplitView: Could not find primary container for scroll listener");
      return;
    }

    // Create scroll handler
    this.state.scrollHandler = () => this.syncViews();

    // Listen to scroll events
    primaryContainer.addEventListener("scroll", this.state.scrollHandler, { passive: true });

    // Backup interval for zoom sync
    this.state.syncInterval = setInterval(() => {
      this.syncZoomOnly();
    }, 200);
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

    // Clear zoom sync interval
    if (this.state.syncInterval) {
      clearInterval(this.state.syncInterval);
      this.state.syncInterval = null;
    }
  }

  private static SYNC_THRESHOLD = 1;

  /**
   * Sync scroll position between views
   */
  private static syncViews() {
    if (!this.state) return;
    if (!this.state.lastPrimaryScroll) return;

    try {
      const primaryBrowser = this.state.primarySide === "left"
        ? this.state.leftBrowser
        : this.state.rightBrowser;
      const secondaryBrowser = this.state.primarySide === "left"
        ? this.state.rightBrowser
        : this.state.leftBrowser;

      const primaryContainer = this.getViewerContainerFromBrowser(primaryBrowser);
      const secondaryContainer = this.getViewerContainerFromBrowser(secondaryBrowser);

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
   * Sync zoom only
   */
  private static syncZoomOnly() {
    if (!this.state) return;

    try {
      const primaryBrowser = this.state.primarySide === "left"
        ? this.state.leftBrowser
        : this.state.rightBrowser;
      const secondaryBrowser = this.state.primarySide === "left"
        ? this.state.rightBrowser
        : this.state.leftBrowser;

      this.syncZoom(primaryBrowser, secondaryBrowser);
    } catch {
      // Ignore errors
    }
  }

  private static ZOOM_THRESHOLD = 0.01;

  /**
   * Sync zoom level from primary to secondary
   */
  private static syncZoom(primaryBrowser: XULBrowserElement, secondaryBrowser: XULBrowserElement) {
    if (!this.state) return;

    const primaryZoom = this.getZoomLevelFromBrowser(primaryBrowser);
    if (primaryZoom === null) return;

    if (this.state.lastSyncedZoom !== null &&
        Math.abs(primaryZoom - this.state.lastSyncedZoom) < this.ZOOM_THRESHOLD) {
      return;
    }

    this.setZoomLevelForBrowser(secondaryBrowser, primaryZoom);
    this.state.lastSyncedZoom = primaryZoom;
  }

  /**
   * Get zoom level from browser
   */
  private static getZoomLevelFromBrowser(browser: XULBrowserElement): number | null {
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
      const pdfViewer = wrappedWin.PDFViewerApplication?.pdfViewer;
      if (pdfViewer && typeof pdfViewer.currentScale === "number") {
        return pdfViewer.currentScale;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Set zoom level for browser
   */
  private static setZoomLevelForBrowser(browser: XULBrowserElement, scale: number) {
    try {
      const internalReader = this.getInternalReaderFromBrowser(browser);
      if (!internalReader) return;

      const primaryView = internalReader._primaryView;
      if (!primaryView) return;

      if (typeof primaryView.setScale === "function") {
        primaryView.setScale(scale);
        return;
      }

      const iframe = primaryView._iframe;
      if (!iframe) return;

      const iframeWin = iframe.contentWindow;
      if (!iframeWin) return;

      const wrappedWin = (iframeWin as any).wrappedJSObject || iframeWin;
      const pdfViewer = wrappedWin.PDFViewerApplication?.pdfViewer;
      if (pdfViewer && typeof pdfViewer.currentScale === "number") {
        wrappedWin.setTimeout(() => {
          try {
            pdfViewer.currentScale = scale;
          } catch {
            // Ignore
          }
        }, 0);
      }
    } catch {
      // Ignore
    }
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

      ztoolkit.log(`SplitView: Focus changed to ${side} side, item ${parentItemID}`);
      self.updateContextPane(win, parentItemID);
    };

    // Add click listeners to browser elements
    leftBrowser.addEventListener("click", () => handleFocus("left"), true);
    rightBrowser.addEventListener("click", () => handleFocus("right"), true);

    // Also listen for focus events
    leftBrowser.addEventListener("focus", () => handleFocus("left"), true);
    rightBrowser.addEventListener("focus", () => handleFocus("right"), true);

    ztoolkit.log("SplitView: Focus listeners set up for context pane switching");
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
      if (!item) {
        ztoolkit.log(`SplitView: Item ${parentItemID} not found`);
        return;
      }

      // Don't force context pane open - respect user's previous collapsed state
      // The sidenav (toggle button) will remain visible via CSS even when collapsed

      // Get context-pane element
      const contextPaneElement = document.querySelector("context-pane") as any;
      if (!contextPaneElement) {
        ztoolkit.log(`SplitView: context-pane element not found`);
        return;
      }

      // Access the item pane deck (from Zotero's contextPane.js)
      const itemPaneDeck = contextPaneElement._itemPaneDeck;
      if (!itemPaneDeck) {
        ztoolkit.log(`SplitView: _itemPaneDeck not found`);
        return;
      }

      // Find the item-details element for our tab
      let itemDetails = itemPaneDeck.querySelector(`[data-tab-id="${this.state.tabID}"]`) as any;

      if (itemDetails) {
        // Update the item property directly
        itemDetails.item = item;
        // Re-render if the method exists
        if (typeof itemDetails.render === "function") {
          itemDetails.render();
        }
        ztoolkit.log(`SplitView: Updated item-details.item to ${parentItemID} (${item.getField("title")})`);
      } else {
        // Item-details doesn't exist for our tab, create one
        ztoolkit.log(`SplitView: Creating new item-details for tab ${this.state.tabID}`);

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

        // Set sidenav if available
        if (contextPaneElement._sidenav) {
          itemDetails.sidenav = contextPaneElement._sidenav;
        }

        ztoolkit.log(`SplitView: Created item-details for item ${parentItemID}`);
      }

      // Make sure our item-details is selected in the deck
      itemPaneDeck.selectedPanel = itemDetails;

    } catch (e) {
      ztoolkit.log("SplitView: Error updating context pane", e);
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
            // Our tab was selected - show context pane and add active class
            win.document.documentElement?.classList.add("split-view-active");
            self.showContextPaneForSplitView(win, true);
          } else {
            // Another tab was selected - remove active class
            win.document.documentElement?.classList.remove("split-view-active");
          }
        }
      },
    };

    // Register the notifier with high priority (like contextPane does)
    const notifierID = Zotero.Notifier.registerObserver(notifierCallback, ["tab"], "splitView", 20);
    this.state.notifierID = notifierID;

    ztoolkit.log("SplitView: Tab notifier registered");
  }

  /**
   * Show context pane elements for our split view tab
   * Mimics what Zotero does for reader tabs in contextPane.js _handleTabSelect
   */
  private static showContextPaneForSplitView(win: Window, log = false) {
    const document = win.document;
    const ZoteroContextPane = (win as any).ZoteroContextPane;

    if (!ZoteroContextPane) {
      return;
    }

    // Show the context pane splitter (hidden="false")
    const splitter = ZoteroContextPane.splitter;
    if (splitter) {
      splitter.setAttribute("hidden", "false");
    }

    // Show the sidenav (contains toggle button) - try multiple ways
    const sidenav = ZoteroContextPane.sidenav;
    if (sidenav) {
      sidenav.hidden = false;
      sidenav.removeAttribute("hidden");
      // Ensure it's visible
      sidenav.style.display = "";
      sidenav.style.visibility = "visible";
    }

    // Also get sidenav directly by ID as backup
    const sidenavById = document.getElementById("zotero-context-pane-sidenav") as HTMLElement | null;
    if (sidenavById) {
      (sidenavById as any).hidden = false;
      sidenavById.removeAttribute("hidden");
    }

    // Get the context pane box - ensure it's not hidden
    const contextPaneBox = document.getElementById("zotero-context-pane");
    if (contextPaneBox) {
      contextPaneBox.removeAttribute("hidden");
      // Don't touch collapsed - let user control it via toggle button
    }

    // Inject CSS to keep sidenav visible even when context pane is collapsed
    this.injectSidenavCSS(document);

    if (log) {
      ztoolkit.log("SplitView: Context pane shown for split view");
    }
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
      ztoolkit.log("SplitView: Injected sidenav CSS");
    }

    // Add the active class since we're in split view
    document.documentElement?.classList.add("split-view-active");
  }

  /**
   * Set up context pane for our split view tab
   * Makes our tab behave like a normal reader tab with proper context pane support
   */
  private static setupContextPane(win: Window) {
    if (!this.state) return;

    // Initial setup - show context pane immediately (with logging)
    this.showContextPaneForSplitView(win, true);

    // Also set up with delays to handle async Zotero updates
    win.setTimeout(() => this.showContextPaneForSplitView(win), 50);
    win.setTimeout(() => this.showContextPaneForSplitView(win), 150);
    win.setTimeout(() => this.showContextPaneForSplitView(win), 300);

    // Set up periodic check to maintain the state (less frequent, no logging)
    const checkInterval = win.setInterval(() => {
      if (!this.state) {
        win.clearInterval(checkInterval);
        return;
      }
      const Zotero_Tabs = (win as any).Zotero_Tabs;
      if (Zotero_Tabs && Zotero_Tabs.selectedID === this.state.tabID) {
        this.showContextPaneForSplitView(win, false);
      }
    }, 1000); // Reduced frequency

    // Store interval for cleanup
    (this.state as any)._visibilityInterval = checkInterval;

    ztoolkit.log("SplitView: Context pane setup complete");
  }

  private static cleanup() {
    if (!this.state) return;

    // Remove split-view-active class
    try {
      const win = Zotero.getMainWindow();
      win.document.documentElement?.classList.remove("split-view-active");
    } catch {
      // Ignore errors
    }

    // Unregister tab notifier
    if (this.state.notifierID) {
      Zotero.Notifier.unregisterObserver(this.state.notifierID);
      this.state.notifierID = null;
    }

    // Clear visibility check interval
    if ((this.state as any)._visibilityInterval) {
      clearInterval((this.state as any)._visibilityInterval);
      (this.state as any)._visibilityInterval = null;
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
