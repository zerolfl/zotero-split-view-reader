const pending = new Map<number, Promise<void>>();

function enqueue(
  itemID: number,
  operation: () => Promise<void>,
): Promise<void> {
  const job = (pending.get(itemID) || Promise.resolve())
    .catch(() => {})
    .then(operation);
  pending.set(itemID, job);
  void job
    .finally(() => {
      if (pending.get(itemID) === job) pending.delete(itemID);
    })
    .catch(() => {});
  return job;
}

async function load(item: Zotero.Item): Promise<any[]> {
  const annotations = await Promise.all(
    item.getAnnotations().map(async (annotation) => {
      try {
        const json: any = await Zotero.Annotations.toJSON(annotation);
        json.id = annotation.key;
        delete json.key;
        for (const key in json) {
          if (!Array.isArray(json[key])) json[key] = json[key] || "";
        }
        json.tags = json.tags || [];
        return json;
      } catch (error) {
        Zotero.logError(error as Error);
        return null;
      }
    }),
  );
  return annotations.filter(Boolean);
}

function isReadOnly(item: Zotero.Item): boolean {
  return !item.isEditable() || item.deleted || !!item.parentItem?.deleted;
}

function imageBlob(dataURL: string, win: Window): Blob {
  const [header, content] = dataURL.split(",");
  const mime = header.match(/^data:([^;]+);base64$/)?.[1];
  if (!mime || !content) throw new Error("Invalid annotation image");
  const binary = win.atob(content);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new win.Blob([bytes], { type: mime });
}

function save(itemID: number, annotations: any[], win: Window): Promise<void> {
  if (!annotations.length) return Promise.resolve();
  const snapshot = JSON.parse(JSON.stringify(annotations));
  return enqueue(itemID, async () => {
    const attachment = Zotero.Items.get(itemID);
    if (!attachment) throw new Error(`Attachment ${itemID} is unavailable`);
    const notifierQueue = new (Zotero.Notifier as any).Queue();
    try {
      for (const annotation of snapshot) {
        annotation.key = annotation.id;
        let item = Zotero.Items.getByLibraryAndKey(
          attachment.libraryID,
          annotation.key,
        );
        if (item && (!item.isAnnotation() || item.parentID !== itemID))
          throw new Error("Annotation belongs to another item");
        if (!(annotation.image && item && !item.isEditable())) {
          if (isReadOnly(attachment))
            throw new Error("Attachment is read-only");
          delete annotation.authorName;
          const saveOptions = {
            notifierQueue,
            notifierData: annotation.onlyTextOrComment
              ? { autoSyncDelay: Zotero.Notes.AUTO_SYNC_DELAY }
              : {},
          };
          item = await Zotero.Annotations.saveFromJSON(
            attachment,
            annotation,
            saveOptions,
          );
        }
        if (annotation.image && item) {
          await Zotero.Annotations.saveCacheImage(
            item,
            imageBlob(annotation.image, win),
          );
        }
      }
    } finally {
      await Zotero.Notifier.commit(notifierQueue);
    }
  });
}

function remove(itemID: number, ids: string[]): Promise<void> {
  if (!ids.length) return Promise.resolve();
  const keys = Array.from(ids);
  return enqueue(itemID, async () => {
    const attachment = Zotero.Items.get(itemID);
    if (!attachment) throw new Error(`Attachment ${itemID} is unavailable`);
    if (isReadOnly(attachment)) throw new Error("Attachment is read-only");
    const notifierQueue = new (Zotero.Notifier as any).Queue();
    const eraseOptions: Zotero.DataObject.EraseOptions & {
      notifierQueue: any;
    } = { notifierQueue };
    try {
      for (const key of keys) {
        const annotation = Zotero.Items.getByLibraryAndKey(
          attachment.libraryID,
          key,
        );
        if (
          annotation &&
          annotation.isAnnotation() &&
          annotation.parentID === itemID
        )
          await annotation.eraseTx(eraseOptions);
      }
    } finally {
      await Zotero.Notifier.commit(notifierQueue);
    }
  });
}

export const annotationStore = { load, isReadOnly, save, remove };
