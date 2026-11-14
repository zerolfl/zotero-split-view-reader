function enabledVoicesPath(): string | null {
  try {
    return PathUtils.join(
      (Zotero as any).Profile.dir,
      "readAloudEnabledVoices.json",
    );
  } catch {
    return null;
  }
}

export function isReadAloudAvailable(): boolean {
  try {
    const sync = Zotero.Sync as any;
    const api = sync?.APIClient?.prototype;
    return (
      !!enabledVoicesPath() &&
      typeof sync?.Runner?.getAPIClient === "function" &&
      typeof sync?.Data?.Local?.getAPIKey === "function" &&
      typeof api?.getReadAloudVoices === "function" &&
      typeof api?.getReadAloudAudio === "function" &&
      typeof api?.getReadAloudCreditsRemaining === "function" &&
      typeof api?.resetReadAloudCredits === "function" &&
      typeof Zotero.getMainWindow()?.openDialog === "function"
    );
  } catch {
    return false;
  }
}

export function getReadAloudVoices(): any {
  try {
    return JSON.parse(String(Zotero.Prefs.get("reader.readAloudVoices"))) || {};
  } catch {
    return {};
  }
}

export function setReadAloudVoices(voices: any): void {
  Zotero.Prefs.set("reader.readAloudVoices", JSON.stringify(voices));
}

export function isReadAloudLoggedIn(): boolean {
  return !!(Zotero.Sync as any)?.Runner?.enabled;
}

export async function getReadAloudEnabledVoices(): Promise<any> {
  const path = enabledVoicesPath();
  if (!path) return {};
  try {
    return (await IOUtils.readJSON(path)) || {};
  } catch {
    return {};
  }
}

export async function saveReadAloudEnabledVoices(voices: any): Promise<void> {
  const path = enabledVoicesPath();
  if (path) await IOUtils.writeJSON(path, voices);
}

export function syncEnabledVoicesToNativeReaders(voices: any): void {
  for (const reader of (Zotero.Reader as any)._readers || []) {
    try {
      const internalReader = reader?._internalReader;
      if (typeof internalReader?.setReadAloudEnabledVoices !== "function")
        continue;
      const result = reader?._handleReadAloudEnabledVoicesChange?.(voices);
      Promise.resolve(result).catch((error) => Zotero.logError(error));
    } catch (error) {
      Zotero.logError(error as Error);
    }
  }
}

export function pauseNativeReaders(): void {
  try {
    for (const reader of (Zotero.Reader as any)._readers || []) {
      try {
        reader?.toggleReadAloudPaused?.(true);
      } catch (error) {
        Zotero.logError(error as Error);
      }
    }
  } catch {
    // Reader internals may be unavailable during shutdown.
  }
}

export function observeEnabledVoicesWrites(
  callback: (voices: any) => void,
): () => void {
  const original = IOUtils.writeJSON;
  let listener: typeof callback | null = callback;
  const wrapper: typeof IOUtils.writeJSON = async function (
    this: typeof IOUtils,
    path,
    data,
    ...args
  ) {
    const result = await original.call(this, path, data, ...args);
    try {
      const voicesPath = enabledVoicesPath();
      if (listener && voicesPath && String(path) === voicesPath) {
        listener(data);
      }
    } catch (error) {
      Zotero.logError(error as Error);
    }
    return result;
  };
  IOUtils.writeJSON = wrapper;
  return () => {
    listener = null;
    if (IOUtils.writeJSON === wrapper) IOUtils.writeJSON = original;
  };
}

function childPromise(
  targetWindow: Window,
  operation: () => Promise<any>,
): Promise<any> {
  const target = targetWindow as any;
  return new target.Promise((resolve: any, reject: any) => {
    Promise.resolve()
      .then(operation)
      .then((result) => Components.utils.cloneInto(result, targetWindow))
      .then(resolve)
      .catch((error) =>
        reject(new target.Error(String(error?.message || error))),
      );
  });
}

export function getReadAloudRemoteInterface(targetWindow: Window): any {
  if (!isReadAloudAvailable()) return null;
  const mainWindow = Zotero.getMainWindow() as any;
  const audioCache = Promise.resolve().then(
    () => mainWindow?.caches?.open("read-aloud") || null,
  );
  audioCache.catch(() => {});
  const client = async (sample = false) => {
    const apiKey = sample
      ? null
      : await (Zotero.Sync as any).Data.Local.getAPIKey();
    return (Zotero.Sync as any).Runner.getAPIClient({ apiKey });
  };
  return {
    getVoices: () =>
      childPromise(targetWindow, async () =>
        (await client()).getReadAloudVoices(),
      ),
    getAudio: (segment: any, voice: any) =>
      childPromise(targetWindow, async () => {
        const cacheURL =
          "https://read-aloud.zotero.invalid/audio?" +
          new URLSearchParams({
            voice: voice.id,
            text: segment.text,
            cacheVersion: voice.cacheVersion,
            timestamps: "1",
          });
        let cache: Cache | null = null;
        try {
          cache = await audioCache;
          const cached = await cache?.match(cacheURL);
          if (cached) {
            let timestamps;
            const header = cached.headers.get("X-Zotero-Timestamps");
            if (header) {
              try {
                timestamps = JSON.parse(header);
              } catch (error) {
                Zotero.logError(error as Error);
              }
            }
            return { audio: await cached.blob(), timestamps };
          }
        } catch (error) {
          Zotero.logError(error as Error);
        }
        const result = await (
          await client(segment === "sample")
        ).getReadAloudAudio(segment, voice.id);
        if (result.audio && cache && !result.noStore) {
          try {
            const headers: Record<string, string> = {};
            if (result.timestamps) {
              headers["X-Zotero-Timestamps"] = JSON.stringify(
                result.timestamps,
              );
            }
            const NativeResponse = (
              Components.utils.getGlobalForObject(Zotero.Reader) as any
            ).Response;
            await cache.put(
              cacheURL,
              new NativeResponse(result.audio, { headers }),
            );
          } catch (error) {
            Zotero.logError(error as Error);
          }
        }
        return result;
      }),
    getCreditsRemaining: () =>
      childPromise(targetWindow, async () =>
        (await client()).getReadAloudCreditsRemaining(),
      ),
    resetCredits: () =>
      childPromise(targetWindow, async () =>
        (await client()).resetReadAloudCredits(),
      ),
  };
}

export function openReadAloudDialog(
  kind: "firstRun" | "voices",
  io: any,
): void {
  const filename =
    kind === "firstRun"
      ? "readAloudFirstRunDialog.xhtml"
      : "readAloudVoicesDialog.xhtml";
  Zotero.getMainWindow().openDialog(
    `chrome://zotero/content/${filename}`,
    "",
    "chrome,modal,centerscreen,resizable=no",
    io,
  );
}

export function purchaseReadAloudCredits(): void {
  try {
    const { ZOTERO_CONFIG } = ChromeUtils.importESModule(
      "resource://zotero/config.mjs",
    ) as any;
    if (ZOTERO_CONFIG?.READ_ALOUD_URL) {
      Zotero.launchURL(ZOTERO_CONFIG.READ_ALOUD_URL);
    }
  } catch (error) {
    Zotero.logError(error as Error);
  }
}

export function openReadAloudLogin(): void {
  (Zotero.Utilities.Internal as any).openPreferences(
    "zotero-prefpane-account",
    { action: "logIn" },
  );
}
