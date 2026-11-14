import { getOpenReaderAttachmentIDs } from "../../platform/readerRegistry";

export type AttachmentSelectionMode = "pdf" | "reader";

export function getSelectableAttachments(
  item: Zotero.Item,
  mode: AttachmentSelectionMode,
): Zotero.Item[] {
  const attachments = item.isFileAttachment()
    ? [item]
    : item.getAttachments().flatMap((id) => {
        const attachment = Zotero.Items.get(id);
        return attachment ? [attachment] : [];
      });
  return attachments.filter(
    (attachment) =>
      attachment.isFileAttachment() &&
      (mode === "pdf"
        ? attachment.attachmentContentType === "application/pdf"
        : !!attachment.attachmentReaderType),
  );
}

export function getItemDescription(item: Zotero.Item): string {
  const parts: string[] = [];
  if (item.firstCreator) parts.push(item.firstCreator);
  const year = String(item.getField("date", true, true) || "").substring(0, 4);
  if (year && year !== "0000") parts.push(`(${parseInt(year)})`);
  const publication = item.getField("publicationTitle", false, true);
  if (publication) parts.push(String(publication));
  return parts.join(", ");
}

async function searchItems(
  text: string,
  libraryID?: number,
  mode: AttachmentSelectionMode = "pdf",
): Promise<Zotero.Item[]> {
  let ids: number[];
  if (text.trim()) {
    const regularSearch = new Zotero.Search();
    const attachmentSearch = new Zotero.Search();
    for (const search of [regularSearch, attachmentSearch]) {
      if (libraryID !== undefined) {
        search.addCondition("libraryID", "is", String(libraryID));
      }
    }
    regularSearch.addCondition(
      "quicksearch-titleCreatorYear",
      "contains",
      text,
    );
    regularSearch.addCondition("itemType", "isNot", "attachment");
    regularSearch.addCondition("itemType", "isNot", "note");
    attachmentSearch.addCondition("itemType", "is", "attachment");
    attachmentSearch.addCondition("title", "contains", text);
    ids = [
      ...(await regularSearch.search()),
      ...(await attachmentSearch.search()),
    ];
  } else {
    ids = getOpenReaderAttachmentIDs().flatMap((id) => {
      const attachment = Zotero.Items.get(id);
      return attachment &&
        attachment.isFileAttachment() &&
        getSelectableAttachments(attachment, mode).length
        ? [attachment.parentID || attachment.id]
        : [];
    });
  }

  const result: Zotero.Item[] = [];
  const seen = new Set<number>();
  for (const id of new Set(ids)) {
    const item = Zotero.Items.get(id);
    if (!item || (libraryID !== undefined && item.libraryID !== libraryID))
      continue;
    const root = item.isFileAttachment()
      ? item.parentID
        ? Zotero.Items.get(item.parentID) || item
        : item
      : item;
    const rootID = root.id;
    const hasAttachments = getSelectableAttachments(root, mode).length > 0;
    if (
      seen.has(rootID) ||
      (!root.isFileAttachment() && !root.isRegularItem()) ||
      !hasAttachments
    )
      continue;
    seen.add(rootID);
    result.push(root);
    if (result.length >= 30) break;
  }
  return result;
}

export function searchPDFItems(
  text: string,
  libraryID?: number,
): Promise<Zotero.Item[]> {
  return searchItems(text, libraryID, "pdf");
}

export function searchReaderItems(
  text: string,
  libraryID?: number,
): Promise<Zotero.Item[]> {
  return searchItems(text, libraryID, "reader");
}
