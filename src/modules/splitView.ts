import { getString } from "../utils/locale";

/**
 * Multi-PDF Split View using Zotero's native split view mechanism.
 *
 * This approach:
 * 1. Uses reader.toggleVerticalSplit() to enable native split view
 * 2. Loads a different PDF into the secondary view's PDFViewerApplication
 * 3. Benefits: menu checkmarks work, close functionality works
 *
 * Note: Since the secondary view is initialized for the same item as primary,
 * annotations made in the secondary view might not persist correctly for
 * a different PDF. The secondary view is best used for reference/reading.
 */
export class SplitViewFactory {
  // Track whether we loaded a custom PDF into the secondary view
  private static customSecondaryPDFPath: string | null = null;

  static registerContextMenu() {
    Zotero.Reader.registerEventListener(
      "createViewContextMenu",
      (event) => {
        const { reader, append } = event;
        append({
          label: getString("splitview-menu-label"),
          onCommand: () => {
            this.handleSplitView(reader as any);
          },
        });
      },
      addon.data.config.addonID,
    );
  }

  private static async handleSplitView(reader: any) {
    try {
      const selectedPDF = await this.showItemPrompt(reader);
      if (!selectedPDF) return;

      await this.openSplitView(reader, selectedPDF);
    } catch (e) {
      ztoolkit.log("SplitView: Error in handleSplitView", e);
    }
  }

  /**
   * Open split view using Zotero's native mechanism, then load
   * a different PDF into the secondary view.
   */
  private static async openSplitView(reader: any, pdfItem: Zotero.Item) {
    const filePath = await pdfItem.getFilePathAsync();
    if (!filePath) {
      throw new Error("SplitView: PDF file path not found");
    }

    const internalReader = reader._internalReader;

    // Enable native vertical split if not already enabled
    if (internalReader.splitType !== "vertical") {
      reader.toggleVerticalSplit(true);
    }

    // Wait for secondary view to be created
    const secondaryView = await this.waitForSecondaryView(internalReader);
    if (!secondaryView) {
      throw new Error("SplitView: Secondary view not created");
    }

    ztoolkit.log(
      "SplitView: Secondary view obtained",
      "type:",
      typeof secondaryView,
      "keys:",
      Object.keys(secondaryView).slice(0, 10),
    );

    // Get the secondary view's iframe window
    // PDFView stores the iframe window in _iframeWindow, but we may need to wait
    let rawWindow = secondaryView._iframeWindow;
    let iframe = secondaryView._iframe as HTMLIFrameElement | undefined;

    ztoolkit.log(
      "SplitView: Initial check - _iframeWindow:",
      !!rawWindow,
      "_iframe:",
      !!iframe,
    );

    // If no window yet, wait for iframe to load
    if (!rawWindow && iframe) {
      ztoolkit.log("SplitView: Waiting for iframe to load...");
      await new Promise<void>((resolve) => {
        const onLoad = () => {
          iframe!.removeEventListener("load", onLoad);
          resolve();
        };
        // Check if already loaded
        if (iframe.contentDocument?.readyState === "complete") {
          resolve();
        } else {
          iframe.addEventListener("load", onLoad);
          // Timeout fallback
          setTimeout(resolve, 5000);
        }
      });
      rawWindow = iframe.contentWindow;
    }

    if (!rawWindow) {
      throw new Error("SplitView: Cannot access secondary view iframe window");
    }

    const iframeWindow = (rawWindow as any)?.wrappedJSObject || rawWindow;
    ztoolkit.log("SplitView: Got iframeWindow, loading PDF...");
    await this.loadPDFIntoWindow(iframeWindow, filePath, pdfItem);
  }

  /**
   * Load a PDF into an iframe window's PDFViewerApplication
   */
  private static async loadPDFIntoWindow(
    iframeWindow: any,
    filePath: string,
    pdfItem: Zotero.Item,
  ) {
    // Wait for PDFViewerApplication to be initialized
    await this.waitForPDFViewerApplication(iframeWindow);

    const { PDFViewerApplication } = iframeWindow;

    // Ensure text layer is enabled for text selection
    const pdfViewer = PDFViewerApplication.pdfViewer;
    if (pdfViewer) {
      pdfViewer.textLayerMode = 1; // TextLayerMode.ENABLE
    }

    // Load the new PDF via binary data
    const data = await IOUtils.read(filePath);
    const args = Cu.cloneInto({ data }, iframeWindow);
    await PDFViewerApplication.open(args);

    // Track that we loaded a custom PDF
    this.customSecondaryPDFPath = filePath;

    // Fix text selection: inject CSS to ensure no overlay blocks pointer events
    this.injectTextSelectionFix(iframeWindow);

    const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
    })
      .createLine({
        text: `${getString("splitview-loaded")}: ${pdfItem.getField("title") || (pdfItem as any).attachmentFilename}`,
        type: "default",
      })
      .show();
    popup.startCloseTimer(3000);
  }

  /**
   * Wait for the secondary view to be created and fully initialized
   * (including its iframe window)
   */
  private static waitForSecondaryView(
    internalReader: any,
    timeout = 10000,
  ): Promise<any> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const check = () => {
        const sv = internalReader._secondaryView;
        if (!sv) {
          if (Date.now() - startTime > timeout) {
            ztoolkit.log("SplitView: Timeout - secondary view not created");
            resolve(null);
          } else {
            setTimeout(check, 100);
          }
          return;
        }

        // Secondary view exists, now check for iframe window
        // Try multiple ways to access the window
        let iframeWindow = sv._iframeWindow;
        if (!iframeWindow && sv._iframe) {
          iframeWindow = sv._iframe.contentWindow;
        }

        if (iframeWindow) {
          ztoolkit.log("SplitView: Secondary view iframe ready");
          resolve(sv);
        } else if (Date.now() - startTime > timeout) {
          ztoolkit.log(
            "SplitView: Timeout waiting for iframe window",
            "_iframeWindow:",
            !!sv._iframeWindow,
            "_iframe:",
            !!sv._iframe,
            "_iframe.contentWindow:",
            !!(sv._iframe && sv._iframe.contentWindow),
          );
          // Return the secondary view anyway, we'll try fallback in caller
          resolve(sv);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  /**
   * Wait for PDFViewerApplication to be fully initialized
   */
  private static waitForPDFViewerApplication(
    iframeWindow: any,
    timeout = 5000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const check = () => {
        if (iframeWindow?.PDFViewerApplication?.initialized) {
          resolve();
        } else if (iframeWindow?.PDFViewerApplication?.initializedPromise) {
          iframeWindow.PDFViewerApplication.initializedPromise.then(resolve);
        } else if (Date.now() - startTime > timeout) {
          reject(new Error("PDFViewerApplication initialization timeout"));
        } else {
          iframeWindow.setTimeout(check, 50);
        }
      };
      check();
    });
  }

  /**
   * Inject CSS to fix text selection in the secondary view
   */
  private static injectTextSelectionFix(iframeWindow: any) {
    const iframeDoc = iframeWindow.document;
    const existingFix = iframeDoc.getElementById("split-view-text-fix");
    if (existingFix) return;

    const fixStyle = iframeDoc.createElement("style");
    fixStyle.id = "split-view-text-fix";
    fixStyle.textContent = `
      .textLayer {
        pointer-events: auto !important;
      }
      .textLayer span,
      .textLayer br {
        user-select: text !important;
        -moz-user-select: text !important;
      }
      .annotationEditorLayer {
        pointer-events: none !important;
      }
    `;
    iframeDoc.head.appendChild(fixStyle);
  }

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
