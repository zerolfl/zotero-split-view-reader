interface ReaderContextMenuAdapterCallbacks {
  setMenuItemIcon: (item: Element, iconURI: string) => void;
}

export class ReaderContextMenuAdapter {
  constructor(private readonly callbacks: ReaderContextMenuAdapterCallbacks) {}

  decoratePopup(
    mainWindow: Window,
    iconMap: Record<string, string>,
    primaryMenuLabels: string[],
    onPrimaryMenuShown?: (item: Element) => void,
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
        if (label && primaryMenuLabels.includes(label)) primaryItem = item;
      }

      if (primaryItem && onPrimaryMenuShown) {
        popup.addEventListener(
          "popupshown",
          () => {
            mainWindow.setTimeout(() => onPrimaryMenuShown(primaryItem!), 0);
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
}
