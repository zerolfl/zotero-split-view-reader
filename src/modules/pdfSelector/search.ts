import { getOpenReaderAttachmentIDs } from "../../platform/readerRegistry";

export function getPDFAttachments(item: Zotero.Item): Zotero.Item[] {
  return item.getAttachments().flatMap((id) => {
    const attachment = Zotero.Items.get(id);
    return attachment &&
      attachment.isFileAttachment() &&
      attachment.attachmentContentType === "application/pdf"
      ? [attachment]
      : [];
  });
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

export async function searchPDFItems(
  text: string,
  libraryID?: number,
): Promise<Zotero.Item[]> {
  let ids: number[];
  if (text.trim()) {
    const search = new Zotero.Search();
    if (libraryID !== undefined) {
      search.addCondition("libraryID", "is", String(libraryID));
    }
    search.addCondition("itemType", "isNot", "attachment");
    search.addCondition("itemType", "isNot", "note");
    search.addCondition("quicksearch-titleCreatorYear", "contains", text);
    ids = await search.search();
  } else {
    ids = getOpenReaderAttachmentIDs().flatMap((id) => {
      const attachment = Zotero.Items.get(id);
      return attachment &&
        attachment.isFileAttachment() &&
        attachment.attachmentContentType === "application/pdf" &&
        attachment.parentID
        ? [attachment.parentID]
        : [];
    });
  }

  const result: Zotero.Item[] = [];
  for (const id of new Set(ids)) {
    const item = Zotero.Items.get(id);
    if (
      !item ||
      !item.isRegularItem() ||
      (libraryID !== undefined && item.libraryID !== libraryID) ||
      !getPDFAttachments(item).length
    ) {
      continue;
    }
    result.push(item);
    if (result.length >= 30) break;
  }
  return result;
}
