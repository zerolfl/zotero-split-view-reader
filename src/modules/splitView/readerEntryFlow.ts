import type { SplitTabState } from "./types";

export interface SplitReaderEntryDependencies {
  getState(tabID: string): SplitTabState | null;
  cleanup(tabID: string): void;
  wait(milliseconds: number): Promise<void>;
  getItem(itemID: number): Zotero.Item | null;
  selectPDF(libraryID: number): Promise<Zotero.Item | null>;
  convertSamePDF(reader: any): Promise<void>;
  convertDifferentPDF(reader: any, item: Zotero.Item): Promise<void>;
}

export class SplitReaderEntryFlow {
  constructor(private readonly deps: SplitReaderEntryDependencies) {}

  async open(reader: any): Promise<void> {
    const tabID = reader.tabID;
    try {
      const staleState = this.deps.getState(tabID);
      if (staleState && !staleState.isCleaningUp) this.deps.cleanup(tabID);

      await this.deps.wait(50);
      const currentItem = this.deps.getItem(reader.itemID);
      if (!currentItem) return;

      const selectedPDF = await this.deps.selectPDF(currentItem.libraryID);
      if (!selectedPDF) return;

      if (selectedPDF.id === reader.itemID)
        await this.deps.convertSamePDF(reader);
      else await this.deps.convertDifferentPDF(reader, selectedPDF);
    } catch {
      const state = this.deps.getState(tabID);
      if (state && !state.isCleaningUp) this.deps.cleanup(tabID);
    }
  }
}
