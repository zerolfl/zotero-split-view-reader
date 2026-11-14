interface ReadAloudReader {
  setReadAloudVoices?(voices: any): void;
  setReadAloudEnabledVoices?(voices: any): void;
  toggleReadAloudPopup?(open: boolean): void;
  toggleReadAloudPaused?(paused?: boolean): void;
}

type ReaderTarget = ReadAloudReader | null | undefined;

export const readerReadAloud = {
  setVoices(reader: ReaderTarget, win: Window, voices: any): void {
    reader?.setReadAloudVoices?.(Components.utils.cloneInto(voices, win));
  },

  setEnabledVoices(reader: ReaderTarget, win: Window, voices: any): void {
    reader?.setReadAloudEnabledVoices?.(
      Components.utils.cloneInto(voices, win),
    );
  },

  openPopup(reader: ReaderTarget): void {
    reader?.toggleReadAloudPopup?.(true);
  },

  togglePaused(reader: ReaderTarget, paused?: boolean): void {
    if (paused === undefined) reader?.toggleReadAloudPaused?.();
    else reader?.toggleReadAloudPaused?.(paused);
  },
};
