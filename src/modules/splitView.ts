import { getString } from "../utils/locale";

const SPLIT_VIEW_ID = "addon-split-view-container";

export class SplitViewFactory {
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
   * Create our own split view by inserting an independent iframe next to
   * the primary reader. This avoids Zotero's toggleVerticalSplit entirely,
   * eliminating all race condition errors from reader.js.
   */
  private static async openSplitView(reader: any, pdfItem: Zotero.Item) {
    const filePath = await pdfItem.getFilePathAsync();
    if (!filePath) {
      throw new Error("SplitView: PDF file path not found");
    }

    // Find the reader's primary iframe to insert our view next to it
    const internalReader = reader._internalReader;
    const primaryView = internalReader._primaryView;
    const primaryIframe = primaryView._iframe as HTMLIFrameElement;
    const readerContainer = primaryIframe.parentElement as HTMLElement | null;
    if (!readerContainer) {
      throw new Error("SplitView: Cannot find reader container");
    }

    // Remove existing split view if any
    const existing = readerContainer.querySelector(`#${SPLIT_VIEW_ID}`);
    if (existing) existing.remove();

    // Make the container a flex row so primary + secondary sit side by side
    readerContainer.style.display = "flex";
    readerContainer.style.flexDirection = "row";
    primaryIframe.style.flex = "1";
    primaryIframe.style.minWidth = "0";

    // Create our secondary container + iframe
    const doc = primaryIframe.ownerDocument!;
    const container = doc.createElement("div");
    container.id = SPLIT_VIEW_ID;
    container.style.flex = "1";
    container.style.minWidth = "0";
    container.style.display = "flex";
    container.style.borderLeft = "2px solid var(--fill-quinary, #ccc)";

    const secondaryIframe = doc.createElement("iframe");
    secondaryIframe.style.width = "100%";
    secondaryIframe.style.height = "100%";
    secondaryIframe.style.border = "none";
    secondaryIframe.setAttribute(
      "src",
      "resource://zotero/reader/pdf/web/viewer.html",
    );

    container.appendChild(secondaryIframe);
    readerContainer.appendChild(container);

    // Wait for the iframe to load and PDFViewerApplication to initialize
    await new Promise<void>((resolve) => {
      secondaryIframe.addEventListener("load", () => resolve(), { once: true });
    });

    const rawWindow = secondaryIframe.contentWindow as any;
    const iframeWindow = rawWindow?.wrappedJSObject || rawWindow;

    // PDFViewerApplication needs time to initialize after iframe load
    await new Promise<void>((resolve) => {
      const check = () => {
        if (iframeWindow?.PDFViewerApplication?.initialized) {
          resolve();
        } else if (iframeWindow?.PDFViewerApplication?.initializedPromise) {
          iframeWindow.PDFViewerApplication.initializedPromise.then(resolve);
        } else {
          iframeWindow.setTimeout(check, 50);
        }
      };
      check();
    });

    const { PDFViewerApplication } = iframeWindow;

    // Load the PDF via binary data (file:// blocked by CSP)
    const data = await IOUtils.read(filePath);
    const args = Cu.cloneInto({ data }, iframeWindow);
    await PDFViewerApplication.open(args);

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
