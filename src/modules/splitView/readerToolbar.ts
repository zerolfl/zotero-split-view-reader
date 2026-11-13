import type { SplitTabState } from "./types";

interface SplitReaderToolbarDependencies {
  getState(tabID: string): SplitTabState | null;
  isBrowserAlive(browser: XULBrowserElement): boolean;
  hasActiveSplitState(tabID: string): boolean;
  getCloseLabel(): string;
  closeSide(tabID: string, side: "left" | "right"): void;
  installButton(
    browser: XULBrowserElement,
    options: {
      side: "left" | "right";
      label: string;
      isActive(): boolean;
      onClose(): void;
    },
  ): MutationObserver | null;
}

export class SplitReaderToolbar {
  constructor(private readonly deps: SplitReaderToolbarDependencies) {}

  installCloseButton(
    tabID: string,
    browser: XULBrowserElement,
    side: "left" | "right",
  ): void {
    const state = this.deps.getState(tabID);
    if (!state || state.isCleaningUp || !this.deps.isBrowserAlive(browser))
      return;

    state.toolbarCloseObservers = state.toolbarCloseObservers.filter(
      (entry) => {
        if (entry.side !== side) return true;
        try {
          entry.observer.disconnect();
        } catch {
          // Ignore observers from an already-unloaded browser
        }
        return false;
      },
    );

    const observer = this.deps.installButton(browser, {
      side,
      label: this.deps.getCloseLabel(),
      isActive: () => this.deps.hasActiveSplitState(tabID),
      onClose: () => this.deps.closeSide(tabID, side),
    });
    if (observer) state.toolbarCloseObservers.push({ side, observer });
  }
}
