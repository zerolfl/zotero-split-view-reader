import type { SplitSide, SplitTabState } from "./types";

export interface PrimaryScrollbarColor {
  red: number;
  green: number;
  blue: number;
}

export interface SplitScrollbarDependencies {
  getState(tabID: string): SplitTabState | null;
  getTabIDs(): Iterable<string>;
  getEffectivePrimarySide(state: SplitTabState): SplitSide | null;
  getColor(): PrimaryScrollbarColor;
  setPrimaryColor(
    browser: XULBrowserElement,
    color: PrimaryScrollbarColor | null,
  ): void;
  registerObserver(prefName: string, callback: () => void): symbol;
  unregisterObserver(id: symbol): void;
  debug(message: string): void;
}

export class SplitScrollbar {
  private observerIDs: Array<symbol | null> = [null, null, null];

  constructor(private readonly deps: SplitScrollbarDependencies) {}

  registerObservers(prefix: string): void {
    const keys = [
      "primaryScrollbarR",
      "primaryScrollbarG",
      "primaryScrollbarB",
    ];
    const onChange = () => {
      for (const tabID of this.deps.getTabIDs()) this.update(tabID);
    };

    keys.forEach((key, index) => {
      this.observerIDs[index] = this.deps.registerObserver(
        `${prefix}.${key}`,
        onChange,
      );
    });
  }

  unregisterObservers(): void {
    this.observerIDs.forEach((id, index) => {
      if (!id) return;
      try {
        this.deps.unregisterObserver(id);
      } catch (error) {
        this.deps.debug(
          `Split view: unregisterAll - unregisterObserver(scrollbarPref[${index}]) failed: ${error}`,
        );
      }
      this.observerIDs[index] = null;
    });
  }

  update(tabID: string): void {
    const state = this.deps.getState(tabID);
    if (!state || state.isCleaningUp) return;

    try {
      const primarySide = this.deps.getEffectivePrimarySide(state);
      const color = primarySide ? this.deps.getColor() : null;
      this.deps.setPrimaryColor(
        state.leftBrowser,
        primarySide === "left" ? color : null,
      );
      this.deps.setPrimaryColor(
        state.rightBrowser,
        primarySide === "right" ? color : null,
      );
    } catch (error) {
      this.deps.debug(`Split view: updateScrollbarColors error: ${error}`);
    }
  }
}
