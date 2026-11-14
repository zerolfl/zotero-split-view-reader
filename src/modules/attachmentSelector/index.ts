import { commandPalette } from "../../ui/commandPalette";
import { getString } from "../../utils/locale";
import {
  getItemDescription,
  getSelectableAttachments,
  searchPDFItems,
  searchReaderItems,
} from "./search";
import type { AttachmentSelectionRow, AttachmentSelectionView } from "./types";
import type { AttachmentSelectionMode } from "./search";

export class AttachmentSelector {
  private cancel: (() => void) | null = null;

  constructor(
    private readonly createView: () => AttachmentSelectionView = () =>
      commandPalette.createSelectionView(),
    private readonly search: (
      text: string,
      libraryID: number | undefined,
      mode: AttachmentSelectionMode,
    ) => Promise<Zotero.Item[]> = (text, libraryID, mode) =>
      mode === "pdf"
        ? searchPDFItems(text, libraryID)
        : searchReaderItems(text, libraryID),
  ) {}

  dispose(): void {
    this.cancel?.();
    this.cancel = null;
  }

  select(
    libraryID?: number,
    placeholder?: string,
    mode: AttachmentSelectionMode = "pdf",
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
        const attachments = getSelectableAttachments(item, mode);
        if (attachments.length === 1) {
          finish(attachments[0]);
        } else {
          parent = item;
          view.resetInput(hint);
          update("");
        }
      };

      const itemRows = (items: Zotero.Item[]): AttachmentSelectionRow[] =>
        items.map((item) => {
          if (item.isFileAttachment()) {
            return {
              title: String(
                item.getField("title") || item.attachmentFilename || "File",
              ),
              description: item.parentItem
                ? String(item.parentItem.getField("title") || "")
                : "",
              select: () => finish(item),
            };
          }
          const count = getSelectableAttachments(item, mode).length;
          return {
            title:
              String(item.getField("title") || "Untitled") +
              (count > 1
                ? ` [${count} ${mode === "pdf" ? "PDFs" : "attachments"}]`
                : ""),
            description: getItemDescription(item),
            select: () => choose(item),
          };
        });

      const attachmentRows = (
        item: Zotero.Item,
        text: string,
      ): AttachmentSelectionRow[] =>
        getSelectableAttachments(item, mode).flatMap((attachment) => {
          const title = String(
            attachment.getField("title") ||
              attachment.attachmentFilename ||
              "Attachment",
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
            : await this.search(text, libraryID, mode);
          if (closed || revision !== current) return;
          const rows = selectedParent
            ? attachmentRows(selectedParent, text)
            : itemRows(items!);
          view.render(
            rows,
            getString(
              !selectedParent && !text.trim()
                ? mode === "pdf"
                  ? "splitview-no-open-pdf"
                  : "splitview-no-open-attachment"
                : mode === "pdf"
                  ? "splitview-not-found"
                  : "splitview-attachment-not-found",
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
