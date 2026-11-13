interface CloseButtonOptions {
  side: "left" | "right";
  label: string;
  isActive: () => boolean;
  onClose: () => void;
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
