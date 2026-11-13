import type { SplitReaderTabShell } from "../../platform/splitReaderTab";
import type { SplitViewCreationOptions } from "./creation";

export interface RestoredSplitViewState {
  leftViewState?: any;
  rightViewState?: any;
}

export interface SplitViewConversionDependencies {
  getMainWindow(): Window;
  getItem(itemID: number): Zotero.Item | undefined;
  getContainer(win: Window, tabID: string): Element | null;
  getViewState(reader: any): Promise<any>;
  getStoredViewState(item: Zotero.Item): Promise<any>;
  closeReader(reader: any): Promise<void>;
  createShell(
    win: Window,
    tabID: string,
    container: Element,
  ): SplitReaderTabShell;
  createAndInitialize(options: SplitViewCreationOptions): Promise<void>;
}

export class SplitViewConversionService {
  constructor(private readonly deps: SplitViewConversionDependencies) {}

  async convertDifferentPDF(
    currentReader: any,
    secondaryPDF: Zotero.Item,
    restored?: RestoredSplitViewState,
  ): Promise<void> {
    const win = this.deps.getMainWindow();
    const tabID = currentReader.tabID;
    const leftItem = this.deps.getItem(currentReader.itemID);
    if (!leftItem)
      throw new Error(`Attachment ${currentReader.itemID} is unavailable`);

    const container = this.deps.getContainer(win, tabID);
    if (!container) throw new Error("Tab container not found");

    const leftViewState =
      restored?.leftViewState ?? (await this.deps.getViewState(currentReader));
    const rightViewState =
      restored?.rightViewState ??
      (await this.deps.getStoredViewState(secondaryPDF));

    await this.deps.closeReader(currentReader);
    const shell = this.deps.createShell(win, tabID, container);
    await this.deps.createAndInitialize({
      win,
      tabID,
      shell,
      leftItem,
      rightItem: secondaryPDF,
      leftViewState,
      rightViewState,
      isSamePDF: false,
    });
  }

  async convertSamePDF(
    currentReader: any,
    restored?: RestoredSplitViewState,
  ): Promise<void> {
    const win = this.deps.getMainWindow();
    const tabID = currentReader.tabID;
    const item = this.deps.getItem(currentReader.itemID);
    if (!item)
      throw new Error(`Attachment ${currentReader.itemID} is unavailable`);

    const container = this.deps.getContainer(win, tabID);
    if (!container) throw new Error("Tab container not found");

    const leftViewState =
      restored?.leftViewState ?? (await this.deps.getViewState(currentReader));
    const rightViewState = restored?.rightViewState ?? leftViewState;

    await this.deps.closeReader(currentReader);
    const shell = this.deps.createShell(win, tabID, container);
    await this.deps.createAndInitialize({
      win,
      tabID,
      shell,
      leftItem: item,
      rightItem: item,
      leftViewState,
      rightViewState,
      isSamePDF: true,
    });
  }
}
