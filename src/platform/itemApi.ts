export class ItemApiAdapter {
  get(itemID: number): Zotero.Item | false {
    return Zotero.Items.get(itemID);
  }

  exists(itemID: number): boolean {
    return Zotero.Items.exists(itemID);
  }
}

export const itemApi = new ItemApiAdapter();
