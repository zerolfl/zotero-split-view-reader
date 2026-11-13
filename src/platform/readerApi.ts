export class ReaderApiAdapter {
  getByTabID(tabID: string): _ZoteroTypes.ReaderInstance | null {
    return Zotero.Reader.getByTabID(tabID) || null;
  }

  open(
    itemID: number,
    location?: _ZoteroTypes.Reader.Location,
    options?: _ZoteroTypes.Reader.OpenOptions,
  ): Promise<void | _ZoteroTypes.ReaderInstance> {
    return Zotero.Reader.open(itemID, location, options);
  }
}

export const readerApi = new ReaderApiAdapter();
