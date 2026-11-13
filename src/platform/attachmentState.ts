async function getStoredViewState(item: Zotero.Item): Promise<any> {
  let state: any = null;
  try {
    const dir = Zotero.Attachments.getStorageDirectory(item);
    const stateFile = PathUtils.join(dir.path, ".zotero-reader-state");
    if (await IOUtils.exists(stateFile)) {
      state = await IOUtils.readJSON(stateFile);
    }
  } catch {
    // Ignore errors
  }

  const lastReadAloudPosition = getAttachmentLastReadAloudPosition(item);
  if (state) {
    state.lastReadAloudPosition = lastReadAloudPosition;
  } else if (lastReadAloudPosition !== null) {
    state = { lastReadAloudPosition };
  }
  return state;
}

function getAttachmentLastReadAloudPosition(item: Zotero.Item): any {
  try {
    return (item as any).getAttachmentLastReadAloudPosition?.() ?? null;
  } catch {
    return null;
  }
}

function syncLastReadAloudPositionToItem(
  item: Zotero.Item,
  viewState: any,
): void {
  if (!viewState || !("lastReadAloudPosition" in viewState)) return;

  try {
    const newPosition = viewState.lastReadAloudPosition ?? null;
    const currentPosition = getAttachmentLastReadAloudPosition(item);
    if (JSON.stringify(newPosition) !== JSON.stringify(currentPosition)) {
      (item as any).setAttachmentLastReadAloudPosition?.(newPosition);
    }
  } catch (e) {
    Zotero.debug(`Split view: Failed to save Read Aloud position: ${e}`);
  }
}

async function saveViewStateToDisk(
  itemID: number,
  viewState: any,
): Promise<void> {
  if (!viewState) return;
  try {
    const item = Zotero.Items.get(itemID);
    if (!item) return;

    // Update last page index (like Zotero does)
    if (viewState.pageIndex !== undefined) {
      item.setAttachmentLastPageIndex(viewState.pageIndex);
    }

    const dir = Zotero.Attachments.getStorageDirectory(item);
    if (!dir.exists()) {
      await Zotero.Attachments.createDirectoryForItem(item);
    }
    const stateFile = PathUtils.join(dir.path, ".zotero-reader-state");

    Zotero.debug("Split view: Writing reader state to " + stateFile);
    await IOUtils.writeJSON(stateFile, viewState);
  } catch (e) {
    Zotero.debug("Split view: Failed to save view state: " + e);
  }
}

export const attachmentState = {
  getStoredViewState,
  getAttachmentLastReadAloudPosition,
  syncLastReadAloudPositionToItem,
  saveViewStateToDisk,
};
