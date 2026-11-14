interface SplitViewRegistrationCallbacks {
  registerSessionRestore(): void;
  registerTitleItemNotifier(): void;
  registerReaderContextMenu(): void;
  registerTabLookup(win: Window): void;
  clearLegacySyncPreference(): void;
  registerScrollbarPreferences(prefix: string): void;
  registerTitlePreference(name: string): void;
  registerReadAloud(): void;
  registerCommandPalette(win: Window): void;
  unregisterAll(): Promise<void>;
}

export class SplitViewRegistration {
  constructor(private readonly callbacks: SplitViewRegistrationCallbacks) {}

  registerSessionRestore(): void {
    this.callbacks.registerSessionRestore();
  }

  registerTitleItemNotifier(): void {
    this.callbacks.registerTitleItemNotifier();
  }

  registerReaderContextMenu(): void {
    this.callbacks.registerReaderContextMenu();
  }

  registerTabLookup(win: Window): void {
    this.callbacks.registerTabLookup(win);
  }

  registerPreferences(prefix: string): void {
    this.callbacks.clearLegacySyncPreference();
    this.callbacks.registerScrollbarPreferences(prefix);
    this.callbacks.registerTitlePreference(`${prefix}.splitTabsTitle`);
    this.callbacks.registerReadAloud();
  }

  registerCommandPalette(win: Window): void {
    this.callbacks.registerCommandPalette(win);
  }

  unregisterAll(): Promise<void> {
    return this.callbacks.unregisterAll();
  }
}
