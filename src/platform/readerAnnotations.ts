import { readerRuntime } from "./readerRuntime";
import { afterReaderMethod } from "./readerHooks";

function cloneForBrowser(browser: XULBrowserElement, value: any): any {
  const snapshot = JSON.parse(JSON.stringify(value));
  return Components.utils.cloneInto(snapshot, browser.contentWindow!, {
    wrapReflectors: true,
  });
}

function annotationData(annotation: any): any {
  const data = JSON.parse(JSON.stringify(annotation));
  delete data._hidden;
  delete data._score;
  return data;
}

export function bindAnnotationViews(
  leftBrowser: XULBrowserElement,
  rightBrowser: XULBrowserElement,
): () => void {
  const readers = [leftBrowser, rightBrowser].map((browser) =>
    readerRuntime.getInternalReaderFromBrowser(browser),
  );
  if (readers.some((reader) => !reader?._annotationManager)) return () => {};
  const browsers = [leftBrowser, rightBrowser];
  const disposers: (() => void)[] = [];
  let syncing = false;
  const patch = (
    browser: XULBrowserElement,
    target: any,
    key: string,
    after: () => void,
  ) => {
    disposers.push(
      afterReaderMethod(browser, target, key, () => {
        if (syncing) return;
        syncing = true;
        try {
          after();
        } catch (error) {
          Zotero.logError(error as Error);
        } finally {
          syncing = false;
        }
      }),
    );
  };
  try {
    for (const index of [0, 1]) {
      const reader = readers[index];
      const other = readers[1 - index];
      const otherBrowser = browsers[1 - index];
      patch(browsers[index], reader._annotationManager, "render", () => {
        const source: any[] = JSON.parse(
          JSON.stringify(reader._annotationManager._annotations),
        ).map(annotationData);
        const target: any[] = JSON.parse(
          JSON.stringify(other._annotationManager._annotations),
        ).map(annotationData);
        const sourceIDs = new Set(source.map((annotation) => annotation.id));
        const removed = target
          .filter((annotation) => !sourceIDs.has(annotation.id))
          .map((annotation) => annotation.id);
        const previous = new Map(
          target.map((annotation) => [
            annotation.id,
            JSON.stringify(annotation),
          ]),
        );
        const changed = source.filter(
          (annotation) =>
            previous.get(annotation.id) !== JSON.stringify(annotation),
        );
        if (removed.length)
          other.unsetAnnotations(cloneForBrowser(otherBrowser, removed));
        if (changed.length)
          other.setAnnotations(cloneForBrowser(otherBrowser, changed));
        if (removed.length || changed.length)
          other.setFilter(other._state.filter);
      });
      patch(browsers[index], reader, "_updateState", () => {
        const ids = reader._state.selectedAnnotationIDs;
        if (
          JSON.stringify(ids) !==
          JSON.stringify(other._state.selectedAnnotationIDs)
        ) {
          other._updateState(
            cloneForBrowser(otherBrowser, { selectedAnnotationIDs: ids }),
          );
        }
      });
    }
  } catch (error) {
    disposers.reverse().forEach((dispose) => dispose());
    throw error;
  }
  return () => disposers.reverse().forEach((dispose) => dispose());
}

export function reportAnnotationFailure(
  browser: XULBrowserElement,
  error: unknown,
): void {
  Zotero.logError(error as Error);
  const reader = readerRuntime.getInternalReaderFromBrowser(browser);
  reader?.setReadOnly(true);
  reader?.setErrorMessage(String(error));
}
