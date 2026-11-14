export interface AttachmentSelectionRow {
  title: string;
  description: string;
  select: () => void;
}

export interface AttachmentSelectionHandlers {
  input: (text: string) => void;
  back: () => void;
  close: () => void;
}

export interface AttachmentSelectionView {
  open: (placeholder: string, handlers: AttachmentSelectionHandlers) => void;
  resetInput: (placeholder: string) => void;
  render: (rows: AttachmentSelectionRow[], emptyMessage: string) => void;
  dispose: (showCommands: boolean) => void;
}
