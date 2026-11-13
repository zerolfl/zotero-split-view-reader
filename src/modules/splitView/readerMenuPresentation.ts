import type { PrimaryViewMenuConfig } from "./primaryView";
import type { SplitSide, SplitTabState } from "./types";

export interface ReaderMenuPresentationDependencies {
  getString(key: string, options?: { args?: Record<string, unknown> }): string;
  getAddonRef(): string;
  getState(tabID: string): SplitTabState | null;
  getPrimaryMenuConfig(
    state: SplitTabState,
    side: SplitSide | null,
  ): PrimaryViewMenuConfig;
}

export class ReaderMenuPresentation {
  constructor(private readonly deps: ReaderMenuPresentationDependencies) {}

  getString(key: string, options?: { args?: Record<string, unknown> }): string {
    return this.deps.getString(key, options);
  }

  getIconURI(name: string): string {
    return `chrome://${this.deps.getAddonRef()}/content/icons/${name}`;
  }

  setMenuItemIcon(item: Element, iconURI: string): void {
    item.classList.add("menuitem-iconic");
    item.setAttribute("image", iconURI);
    item.setAttribute(
      "style",
      "-moz-context-properties: fill; fill: currentColor;",
    );
  }

  getCloseViewMenuLabel(): string {
    return this.getString("splitview-close-menu-label");
  }

  getOpenAnotherPDFMenuLabel(): string {
    return this.getString("splitview-open-another");
  }

  getSyncPositionMenuLabel(currentSide: SplitSide | null): string {
    if (!currentSide) return this.getString("splitview-sync-position");
    return this.getString("splitview-sync-position", {
      args: { side: currentSide === "left" ? "right" : "left" },
    });
  }

  getSetPrimaryMenuLabel(state: PrimaryViewMenuConfig["menuState"]): string {
    return this.getString("splitview-set-primary", { args: { state } });
  }

  refreshPrimaryMenuItem(
    item: Element,
    tabID: string,
    side: SplitSide,
  ): PrimaryViewMenuConfig | null {
    const state = this.deps.getState(tabID);
    if (!state || state.isCleaningUp) return null;

    const config = this.deps.getPrimaryMenuConfig(state, side);
    item.setAttribute("label", this.getSetPrimaryMenuLabel(config.menuState));
    if (config.disabled) item.setAttribute("disabled", "true");
    else item.removeAttribute("disabled");
    this.setMenuItemIcon(
      item,
      this.getIconURI(
        config.isCurrentPrimary
          ? "primary_window_24dp.svg"
          : "standby_24dp.svg",
      ),
    );
    return config;
  }
}
