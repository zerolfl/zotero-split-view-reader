import type { SplitTabState } from "./types";

export interface SplitViewShutdownDependencies {
  disposePDFSelector(): void;
  unregisterReaderContextMenu(): void;
  getStates(): Iterable<SplitTabState>;
  saveAll(states: Iterable<SplitTabState>): void;
  getTabIDs(): Iterable<string>;
  cleanupTabResources(tabID: string): void;
  clearStates(): void;
  unregisterSession(): void;
  unregisterTabNotifier(): void;
  unregisterScrollbarObservers(): void;
  unregisterTabTitles(): void;
  unregisterReadAloud(): void;
  unregisterTabLookup(win?: Window): void;
  unregisterCommandPalette(win?: Window): void;
  debug(message: string): void;
}

export class SplitViewShutdown {
  constructor(private readonly deps: SplitViewShutdownDependencies) {}

  unregisterWindow(win: Window): void {
    const states = [...this.deps.getStates()].filter(
      (state) => state.ownerWindow === win,
    );
    this.deps.saveAll(states);
    for (const state of states) {
      try {
        this.deps.cleanupTabResources(state.tabID);
      } catch (error) {
        this.deps.debug(
          `Split view: unregisterWindow - cleanupTabResources(${state.tabID}) failed: ${error}`,
        );
      }
    }
    this.deps.unregisterTabLookup(win);
    this.deps.unregisterCommandPalette(win);
  }

  unregisterAll(): void {
    this.deps.disposePDFSelector();
    this.deps.unregisterReaderContextMenu();
    this.deps.saveAll(this.deps.getStates());

    for (const tabID of this.deps.getTabIDs()) {
      try {
        this.deps.cleanupTabResources(tabID);
      } catch (error) {
        this.deps.debug(
          `Split view: unregisterAll - cleanupTabResources(${tabID}) failed: ${error}`,
        );
      }
    }
    this.deps.clearStates();

    this.deps.unregisterSession();
    this.deps.unregisterTabNotifier();
    this.deps.unregisterScrollbarObservers();
    this.deps.unregisterTabTitles();
    this.deps.unregisterReadAloud();
    this.deps.unregisterTabLookup();
    this.deps.unregisterCommandPalette();
  }
}
