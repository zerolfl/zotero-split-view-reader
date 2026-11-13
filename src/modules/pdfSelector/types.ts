export interface PDFSelectionRow {
  title: string;
  description: string;
  select: () => void;
}

export interface PDFSelectionHandlers {
  input: (text: string) => void;
  back: () => void;
  close: () => void;
}

export interface PDFSelectionView {
  open: (placeholder: string, handlers: PDFSelectionHandlers) => void;
  resetInput: (placeholder: string) => void;
  render: (rows: PDFSelectionRow[], emptyMessage: string) => void;
  dispose: (showCommands: boolean) => void;
}
