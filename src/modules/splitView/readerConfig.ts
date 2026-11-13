interface ReaderConfigCallbacks {
  openContextMenu: () => void;
  toggleSidebar: (open: boolean) => void;
  onViewStateChange: (viewState: any, primary: boolean) => void;
  saveAnnotations: (
    annotations: any[],
    callback: () => void,
    win: Window,
  ) => Promise<void>;
  deleteAnnotations: (ids: string[]) => void;
  toggleContextPane: () => void;
}

interface ReaderConfigOptions {
  data: { url: string };
  annotations: any[];
  readOnly: boolean;
  authorName: string;
  showContextPaneToggle: boolean;
  contextPaneOpen: boolean;
  bottomPlaceholderHeight: number | null;
  rtl: boolean;
  fontSize: any;
  ftl: string[];
  readerWindow: Window;
  preferences: Record<string, any>;
  readAloudConfig: Record<string, any>;
  viewState?: any;
  callbacks: ReaderConfigCallbacks;
}

export function buildSplitReaderConfig(options: ReaderConfigOptions) {
  const { callbacks } = options;
  return {
    type: "pdf",
    data: options.data,
    annotations: options.annotations,
    readOnly: options.readOnly,
    authorName: options.authorName,
    showContextPaneToggle: options.showContextPaneToggle,
    contextPaneOpen: options.contextPaneOpen,
    sidebarWidth: 240,
    sidebarOpen: false,
    bottomPlaceholderHeight: options.bottomPlaceholderHeight,
    rtl: options.rtl,
    fontSize: options.fontSize,
    ftl: options.ftl,
    showAnnotations: true,
    ...options.preferences,
    ...options.readAloudConfig,
    primaryViewState: options.viewState,
    onOpenContextMenu: callbacks.openContextMenu,
    onToggleSidebar: callbacks.toggleSidebar,
    onChangeSidebarWidth: (_width: number) => {},
    onChangeViewState: callbacks.onViewStateChange,
    onSaveAnnotations: (annotations: any[], callback: () => void) =>
      callbacks.saveAnnotations(annotations, callback, options.readerWindow),
    onDeleteAnnotations: callbacks.deleteAnnotations,
    onAddToNote: (_annotations: any[]) => {},
    onOpenTagsPopup: (_id: string, _x: number, _y: number) => {},
    onClosePopup: () => {},
    onOpenLink: (url: string) => Zotero.launchURL(url),
    onCopyImage: (_dataURL: string) => {},
    onSaveImageAs: (_dataURL: string) => {},
    onSetDataTransferAnnotations: (
      _dataTransfer: any,
      _annotations: any[],
      _fromText: boolean,
    ) => {},
    onToggleContextPane: callbacks.toggleContextPane,
  };
}
