import { bindAnnotationViews } from "../../platform/readerAnnotations";
import type { SplitTabState } from "./types";

export function bindSplitAnnotations(state: SplitTabState): void {
  state.disposeAnnotations?.();
  state.disposeAnnotations = state.isSamePDF
    ? bindAnnotationViews(state.leftBrowser, state.rightBrowser)
    : undefined;
}
