export interface AttachmentReaderFlowDependencies {
  selectAttachment(): Promise<Zotero.Item | null>;
  openReader(itemID: number): Promise<unknown>;
}

interface ReaderTabMetadata {
  id?: string;
  data?: { itemID?: number; rightItemID?: number };
}

export function findExistingReaderTabID(
  itemID: number,
  tabs: ReaderTabMetadata[],
): string | null {
  return (
    tabs.find((tab) => tab.data?.itemID === itemID && !tab.data.rightItemID)
      ?.id || null
  );
}

export function needsSeparateReaderTab(
  itemID: number,
  tabs: ReaderTabMetadata[],
): boolean {
  const openInSplitView = tabs.some(
    (tab) =>
      !!tab.data?.rightItemID &&
      (tab.data.itemID === itemID || tab.data.rightItemID === itemID),
  );
  return openInSplitView && !findExistingReaderTabID(itemID, tabs);
}

export class AttachmentReaderFlow {
  constructor(private readonly deps: AttachmentReaderFlowDependencies) {}

  async open(): Promise<void> {
    const attachment = await this.deps.selectAttachment();
    if (attachment) await this.deps.openReader(attachment.id);
  }
}
