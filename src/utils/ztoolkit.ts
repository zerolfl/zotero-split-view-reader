import { ZoteroToolkit } from "zotero-plugin-toolkit";
import { config } from "../../package.json";

export { createZToolkit };

function createZToolkit() {
  const _ztoolkit = new ZoteroToolkit();
  /**
   * Alternatively, import toolkit modules you use to minify the plugin size.
   * You can add the modules under the `MyToolkit` class below and uncomment the following line.
   */
  // const _ztoolkit = new MyToolkit();
  initZToolkit(_ztoolkit);
  return _ztoolkit;
}

function initZToolkit(_ztoolkit: ReturnType<typeof createZToolkit>) {
  const env = __env__;
  _ztoolkit.basicOptions.log.prefix = `[${config.addonName}]`;
  _ztoolkit.basicOptions.log.disableConsole = env === "production";
  _ztoolkit.UI.basicOptions.ui.enableElementJSONLog = __env__ === "development";
  _ztoolkit.UI.basicOptions.ui.enableElementDOMLog = __env__ === "development";
  // Getting basicOptions.debug will load global modules like the debug bridge.
  // since we want to deprecate it, should avoid using it unless necessary.
  // _ztoolkit.basicOptions.debug.disableDebugBridgePassword =
  //   __env__ === "development";
  _ztoolkit.basicOptions.api.pluginID = config.addonID;
  const faviconURI = `chrome://${config.addonRef}/content/icons/svreader.svg`;
  _ztoolkit.ProgressWindow.setIconURI("default", faviconURI);
  _ztoolkit.ProgressWindow.setIconURI("error", faviconURI);

  // Wrap ProgressWindow so headline and favicon apply after Zotero's deferred window load.
  // Otherwise toasts (e.g. "Split view closed") can show default title and no favicon.
  // Multiple delays cover both quick and busy moments (e.g. closing split view).
  const OriginalProgressWindow = _ztoolkit.ProgressWindow;
  const HEADLINE_ICON_DELAYS_MS = [50, 150, 300, 500, 800, 1200];
  (_ztoolkit as any).ProgressWindow = function (
    header: string,
    options?: ConstructorParameters<typeof OriginalProgressWindow>[1]
  ) {
    const win = new OriginalProgressWindow(header, options);
    const origShow = win.show.bind(win);
    win.show = function (closeTime?: number) {
      origShow(closeTime);
      HEADLINE_ICON_DELAYS_MS.forEach((delay) => {
        setTimeout(() => {
          try {
            win.changeHeadline(header);
            (win as any).updateIcons();
          } catch {
            // ignore if window already closed
          }
        }, delay);
      });
      return win;
    };
    return win;
  };
  _ztoolkit.ProgressWindow.setIconURI = OriginalProgressWindow.setIconURI;
}

import { BasicTool, unregister } from "zotero-plugin-toolkit";
import { UITool } from "zotero-plugin-toolkit";

class MyToolkit extends BasicTool {
  UI: UITool;

  constructor() {
    super();
    this.UI = new UITool(this);
  }

  unregisterAll() {
    unregister(this);
  }
}
