import { tabsForWindow } from "./tabs";
interface ReaderTab {
  id: string;
  type: string;
  data?: {
    itemID?: number;
    leftItemID?: number;
    rightItemID?: number;
  };
}

export function getOpenReaderAttachmentIDs(): number[] {
  const ids = new Set<number>();
  for (const reader of (Zotero.Reader as any)._readers || []) {
    if (reader?.itemID) ids.add(reader.itemID);
  }
  const tabs: ReaderTab[] = tabsForWindow().list();
  for (const tab of tabs) {
    if (!tab.type?.startsWith("reader")) continue;
    for (const id of [
      tab.data?.itemID,
      tab.data?.leftItemID,
      tab.data?.rightItemID,
    ]) {
      if (id) ids.add(id);
    }
    if (!tab.data?.itemID) {
      const reader = Zotero.Reader.getByTabID(tab.id);
      if (reader?.itemID) ids.add(reader.itemID);
    }
  }
  return [...ids];
}
