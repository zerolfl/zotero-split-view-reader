export interface SplitReaderAdapterOptions {
  tabID: string;
  item: any;
  iframeWindow: any;
  getInternalReader: () => any;
  addToNote: (annotations: any[]) => void;
  instanceID: string;
}

/**
 * Expose the subset of ReaderInstance used by reader extensions.
 * Embedded readers are otherwise invisible to Zotero.Reader event listeners.
 */
export function createSplitReaderAdapter(options: SplitReaderAdapterOptions) {
  return {
    tabID: options.tabID,
    itemID: options.item.id,
    _item: options.item,
    _iframeWindow: options.iframeWindow,
    _instanceID: options.instanceID,
    get _internalReader() {
      return options.getInternalReader();
    },
    _addToNote(annotations: any[]) {
      options.addToNote(annotations);
    },
  };
}

export function forwardReaderCustomEvent(
  event: any,
  reader: any,
  cloneArgs: (args: any[]) => any[],
  dispatch: (data: any) => void,
) {
  const data = event?.detail?.wrappedJSObject;
  if (!data) return;

  const append = data.append;
  if (typeof append === "function") {
    data.append = (...args: any[]) => append(...cloneArgs(args));
  }
  data.reader = reader;
  dispatch(data);
}
