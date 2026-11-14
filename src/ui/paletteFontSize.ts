export const COMMAND_PALETTE_FONT_SIZES = [14, 16, 18, 20, 22] as const;
export const DEFAULT_COMMAND_PALETTE_FONT_SIZE = 18;

export function normalizeCommandPaletteFontSize(
  value: number | null | undefined,
): number {
  return (
    COMMAND_PALETTE_FONT_SIZES.find((fontSize) => fontSize === value) ??
    DEFAULT_COMMAND_PALETTE_FONT_SIZE
  );
}
