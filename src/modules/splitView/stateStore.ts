import type { SplitTabState } from "./types";

export class SplitTabStateStore {
  private readonly states = new Map<string, SplitTabState>();

  get(tabID: string): SplitTabState | undefined {
    return this.states.get(tabID);
  }

  set(tabID: string, state: SplitTabState): void {
    this.states.set(tabID, state);
  }

  remove(tabID: string): boolean {
    return this.states.delete(tabID);
  }

  clear(): void {
    this.states.clear();
  }

  has(tabID: string): boolean {
    return this.states.has(tabID);
  }

  hasActive(tabID: string | null | undefined): boolean {
    if (!tabID) return false;
    const state = this.states.get(tabID);
    return !!state && !state.isCleaningUp;
  }

  hasAny(): boolean {
    return this.states.size > 0;
  }

  findByRightItem(itemID: number): SplitTabState | undefined {
    return [...this.states.values()].find(
      (state) => state.rightItemID === itemID && !state.isCleaningUp,
    );
  }

  entries() {
    return this.states.entries();
  }

  values() {
    return this.states.values();
  }

  keys() {
    return this.states.keys();
  }
}
