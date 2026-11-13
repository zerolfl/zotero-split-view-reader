import type { SplitTabState } from "./types";

export class SplitTabResourceTracker {
  constructor(private readonly getMainWindow: () => Window) {}

  trackEventListener(
    state: SplitTabState,
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener, options);
    state.eventListeners.push({ target, type, listener, options });
  }

  trackTimeout(
    state: SplitTabState,
    callback: () => void,
    delay: number,
  ): number {
    const id = this.getMainWindow().setTimeout(callback, delay);
    state.timeoutIds.push(id);
    return id;
  }
}
