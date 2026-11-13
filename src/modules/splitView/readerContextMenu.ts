import type { SplitSide, SplitTabState } from "./types";

interface PrimaryMenuConfig {
  menuState: "current" | "other" | "none";
  disabled: boolean;
  isCurrentPrimary: boolean;
  targetPrimarySide: SplitSide | null;
}

interface ReaderContextMenuCallbacks {
  isAlive: () => boolean;
  getState: (tabID: string) => SplitTabState | null;
  getReaderSide: (
    tabID: string,
    reader: _ZoteroTypes.ReaderInstance,
  ) => SplitSide | null;
  getPrimaryMenuConfig: (
    state: SplitTabState,
    side: SplitSide | null,
  ) => PrimaryMenuConfig;
  getString: (key: string) => string;
  getCloseMenuLabel: () => string;
  getSetPrimaryMenuLabel: (state: PrimaryMenuConfig["menuState"]) => string;
  getIconURI: (name: string) => string;
  setMenuItemIcon: (item: Element, iconURI: string) => void;
  swapPDFs: (tabID: string) => Promise<void>;
  separateViews: (tabID: string, side: SplitSide) => void;
  handleSplitView: (reader: _ZoteroTypes.ReaderInstance) => void;
  revertToSingleReader: (tabID: string, side: SplitSide) => void;
  setPrimarySide: (tabID: string, side: SplitSide | null) => void;
  selectAndLoadPDF: (tabID: string, side: SplitSide) => Promise<void>;
  syncPositionAndScale: (tabID: string, side: SplitSide) => void;
  activateSide: (tabID: string, side: SplitSide, win: Window) => void;
  refreshPrimaryMenuItem: (
    item: Element,
    tabID: string,
    side: SplitSide,
  ) => void;
}

type ContextMenuItem = {
  label: string;
  disabled?: boolean;
  onCommand: () => void | Promise<void>;
};

export class SplitReaderContextMenu {
  private registered = false;
  private readonly handler: _ZoteroTypes.Reader.EventHandler<"createViewContextMenu"> =
    (event) => this.onCreateViewContextMenu(event);

  constructor(private readonly callbacks: ReaderContextMenuCallbacks) {}

  register(pluginID: string): void {
    if (this.registered) return;
    Zotero.Reader.registerEventListener(
      "createViewContextMenu",
      this.handler,
      pluginID,
    );
    this.registered = true;
  }

  unregister(): void {
    if (!this.registered) return;
    try {
      Zotero.Reader.unregisterEventListener(
        "createViewContextMenu",
        this.handler,
      );
    } finally {
      this.registered = false;
    }
  }

  private decoratePopup(
    mainWindow: Window,
    tabID: string,
    iconMap: Record<string, string>,
    contextSide: SplitSide | null,
  ): void {
    const onPopupShowing = (event: Event) => {
      const popup = event.target as Element | null;
      if (!popup || popup.tagName?.toLowerCase() !== "menupopup") return;

      const items = popup.querySelectorAll("menuitem");
      let found = false;
      let primaryItem: Element | null = null;
      for (const item of items) {
        const label = item.getAttribute("label");
        if (label && iconMap[label]) {
          found = true;
          item.removeAttribute("type");
          item.removeAttribute("checked");
          this.callbacks.setMenuItemIcon(item, iconMap[label]);
        }
        if (
          label &&
          (["current", "none", "other"] as const).some(
            (state) => this.callbacks.getSetPrimaryMenuLabel(state) === label,
          )
        ) {
          primaryItem = item;
        }
      }

      if (primaryItem && contextSide) {
        popup.addEventListener(
          "popupshown",
          () => {
            mainWindow.setTimeout(() => {
              const state = this.callbacks.getState(tabID);
              if (!state || state.isCleaningUp) return;
              this.callbacks.activateSide(tabID, contextSide, mainWindow);
              this.callbacks.refreshPrimaryMenuItem(
                primaryItem as Element,
                tabID,
                contextSide,
              );
            }, 0);
          },
          { once: true },
        );
      }

      if (!found) {
        mainWindow.document.addEventListener("popupshowing", onPopupShowing, {
          once: true,
        });
      }
    };

    mainWindow.document.addEventListener("popupshowing", onPopupShowing, {
      once: true,
    });
  }

  private onCreateViewContextMenu(
    event: _ZoteroTypes.Reader.EventParams<"createViewContextMenu">,
  ): void {
    if (!this.callbacks.isAlive()) return;

    const { reader, append } = event;
    const mainWindow = Zotero.getMainWindow();
    const tabID = reader.tabID;
    const state = this.callbacks.getState(tabID);
    const isSplit = !!state && !state.isCleaningUp;
    const getClickedSide = (): SplitSide | null => {
      const currentState = this.callbacks.getState(tabID);
      if (!currentState || currentState.isCleaningUp) return null;
      return (
        this.callbacks.getReaderSide(tabID, reader) || currentState.activeSide
      );
    };
    const contextSide = isSplit ? getClickedSide() : null;
    const menuLabel = isSplit
      ? this.callbacks.getCloseMenuLabel()
      : this.callbacks.getString("splitview-menu-label");
    const iconMap: Record<string, string> = {
      [menuLabel]: this.callbacks.getIconURI(
        isSplit
          ? "do_not_splitscreen_vertical_24dp.svg"
          : "splitscreen_vertical_add_24dp.svg",
      ),
    };
    const items: ContextMenuItem[] = [];

    if (isSplit && state) {
      if (contextSide) {
        const config = this.callbacks.getPrimaryMenuConfig(state, contextSide);
        iconMap[this.callbacks.getSetPrimaryMenuLabel(config.menuState)] =
          this.callbacks.getIconURI(
            config.isCurrentPrimary
              ? "primary_window_24dp.svg"
              : "standby_24dp.svg",
          );
      } else {
        iconMap[this.callbacks.getSetPrimaryMenuLabel("none")] =
          this.callbacks.getIconURI("standby_24dp.svg");
      }

      const string = (key: string) => this.callbacks.getString(key);
      items.push({
        label: string("splitview-swap-pdf"),
        onCommand: () => this.callbacks.swapPDFs(tabID),
      });
      iconMap[string("splitview-swap-pdf")] = this.callbacks.getIconURI(
        "swap_horiz_24dp.svg",
      );
      items.push({
        label: string("splitview-separate-views"),
        onCommand: () => {
          const side = getClickedSide();
          if (side) this.callbacks.separateViews(tabID, side);
        },
      });
      iconMap[string("splitview-separate-views")] =
        this.callbacks.getIconURI("separate_24dp.svg");
      items.push({
        label: menuLabel,
        onCommand: () => {
          const currentState = this.callbacks.getState(tabID);
          if (currentState && !currentState.isCleaningUp) {
            const side =
              this.callbacks.getReaderSide(tabID, reader) ||
              currentState.activeSide;
            this.callbacks.revertToSingleReader(tabID, side);
          } else {
            this.callbacks.handleSplitView(reader);
          }
        },
      });
      const primaryConfig = this.callbacks.getPrimaryMenuConfig(
        state,
        contextSide,
      );
      items.push({
        label: this.callbacks.getSetPrimaryMenuLabel(primaryConfig.menuState),
        disabled: primaryConfig.disabled,
        onCommand: () => {
          const currentState = this.callbacks.getState(tabID);
          const side = getClickedSide();
          if (!currentState || currentState.isCleaningUp || !side) return;
          const config = this.callbacks.getPrimaryMenuConfig(
            currentState,
            side,
          );
          this.callbacks.setPrimarySide(tabID, config.targetPrimarySide);
        },
      });
      items.push({
        label: string("splitview-open-another"),
        onCommand: async () => {
          const side = getClickedSide();
          if (side) await this.callbacks.selectAndLoadPDF(tabID, side);
        },
      });
      iconMap[string("splitview-open-another")] =
        this.callbacks.getIconURI("file_open_24dp.svg");
      items.push({
        label: string("splitview-sync-position"),
        onCommand: () => {
          const side = getClickedSide();
          if (side) this.callbacks.syncPositionAndScale(tabID, side);
        },
      });
      iconMap[string("splitview-sync-position")] =
        this.callbacks.getIconURI("sync_24dp.svg");
    } else {
      items.push({
        label: menuLabel,
        onCommand: () => this.callbacks.handleSplitView(reader),
      });
    }

    (append as any)(...items);
    this.decoratePopup(mainWindow, tabID, iconMap, contextSide);
  }
}
