export function tabsForWindow(win: Window = Zotero.getMainWindow()): Tabs {
  return new Tabs((win as any).Zotero_Tabs);
}

export function setTabAudioStatus(
  tabID: string,
  status: any,
  win: Window = Zotero.getMainWindow(),
): void {
  try {
    tabsForWindow(win).setAudioStatus(tabID, status);
  } catch (error) {
    Zotero.debug(`Split view: setSplitTabAudioStatus failed: ${error}`);
  }
}

export function observeReaderLoads(
  callback: (id: string, data: any) => void,
): () => void {
  const id = Zotero.Notifier.registerObserver(
    {
      notify: (
        action: string,
        type: string,
        ids: (string | number)[],
        extraData: any,
      ) => {
        if (type !== "tab" || action !== "load") return;
        for (const id of ids)
          callback(String(id), (extraData as any)?.[id]?.data);
      },
    },
    ["tab"],
    "splitViewSessionRestore",
    25,
  );
  return () => Zotero.Notifier.unregisterObserver(id);
}

class Tabs {
  constructor(private readonly tabs: any) {
    if (!tabs) throw new Error("Zotero tabs are unavailable");
  }

  get selectedID(): string {
    return this.tabs.selectedID;
  }

  list(): any[] {
    return [...(this.tabs._tabs || [])];
  }

  lookup(id: string): { tab: any; tabIndex: number } {
    return this.tabs._getTab(id);
  }

  select(id: string): void {
    this.tabs.select(id);
  }

  rename(id: string, title: string): Promise<void> {
    return this.tabs.rename(id, title);
  }

  move(id: string, index: number): void {
    this.tabs.move(id, index);
  }

  close(id: string): void {
    this.tabs.close(id);
  }

  setTabData(id: string, data: Record<string, any>): void {
    this.tabs.setTabData(id, data);
  }

  clearDataFields(id: string, fields: string[]): void {
    const data = this.lookup(id)?.tab?.data;
    if (data) for (const field of fields) delete data[field];
  }

  setAudioStatus(id: string, status: any): void {
    this.tabs.setAudioStatus?.(id, status);
  }
}
