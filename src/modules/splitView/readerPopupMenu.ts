import type { SplitSide, SplitTabState } from "./types";
import type { PrimaryViewMenuConfig } from "./primaryView";

export interface ReaderPopupMenuDependencies {
  isBrowserAlive(browser: XULBrowserElement): boolean;
  getMainWindow(): Window;
  getStates(): Iterable<[string, SplitTabState]>;
  getState(tabID: string): SplitTabState | null;
  getString(key: string, options?: { args?: Record<string, unknown> }): string;
  getIconURI(name: string): string;
  setMenuItemIcon(item: Element, iconURI: string): void;
  getCloseViewMenuLabel(): string;
  getOpenAnotherPDFMenuLabel(): string;
  getSyncPositionMenuLabel(side: SplitSide): string;
  getSetPrimaryMenuLabel(state: PrimaryViewMenuConfig["menuState"]): string;
  getPrimaryMenuConfig(
    state: SplitTabState,
    side: SplitSide,
  ): PrimaryViewMenuConfig;
  swapPDFs(tabID: string): Promise<void>;
  separateViews(tabID: string, side: SplitSide): void;
  closeSide(tabID: string, side: SplitSide): void;
  setPrimarySide(tabID: string, side: SplitSide | null): void;
  selectAndLoadPDF(tabID: string, side: SplitSide): Promise<void>;
  syncPositionAndScale(tabID: string, side: SplitSide): void;
  activateSide(tabID: string, side: SplitSide, win: Window): void;
  refreshPrimaryMenuItem(item: Element, tabID: string, side: SplitSide): void;
  schedule(callback: () => void): void;
}

export interface ReaderPopupMenuOptions {
  x: number;
  y: number;
  itemGroups: any[][];
}

export class SplitReaderPopupMenu {
  constructor(private readonly deps: ReaderPopupMenuDependencies) {}

  open(
    browser: XULBrowserElement,
    popupset: XULElement,
    params: ReaderPopupMenuOptions,
  ): void {
    if (!this.deps.isBrowserAlive(browser)) return;
    const win = this.deps.getMainWindow();
    const popup = win.document.createXULElement("menupopup") as any;
    popupset.appendChild(popup);
    popup.addEventListener("popuphidden", () => popup.remove());
    this.appendItems(win, popup, params.itemGroups);

    const owner = [...this.deps.getStates()].find(
      ([, state]) =>
        state.leftBrowser === browser || state.rightBrowser === browser,
    );
    if (owner) this.appendSplitItems(win, popup, browser, owner[0], owner[1]);
    this.openAtPosition(win, popup, browser, params.x, params.y);
  }

  private appendItems(win: Window, parent: Element, groups: any[][]): void {
    for (let index = 0; index < groups.length; index++) {
      for (const item of groups[index]) {
        if (item.groups) {
          const menu = win.document.createXULElement("menu");
          menu.setAttribute("label", item.label);
          const submenu = win.document.createXULElement("menupopup");
          menu.appendChild(submenu);
          this.appendItems(win, submenu, item.groups);
          parent.appendChild(menu);
        } else {
          const menuitem = win.document.createXULElement("menuitem");
          menuitem.setAttribute("label", item.label);
          if (item.disabled) menuitem.setAttribute("disabled", "true");
          if (item.checked) {
            menuitem.setAttribute("type", "checkbox");
            menuitem.setAttribute("checked", "true");
          }
          menuitem.addEventListener("command", () => item.onCommand?.());
          parent.appendChild(menuitem);
        }
      }
      if (index < groups.length - 1) {
        parent.appendChild(win.document.createXULElement("menuseparator"));
      }
    }
  }

  private appendSplitItems(
    win: Window,
    popup: Element,
    browser: XULBrowserElement,
    tabID: string,
    state: SplitTabState,
  ): void {
    popup.appendChild(win.document.createXULElement("menuseparator"));
    const side: SplitSide = browser === state.leftBrowser ? "left" : "right";
    const append = (
      label: string,
      icon: string,
      onCommand: () => void | Promise<void>,
    ) => {
      const item = win.document.createXULElement("menuitem");
      item.setAttribute("label", label);
      this.deps.setMenuItemIcon(item, this.deps.getIconURI(icon));
      item.addEventListener("command", () => void onCommand());
      popup.appendChild(item);
      return item;
    };

    append(
      this.deps.getString("splitview-swap-pdf"),
      "swap_horiz_24dp.svg",
      () => this.deps.swapPDFs(tabID),
    );
    append(
      this.deps.getString("splitview-separate-views"),
      "separate_24dp.svg",
      () => this.deps.separateViews(tabID, side),
    );
    append(
      this.deps.getCloseViewMenuLabel(),
      "do_not_splitscreen_vertical_24dp.svg",
      () => this.deps.closeSide(tabID, side),
    );

    const config = this.deps.getPrimaryMenuConfig(state, side);
    const primary = append(
      this.deps.getSetPrimaryMenuLabel(config.menuState),
      config.isCurrentPrimary ? "primary_window_24dp.svg" : "standby_24dp.svg",
      () => {
        const current = this.deps.getState(tabID);
        if (!current || current.isCleaningUp) return;
        this.deps.setPrimarySide(
          tabID,
          this.deps.getPrimaryMenuConfig(current, side).targetPrimarySide,
        );
      },
    );
    if (config.disabled) primary.setAttribute("disabled", "true");

    append(this.deps.getOpenAnotherPDFMenuLabel(), "file_open_24dp.svg", () =>
      this.deps.selectAndLoadPDF(tabID, side),
    );
    append(this.deps.getSyncPositionMenuLabel(side), "sync_24dp.svg", () =>
      this.deps.syncPositionAndScale(tabID, side),
    );

    popup.addEventListener(
      "popupshown",
      () =>
        win.setTimeout(() => {
          const current = this.deps.getState(tabID);
          if (!current || current.isCleaningUp) return;
          this.deps.activateSide(tabID, side, win);
          this.deps.refreshPrimaryMenuItem(primary, tabID, side);
        }, 0),
      { once: true },
    );
  }

  private openAtPosition(
    win: Window,
    popup: any,
    browser: XULBrowserElement,
    x: number,
    y: number,
  ): void {
    const rect = browser.getBoundingClientRect();
    const screenX = rect.left + x;
    const screenY = rect.top + y;
    const utils = (win as any).windowUtils;
    if (utils?.toScreenRectInCSSUnits) {
      const point = utils.toScreenRectInCSSUnits(screenX, screenY, 0, 0);
      this.deps.schedule(() => popup.openPopupAtScreen(point.x, point.y, true));
    } else {
      this.deps.schedule(() => popup.openPopupAtScreen(screenX, screenY, true));
    }
  }
}
