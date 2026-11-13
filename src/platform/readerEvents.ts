type ReaderEventHandler = (...args: any[]) => void;

export function registerReaderEventListener(
  type: string,
  handler: ReaderEventHandler,
  pluginID: string,
): () => void {
  const reader = Zotero.Reader as any;
  reader.registerEventListener(type, handler, pluginID);

  let active = true;
  return () => {
    if (!active) return;
    active = false;

    if (typeof reader._unregisterEventListenerByPluginID === "function") {
      reader._unregisterEventListenerByPluginID(pluginID);
    } else {
      reader.unregisterEventListener(type, handler);
    }
  };
}
