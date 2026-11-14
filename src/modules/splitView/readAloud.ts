import * as platform from "../../platform/readAloud";
import { readerReadAloud } from "../../platform/readerReadAloud";
import type { SplitTabState } from "./types";

interface ReadAloudReaders {
  states: () => Iterable<SplitTabState>;
  getReader: (browser: XULBrowserElement) => any;
  isActive: (browser: XULBrowserElement) => boolean;
}

export class SplitReadAloudService {
  private preferenceObserver: symbol | null = null;
  private removeWriteObserver: (() => void) | null = null;
  private firstRunLanguages = new Set<string>();
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly readers: ReadAloudReaders) {}

  register(): void {
    if (this.preferenceObserver || !platform.isReadAloudAvailable()) return;
    this.preferenceObserver = Zotero.Prefs.registerObserver(
      "reader.readAloudVoices",
      () => this.syncVoices(),
    );
    this.removeWriteObserver = platform.observeEnabledVoicesWrites((voices) => {
      platform.syncEnabledVoicesToNativeReaders(voices);
      this.syncEnabledVoices(voices);
    });
  }

  unregister(): void {
    if (this.preferenceObserver) {
      try {
        Zotero.Prefs.unregisterObserver(this.preferenceObserver);
      } catch (error) {
        Zotero.logError(error as Error);
      }
      this.preferenceObserver = null;
    }
    this.removeWriteObserver?.();
    this.removeWriteObserver = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.firstRunLanguages.clear();
  }

  async getReaderConfig(
    browser: XULBrowserElement,
    ftl: string[],
    onStatus: (status: any) => void,
  ): Promise<Record<string, any>> {
    if (!platform.isReadAloudAvailable()) return {};
    const targetWindow = browser.contentWindow;
    if (!targetWindow) return {};
    return {
      enableReadAloud: true,
      readAloudVoices: platform.getReadAloudVoices(),
      readAloudEnabledVoices: await platform.getReadAloudEnabledVoices(),
      readAloudRemoteInterface:
        platform.getReadAloudRemoteInterface(targetWindow),
      loggedIn: platform.isReadAloudLoggedIn(),
      onSetReadAloudVoice: (data: any) => this.setVoice(data),
      onSetReadAloudEnabledVoices: (data: any) => this.setEnabledVoices(data),
      onSetReadAloudStatus: onStatus,
      onPurchaseReadAloudCredits: platform.purchaseReadAloudCredits,
      onLogIn: () => this.schedule(platform.openReadAloudLogin),
      onOpenReadAloudFirstRunPopup: ({ lang }: any) =>
        this.openFirstRunDialog(browser, lang, ftl),
      onOpenReadAloudVoicesPopup: ({ lang, tier }: any) =>
        this.schedule(() => this.openVoicesDialog(browser, lang, tier, ftl)),
    };
  }

  private schedule(action: () => void | Promise<void>): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      Promise.resolve()
        .then(action)
        .catch((error) => Zotero.logError(error));
    });
    this.timers.add(timer);
  }

  private forEachReader(callback: (reader: any, win: Window) => void): void {
    for (const state of this.readers.states()) {
      if (state.isCleaningUp) continue;
      for (const browser of [state.leftBrowser, state.rightBrowser]) {
        try {
          const reader = this.readers.getReader(browser);
          const win = browser.contentWindow;
          if (reader && win) callback(reader, win);
        } catch {
          // The browser may be unloading.
        }
      }
    }
  }

  private syncVoices(): void {
    const voices = platform.getReadAloudVoices();
    this.forEachReader((reader, win) =>
      readerReadAloud.setVoices(reader, win, voices),
    );
  }

  private syncEnabledVoices(voices: any): void {
    this.forEachReader((reader, win) =>
      readerReadAloud.setEnabledVoices(reader, win, voices),
    );
  }

  private setVoice({ lang, region, voice, speed, tier }: any): void {
    const existing = platform.getReadAloudVoices();
    const tierVoices = { ...(existing[lang]?.tierVoices || {}) };
    if (tier) {
      delete tierVoices[tier];
      tierVoices[tier] = voice;
    }
    platform.setReadAloudVoices({
      ...existing,
      [lang]: { region, voice, speed, tierVoices },
    });
    this.syncVoices();
    this.firstRunLanguages.delete(lang);
  }

  private async setEnabledVoices(voices: Record<string, any>): Promise<void> {
    const existing = await platform.getReadAloudEnabledVoices();
    for (const [lang, enabledByTier] of Object.entries(voices)) {
      existing[lang] = { ...(existing[lang] || {}), ...enabledByTier };
    }
    await platform.saveReadAloudEnabledVoices(existing);
  }

  private hasVoice(lang: string): boolean {
    return !!platform.getReadAloudVoices()[lang]?.voice;
  }

  private openFirstRunDialog(
    browser: XULBrowserElement,
    lang: string,
    ftl: string[],
  ): void {
    if (
      !this.readers.isActive(browser) ||
      this.hasVoice(lang) ||
      this.firstRunLanguages.has(lang)
    ) {
      return;
    }
    this.firstRunLanguages.add(lang);
    this.schedule(async () => {
      try {
        if (!this.readers.isActive(browser) || this.hasVoice(lang)) return;
        const io: any = {
          dataIn: {
            lang,
            readAloudEnabledVoices: await platform.getReadAloudEnabledVoices(),
            ftl,
            getReadAloudRemoteInterface: platform.getReadAloudRemoteInterface,
          },
          dataOut: null,
          openVoicesDialog: ({ tier }: any) => {
            this.schedule(async () => {
              await this.openVoicesDialog(browser, lang, tier, ftl);
              if (!this.readers.isActive(browser)) return;
              io.updateEnabledVoices?.(
                await platform.getReadAloudEnabledVoices(),
              );
            });
          },
        };
        if (!this.readers.isActive(browser)) return;
        platform.openReadAloudDialog("firstRun", io);
        if (io.dataOut && this.readers.isActive(browser)) {
          this.setVoice(io.dataOut);
          readerReadAloud.openPopup(this.readers.getReader(browser));
        }
      } finally {
        this.firstRunLanguages.delete(lang);
      }
    });
  }

  private async openVoicesDialog(
    browser: XULBrowserElement,
    lang: string,
    tier: string,
    ftl: string[],
  ): Promise<void> {
    if (!this.readers.isActive(browser)) return;
    const io: any = {
      dataIn: {
        lang,
        tier,
        readAloudEnabledVoices: await platform.getReadAloudEnabledVoices(),
        ftl,
        getReadAloudRemoteInterface: platform.getReadAloudRemoteInterface,
      },
      dataOut: null,
    };
    if (!this.readers.isActive(browser)) return;
    platform.openReadAloudDialog("voices", io);
    if (io.dataOut && this.readers.isActive(browser)) {
      await this.setEnabledVoices(io.dataOut);
    }
  }
}
