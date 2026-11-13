export type SplitViewNotificationKey =
  | "splitview-closed"
  | "splitview-loaded"
  | "splitview-not-found"
  | "splitview-same-pdf-loaded"
  | "splitview-swap-pdf"
  | "splitview-position-synced"
  | "splitview-last-page-reached";

export interface SplitViewNotificationDependencies {
  getString(
    key: SplitViewNotificationKey,
    options?: { args?: Record<string, unknown> },
  ): string;
  show(text: string, type: "default" | "error", duration: number): void;
}

export class SplitViewNotifications {
  constructor(private readonly deps: SplitViewNotificationDependencies) {}

  showClosed(): void {
    this.show("splitview-closed", "default", 2000);
  }

  showLoadResult(loaded: boolean): void {
    this.show(
      loaded ? "splitview-loaded" : "splitview-not-found",
      loaded ? "default" : "error",
      2000,
    );
  }

  showCreated(isSamePDF: boolean): void {
    this.show(
      isSamePDF ? "splitview-same-pdf-loaded" : "splitview-loaded",
      "default",
      3000,
    );
  }

  showSwapped(): void {
    this.show("splitview-swap-pdf", "default", 2000);
  }

  showPositionSynced(
    side: string,
    result: { pageIndexClamped?: boolean } | null,
  ): void {
    if (result?.pageIndexClamped) {
      this.show("splitview-last-page-reached", "default", 2000, { side });
    } else {
      this.show("splitview-position-synced", "default", 2000);
    }
  }

  private show(
    key: SplitViewNotificationKey,
    type: "default" | "error",
    duration: number,
    args?: Record<string, unknown>,
  ): void {
    const text = args
      ? this.deps.getString(key, { args })
      : this.deps.getString(key);
    this.deps.show(text, type, duration);
  }
}
