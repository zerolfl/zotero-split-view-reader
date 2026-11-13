type SelectionStep = "first" | "second";

interface LibraryReaderTab {
  id: string;
  data?: { itemID?: number; rightItemID?: number };
}

interface LibraryTabs {
  list: () => LibraryReaderTab[];
  select: (tabID: string) => void;
}

interface LibraryFlowCallbacks {
  selectPDF: (
    step: SelectionStep,
    libraryID?: number,
  ) => Promise<Zotero.Item | null>;
  getTabs: () => LibraryTabs | null;
  getReader: (tabID: string) => _ZoteroTypes.ReaderInstance | null;
  openReader: (
    itemID: number,
  ) => Promise<_ZoteroTypes.ReaderInstance | false | void>;
  wait: (milliseconds: number) => Promise<void>;
  waitForReaderReady: (reader: _ZoteroTypes.ReaderInstance) => Promise<void>;
  hasSplitState: (tabID: string) => boolean;
  splitSamePDF: (reader: _ZoteroTypes.ReaderInstance) => Promise<void>;
  splitDifferentPDF: (
    reader: _ZoteroTypes.ReaderInstance,
    item: Zotero.Item,
  ) => Promise<void>;
}

export class SplitLibraryFlow {
  constructor(private readonly callbacks: LibraryFlowCallbacks) {}

  async open(): Promise<void> {
    const firstPDF = await this.callbacks.selectPDF("first");
    if (!firstPDF) return;

    const tabs = this.callbacks.getTabs();
    const existingTab = tabs
      ?.list()
      .find(
        (tab) =>
          tab.data?.itemID === firstPDF.id ||
          tab.data?.rightItemID === firstPDF.id,
      );
    const isAlreadySplit = !!existingTab?.data?.rightItemID;

    if (existingTab && isAlreadySplit) {
      tabs?.select(existingTab.id);
      return;
    }

    let reader: _ZoteroTypes.ReaderInstance | null = null;
    if (existingTab && tabs) {
      tabs.select(existingTab.id);
      await this.callbacks.wait(300);
      reader = this.callbacks.getReader(existingTab.id);
      if (!reader) {
        await this.callbacks.wait(1000);
        reader = this.callbacks.getReader(existingTab.id);
      }
    }

    if (!reader)
      reader = (await this.callbacks.openReader(firstPDF.id)) || null;
    if (!reader || this.callbacks.hasSplitState(reader.tabID)) return;

    await this.callbacks.waitForReaderReady(reader);
    const secondPDF = await this.callbacks.selectPDF(
      "second",
      firstPDF.libraryID,
    );
    if (!secondPDF) return;

    if (secondPDF.id === reader.itemID)
      await this.callbacks.splitSamePDF(reader);
    else await this.callbacks.splitDifferentPDF(reader, secondPDF);
  }
}
