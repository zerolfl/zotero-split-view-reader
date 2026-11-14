interface CloseButtonOptions {
  side: "left" | "right";
  label: string;
  isActive: () => boolean;
  onClose: () => void;
}

export type ReaderZoomDirection = "in" | "out" | "reset";

export function findReaderZoomButton(
  browser: XULBrowserElement,
  direction: ReaderZoomDirection,
): Element | null {
  try {
    const contentWindow = browser.contentWindow;
    if (!contentWindow) return null;
    const wrappedWindow =
      (contentWindow as any).wrappedJSObject || contentWindow;
    const document = wrappedWindow.document as Document | undefined;
    if (!document) return null;

    const selectors =
      direction === "in"
        ? [
            '[data-l10n-id="pdfjs-zoom-in-button"]',
            "#zoomIn",
            ".zoomIn",
            'button[class*="zoomIn"]',
            'button[class*="zoom-in"]',
            '[title*="Zoom In"]',
            '[title*="zoom in"]',
            '[aria-label*="Zoom In"]',
            '[aria-label*="zoom in"]',
            'button[data-tabstop="1"][class*="zoom"]',
          ]
        : direction === "out"
          ? [
              '[data-l10n-id="pdfjs-zoom-out-button"]',
              "#zoomOut",
              ".zoomOut",
              'button[class*="zoomOut"]',
              'button[class*="zoom-out"]',
              '[title*="Zoom Out"]',
              '[title*="zoom out"]',
              '[aria-label*="Zoom Out"]',
              '[aria-label*="zoom out"]',
            ]
          : [
              "#zoomAuto",
              ".zoomAuto",
              'button[class*="zoomAuto"]',
              'button[class*="zoom-auto"]',
              '[title*="Zoom Reset"]',
              '[title*="zoom reset"]',
              '[title*="Reset Zoom"]',
              '[title*="reset zoom"]',
              '[aria-label*="Zoom Reset"]',
              '[aria-label*="Reset Zoom"]',
            ];
    for (const selector of selectors) {
      try {
        const button = document.querySelector(selector);
        if (button) return button;
      } catch {
        // Skip selectors unsupported by the embedded document.
      }
    }

    for (const button of document.querySelectorAll('button, [role="button"]')) {
      const className = (button.className || "").toLowerCase();
      const title = (button.getAttribute("title") || "").toLowerCase();
      const label = (button.getAttribute("aria-label") || "").toLowerCase();
      const values = `${className} ${title} ${label}`;
      const matches =
        direction === "in"
          ? ["zoomin", "zoom-in", "zoom in", "放大"]
          : direction === "out"
            ? ["zoomout", "zoom-out", "zoom out", "缩小"]
            : [
                "zoomauto",
                "zoom-auto",
                "zoomreset",
                "zoom-reset",
                "zoom reset",
                "reset zoom",
                "重置",
              ];
      if (matches.some((value) => values.includes(value))) return button;
    }
  } catch {
    // The embedded reader toolbar may not be ready or accessible yet.
  }
  return null;
}

export function installCloseButton(
  browser: XULBrowserElement,
  options: CloseButtonOptions,
): MutationObserver | null {
  try {
    const win = browser.contentWindow;
    if (!win) return null;

    const wrappedWin = (win as any).wrappedJSObject || win;
    const document = wrappedWin.document as Document | undefined;
    if (!document) return null;

    const buttonID = `split-view-close-${options.side}`;
    const addButton = () => {
      if (!options.isActive() || document.getElementById(buttonID)) return;

      const findButton = document.querySelector(
        ".toolbar .end .toolbar-button.find",
      );
      if (!findButton?.parentNode) return;

      const button = document.createElement("button");
      button.id = buttonID;
      button.className = "toolbar-button split-view-close-button";
      button.setAttribute("type", "button");
      button.setAttribute("tabindex", "-1");
      button.setAttribute("title", options.label);
      button.setAttribute("aria-label", options.label);
      button.innerHTML = `
        <svg class="split-view-close-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M11.2923 12L12 11.292L8.70711 7.99999L12 4.70796L11.2922 4L8.00011 7.29299L4.70798 4L4 4.70774L7.29311 7.99999L4 11.2922L4.70796 12L8.00011 8.70699L11.2923 12Z" fill="currentColor"></path>
        </svg>
      `;
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        options.onClose();
      });
      findButton.after(button);
    };

    if (!document.getElementById("split-view-close-button-style")) {
      const style = document.createElement("style");
      style.id = "split-view-close-button-style";
      style.textContent = `
        .toolbar-button.split-view-close-button {
          flex: 0 0 28px;
          color: var(--fill-secondary);
        }

        .toolbar-button.split-view-close-button .split-view-close-icon {
          width: 16px;
          height: 16px;
          display: block;
          pointer-events: none;
        }
      `;
      document.head?.appendChild(style);
    }

    addButton();
    const observer = new win.MutationObserver(addButton);
    observer.observe(
      document.getElementById("reader-ui") || document.documentElement,
      {
        childList: true,
        subtree: true,
      },
    );
    return observer;
  } catch (error) {
    Zotero.debug(`Split view: install reader close button failed: ${error}`);
    return null;
  }
}
