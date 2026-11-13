export class LibraryPaneAdapter {
  selectItem(win: Window, itemID: number): boolean {
    const pane = (win as any).ZoteroPane_Local || (win as any).ZoteroPane;
    if (typeof pane?.selectItem !== "function") return false;

    void pane.selectItem(itemID);
    return true;
  }
}

export const libraryPane = new LibraryPaneAdapter();
