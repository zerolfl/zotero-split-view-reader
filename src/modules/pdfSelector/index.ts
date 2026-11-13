import { commandPalette } from "../../ui/commandPalette";
import { getString } from "../../utils/locale";
import {
  getItemDescription,
  getPDFAttachments,
  searchPDFItems,
} from "./search";
import type { PDFSelectionRow, PDFSelectionView } from "./types";

export class PDFSelector {
  private cancel: (() => void) | null = null;

  constructor(
    private readonly createView: () => PDFSelectionView = () =>
      commandPalette.createSelectionView(),
    private readonly search: typeof searchPDFItems = searchPDFItems,
  ) {}

  dispose(): void {
    this.cancel?.();
    this.cancel = null;
  }

  select(
    libraryID?: number,
    placeholder?: string,
  ): Promise<Zotero.Item | null> {
    this.dispose();
    const view = this.createView();
    const hint = placeholder || getString("splitview-select-second-pdf");
    return new Promise((resolve) => {
      let closed = false;
      let revision = 0;
      let parent: Zotero.Item | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (item: Zotero.Item | null, showCommands = false) => {
        if (closed) return;
        closed = true;
        revision++;
        if (timer !== null) clearTimeout(timer);
        this.cancel = null;
        try {
          view.dispose(showCommands);
        } catch (error) {
          Zotero.logError(error as Error);
        } finally {
          resolve(item);
        }
      };
      this.cancel = () => finish(null);

      const fail = (error: unknown) => {
        Zotero.logError(error as Error);
        finish(null);
      };

      const choose = (item: Zotero.Item) => {
        if (closed) return;
        const attachments = getPDFAttachments(item);
        if (attachments.length === 1) {
          finish(attachments[0]);
        } else {
          parent = item;
          view.resetInput(hint);
          update("");
        }
      };

      const itemRows = (items: Zotero.Item[]): PDFSelectionRow[] =>
        items.map((item) => {
          const count = getPDFAttachments(item).length;
          return {
            title:
              String(item.getField("title") || "Untitled") +
              (count > 1 ? ` [${count} PDFs]` : ""),
            description: getItemDescription(item),
            select: () => choose(item),
          };
        });

      const attachmentRows = (
        item: Zotero.Item,
        text: string,
      ): PDFSelectionRow[] =>
        getPDFAttachments(item).flatMap((attachment) => {
          const title = String(
            attachment.getField("title") ||
              attachment.attachmentFilename ||
              "PDF",
          );
          if (!title.toLowerCase().includes(text.trim().toLowerCase()))
            return [];
          return [
            {
              title,
              description: String(item.getField("title") || ""),
              select: () => finish(attachment),
            },
          ];
        });

      const update = (text: string, debounce = false) => {
        const current = ++revision;
        if (timer !== null) clearTimeout(timer);
        const showResults = async () => {
          timer = null;
          const selectedParent = parent;
          const items = selectedParent
            ? null
            : await this.search(text, libraryID);
          if (closed || revision !== current) return;
          const rows = selectedParent
            ? attachmentRows(selectedParent, text)
            : itemRows(items!);
          view.render(
            rows,
            getString(
              !selectedParent && !text.trim()
                ? "splitview-no-open-pdf"
                : "splitview-not-found",
            ),
          );
        };
        const reportFailure = (error: unknown) => {
          if (!closed && revision === current) fail(error);
        };
        if (debounce && text.trim()) {
          timer = setTimeout(
            () => {
              void showResults().catch(reportFailure);
            },
            parent ? 200 : 300,
          );
        } else {
          void showResults().catch(reportFailure);
        }
      };

      try {
        view.open(hint, {
          input: (text) => update(text, true),
          close: () => finish(null),
          back: () => {
            if (parent) {
              parent = null;
              view.resetInput(hint);
              update("");
            } else {
              finish(null, true);
            }
          },
        });
        update("");
      } catch (error) {
        fail(error);
      }
    });
  }
}
