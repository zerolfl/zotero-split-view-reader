interface SplitCommandEntryCallbacks {
  getReader: (win: Window) => _ZoteroTypes.ReaderInstance | null;
  openReader: (reader: _ZoteroTypes.ReaderInstance) => Promise<void>;
  openLibrary: () => Promise<void>;
}

export class SplitCommandEntry {
  constructor(private readonly callbacks: SplitCommandEntryCallbacks) {}

  async execute(win: Window): Promise<void> {
    const reader = this.callbacks.getReader(win);
    if (reader) await this.callbacks.openReader(reader);
    else await this.callbacks.openLibrary();
  }
}
