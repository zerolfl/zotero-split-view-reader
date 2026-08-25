export interface PageGeometry {
  top: number;
  height: number;
}

/** Map a viewport position to the same relative point on another PDF page. */
export function calculatePageAnchoredScrollTop(
  sourceScrollTop: number,
  sourcePage: PageGeometry,
  targetPage: PageGeometry,
): number {
  if (sourcePage.height <= 0 || targetPage.height <= 0) {
    return Math.max(0, targetPage.top);
  }
  const progress = Math.max(
    0,
    Math.min(1, (sourceScrollTop - sourcePage.top) / sourcePage.height),
  );
  return Math.max(0, targetPage.top + progress * targetPage.height);
}

/** Keep both panes in the same display mode without replacing their page. */
export function copyDisplaySettings(source: any, target: any): any {
  const result = target ? { ...target } : {};
  if (!source) return result;

  if (source.scale !== undefined) result.scale = source.scale;
  if (Number.isInteger(source.scrollMode)) {
    result.scrollMode = source.scrollMode;
  }
  if (Number.isInteger(source.spreadMode)) {
    result.spreadMode = source.spreadMode;
  }
  return result;
}
