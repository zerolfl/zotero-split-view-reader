const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");
const { atob, Blob } = require("node:buffer");

function runtime() {
  const records = new Map();
  const saved = [];
  const erased = [];
  const images = [];
  let fail = false;
  let commits = 0;
  const item = { id: 1, libraryID: 1, isEditable: () => true };
  const { annotationStore } = load("src/platform/annotationStore.ts", {
    Uint8Array,
    Zotero: {
      Items: {
        get: () => item,
        getByLibraryAndKey: (_library, key) => records.get(key),
      },
      Notes: { AUTO_SYNC_DELAY: 5 },
      Notifier: {
        Queue: class {},
        commit: async () => {
          commits++;
        },
      },
      Annotations: {
        saveFromJSON: async (_item, annotation) => {
          saved.push(annotation.comment);
          if (fail) {
            fail = false;
            throw new Error("disk full");
          }
          const result = {
            key: annotation.id,
            parentID: 1,
            libraryID: 1,
            isAnnotation: () => true,
            isEditable: () => true,
            eraseTx: async () => {
              erased.push(annotation.id);
            },
          };
          records.set(annotation.id, result);
          return result;
        },
        saveCacheImage: async (_item, blob) => {
          images.push(blob);
        },
      },
    },
  });
  return {
    annotationStore,
    records,
    saved,
    erased,
    images,
    item,
    fail: () => {
      fail = true;
    },
    commits: () => commits,
  };
}

test("annotation writes snapshot inputs, serialize saves and deletions, and propagate failures", async () => {
  const rt = runtime();
  const input = { id: "NOTE0001", comment: "first", authorName: "reader" };
  const first = rt.annotationStore.save(1, [input], {});
  input.comment = "second";
  const second = rt.annotationStore.save(1, [input], {});
  const deletion = rt.annotationStore.remove(1, [input.id]);
  await Promise.all([first, second, deletion]);
  assert.deepEqual(rt.saved, ["first", "second"]);
  assert.deepEqual(rt.erased, [input.id]);
  assert.equal(input.authorName, "reader");
  rt.fail();
  const failed = rt.annotationStore.save(1, [input], {});
  const recovered = rt.annotationStore.save(1, [input], {});
  await assert.rejects(failed, /disk full/);
  await recovered;
  assert.equal(rt.commits(), 5);
});

test("annotation ownership and attachment editability prevent cross-item writes", async () => {
  const rt = runtime();
  const id = "NOTE0001";
  rt.records.set(id, { parentID: 2, isAnnotation: () => true });
  await assert.rejects(
    rt.annotationStore.save(1, [{ id }], {}),
    /another item/,
  );
  await rt.annotationStore.remove(1, [id]);
  assert.equal(rt.erased.length, 0);
  rt.item.isEditable = () => false;
  await assert.rejects(
    rt.annotationStore.save(1, [{ id: "NOTE0002" }], {}),
    /read-only/,
  );
  await rt.annotationStore.save(1, [], {});
  await rt.annotationStore.remove(1, []);
});

test("read-only annotation image updates use the cache without changing annotation data", async () => {
  const rt = runtime();
  const id = "NOTE0001";
  rt.records.set(id, {
    parentID: 1,
    isAnnotation: () => true,
    isEditable: () => false,
  });
  rt.item.isEditable = () => false;
  await rt.annotationStore.save(
    1,
    [{ id, image: "data:image/png;base64,YQ==" }],
    { atob, Blob },
  );
  assert.equal(rt.saved.length, 0);
  assert.equal(rt.images[0].type, "image/png");
  assert.equal(await rt.images[0].text(), "a");
});
