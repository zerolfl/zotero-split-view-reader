import type { SplitTabState } from "./types";

export class SplitLayout {
  constructor(
    private readonly getState: (tabID: string) => SplitTabState | undefined,
    private readonly persist: (state: SplitTabState) => void,
  ) {}

  updateBrowserFlex(
    leftBrowser: XULBrowserElement,
    rightBrowser: XULBrowserElement,
    ratio: number,
  ): void {
    const left = Math.round(ratio * 1000);
    const right = Math.round((1 - ratio) * 1000);
    (leftBrowser as any).style.flex = `${left} 1 0`;
    (rightBrowser as any).style.flex = `${right} 1 0`;
  }

  setupResizerDrag(
    tabID: string,
    resizer: XULElement | HTMLElement,
    leftBrowser: XULBrowserElement,
    rightBrowser: XULBrowserElement,
    mainHbox: XULElement,
    win: Window,
  ): void {
    const state = this.getState(tabID);
    if (!state) return;
    let dragging = false;
    let startRatio = 0;
    let overlay: HTMLElement | null = null;
    let framePending = false;
    let escape: EventListener | null = null;

    const add = (
      target: EventTarget,
      type: string,
      listener: EventListener,
      options?: boolean,
    ) => {
      target.addEventListener(type, listener, options);
      state.eventListeners.push({ target, type, listener, options });
    };
    const remove = (
      target: EventTarget,
      type: string,
      listener: EventListener,
    ) => {
      target.removeEventListener(type, listener);
      const index = state.eventListeners.findIndex(
        (entry) =>
          entry.target === target &&
          entry.type === type &&
          entry.listener === listener,
      );
      if (index >= 0) state.eventListeners.splice(index, 1);
    };
    const clearOverlay = () => {
      dragging = false;
      if (overlay) {
        remove(overlay, "mousemove", onMouseMove as EventListener);
        remove(overlay, "mouseup", onMouseUp as EventListener);
        overlay.remove();
        overlay = null;
      }
      state.dragOverlay = null;
      remove(win, "mouseup", onMouseUp as EventListener);
      remove(win, "blur", onMouseUp as EventListener);
      remove(win.document, "mouseleave", onMouseUp as EventListener);
      if (escape) {
        remove(win, "keydown", escape);
        escape = null;
      }
    };
    const createOverlay = () => {
      if (overlay) clearOverlay();
      overlay = win.document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:99999;cursor:ew-resize;background:transparent";
      (win.document.documentElement || win.document.body)?.appendChild(overlay);
      state.dragOverlay = overlay;
      add(overlay, "mousemove", onMouseMove as EventListener);
      add(overlay, "mouseup", onMouseUp as EventListener);
      add(win, "mouseup", onMouseUp as EventListener);
      add(win, "blur", onMouseUp as EventListener);
      add(win.document, "mouseleave", onMouseUp as EventListener);
      escape = (event) => {
        if ((event as KeyboardEvent).key !== "Escape") return;
        state.splitRatio = startRatio;
        this.updateBrowserFlex(leftBrowser, rightBrowser, startRatio);
        clearOverlay();
      };
      add(win, "keydown", escape);
    };
    const onMouseDown = (event: MouseEvent) => {
      if (dragging) return;
      dragging = true;
      startRatio = this.getState(tabID)?.splitRatio ?? 0.5;
      createOverlay();
      event.preventDefault();
      event.stopPropagation();
    };
    const onWindowMouseDown = (event: MouseEvent) => {
      if (dragging) return;
      const current = this.getState(tabID);
      if (!current) return;
      const resizerRect = resizer.getBoundingClientRect();
      if (!resizerRect.width || !resizerRect.height) return;
      const edge = leftBrowser.getBoundingClientRect().right;
      if (
        Math.abs(event.clientX - edge) <= 15 &&
        event.clientY >= resizerRect.top &&
        event.clientY <= resizerRect.bottom
      )
        onMouseDown(event);
    };
    const onMouseMove = (event: MouseEvent) => {
      const x = event.clientX;
      if (!dragging || framePending) return;
      framePending = true;
      win.requestAnimationFrame(() => {
        framePending = false;
        const current = this.getState(tabID);
        if (!dragging || !current) return;
        const rect = mainHbox.getBoundingClientRect();
        const width = rect.width - 1;
        if (width <= 400) return;
        const min = Math.ceil((200 / width) * 100);
        const percent = Math.max(
          min,
          Math.min(100 - min, Math.floor(((x - rect.left) / width) * 100)),
        );
        current.splitRatio = percent / 100;
        this.updateBrowserFlex(leftBrowser, rightBrowser, current.splitRatio);
      });
    };
    const onMouseUp = () => {
      const current = this.getState(tabID);
      if (current && !current.isCleaningUp) this.persist(current);
      clearOverlay();
    };

    add(resizer, "mousedown", onMouseDown as EventListener);
    add(win, "mousedown", onWindowMouseDown as EventListener, true);
  }
}
