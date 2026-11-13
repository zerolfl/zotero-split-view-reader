import type { SeparateViewTarget, SplitSide, SplitTabState } from "./types";

export interface SeparateViewTargetsPort {
  findReusableReaderTabID(
    itemID: number,
    excludedTabIDs?: Set<string>,
  ): string | null;
  waitForTabClosed(tabID: string): Promise<void>;
  waitForSplitViewToSettle(): Promise<void>;
  restore(tabID: string, viewState: any): Promise<void>;
  prepare(
    target: SeparateViewTarget,
    tabIndex: number,
    activate?: boolean,
    deferRestore?: boolean,
  ): Promise<void>;
}
export interface SplitViewLifecycleDependencies {
  getState(tabID: string): SplitTabState | null;
  getTabs(): any;
  targets: SeparateViewTargetsPort;
  captureViewState(browser: XULBrowserElement): any;
  saveViewState(itemID: number, viewState: any): Promise<void>;
  cleanup(tabID: string): void;
  prepareSingleReaderClose(tabID: string, itemID: number): void;
  showClosed(): void;
  debug(message: string): void;
}

export class SplitViewLifecycle {
  constructor(private readonly deps: SplitViewLifecycleDependencies) {}

  async separate(tabID: string, clickedSide: SplitSide): Promise<void> {
    return this.run(tabID, "separateViews", async (state) => {
      const tabs = this.deps.getTabs();
      const { tabIndex } = tabs.lookup(tabID);
      const leftState =
        this.deps.captureViewState(state.leftBrowser) || state.leftViewState;
      const rightState =
        this.deps.captureViewState(state.rightBrowser) || state.rightViewState;

      await this.saveStates(
        state,
        leftState,
        rightState,
        clickedSide === "left" ? leftState : rightState,
      );
      await this.deps.targets.waitForSplitViewToSettle();

      const excluded = new Set<string>([tabID]);
      const targets: SeparateViewTarget[] = state.isSamePDF
        ? [
            {
              itemID: state.leftItemID,
              tabID: this.deps.targets.findReusableReaderTabID(
                state.leftItemID,
                excluded,
              ),
              viewState: clickedSide === "left" ? leftState : rightState,
              side: clickedSide,
            },
          ]
        : [
            {
              itemID: state.leftItemID,
              tabID: this.deps.targets.findReusableReaderTabID(
                state.leftItemID,
                excluded,
              ),
              viewState: leftState,
              side: "left",
            },
            {
              itemID: state.rightItemID,
              tabID: this.deps.targets.findReusableReaderTabID(
                state.rightItemID,
                excluded,
              ),
              viewState: rightState,
              side: "right",
            },
          ];
      const primary = state.isSamePDF
        ? targets[0]
        : targets.find((target) => target.side === clickedSide) || targets[0];
      const secondary = targets.filter((target) => target !== primary);
      const finalIndex = (target: SeparateViewTarget) =>
        state.isSamePDF || target.side === "left" ? tabIndex : tabIndex + 1;

      for (const target of targets) {
        await this.deps.targets.prepare(
          target,
          finalIndex(target) + 1,
          false,
          true,
        );
        this.requirePreparedTarget(target);
      }
      if (primary?.tabID) tabs.select(primary.tabID);

      this.deps.cleanup(tabID);
      tabs.close(tabID);
      await this.deps.targets.waitForTabClosed(tabID);

      if (primary) await this.finishTarget(primary, finalIndex(primary), true);
      for (const target of secondary)
        await this.finishTarget(target, finalIndex(target), false);
      this.deps.showClosed();
    });
  }

  async revertToSingleReader(
    tabID: string,
    sideToClose?: SplitSide,
  ): Promise<void> {
    return this.run(tabID, "revertToSingleReader", async (state) => {
      const tabs = this.deps.getTabs();
      const { tabIndex } = tabs.lookup(tabID);
      const keepLeft = sideToClose
        ? sideToClose === "right"
        : state.activeSide === "left";
      const keepItemID = keepLeft ? state.leftItemID : state.rightItemID;
      const closedItemID = keepLeft ? state.rightItemID : state.leftItemID;
      const leftState =
        this.deps.captureViewState(state.leftBrowser) || state.leftViewState;
      const rightState =
        this.deps.captureViewState(state.rightBrowser) || state.rightViewState;
      const keepState = keepLeft ? leftState : rightState;

      await this.saveStates(state, leftState, rightState, keepState);
      await this.deps.targets.waitForSplitViewToSettle();

      const keepTarget: SeparateViewTarget = {
        itemID: keepItemID,
        tabID: this.deps.targets.findReusableReaderTabID(
          keepItemID,
          new Set([tabID]),
        ),
        viewState: keepState,
        side: keepLeft ? "left" : "right",
      };

      await this.deps.targets.prepare(keepTarget, tabIndex + 1, false, true);
      this.requirePreparedTarget(keepTarget);
      if (keepTarget.tabID) tabs.select(keepTarget.tabID);

      this.deps.cleanup(tabID);
      this.deps.prepareSingleReaderClose(tabID, closedItemID);
      tabs.close(tabID);
      await this.deps.targets.waitForTabClosed(tabID);

      if (keepTarget.tabID) {
        await this.deps.targets.restore(keepTarget.tabID, keepTarget.viewState);
      } else {
        await this.deps.targets.prepare(keepTarget, tabIndex, true, false);
      }
      this.deps.showClosed();
    });
  }

  private async run(
    tabID: string,
    operation: string,
    action: (state: SplitTabState) => Promise<void>,
  ): Promise<void> {
    const state = this.deps.getState(tabID);
    if (!state || state.isCleaningUp) return;
    state.isCleaningUp = true;
    try {
      await action(state);
    } catch (error) {
      this.deps.debug(`Split view: ${operation} failed: ${error}`);
    } finally {
      if (this.deps.getState(tabID) === state) state.isCleaningUp = false;
    }
  }

  private async save(itemID: number, viewState: any): Promise<void> {
    if (!viewState) return;
    try {
      await this.deps.saveViewState(itemID, viewState);
    } catch (error) {
      this.deps.debug(`Split view: save reader state failed: ${error}`);
    }
  }

  private async saveMany(entries: Array<[number, any]>): Promise<void> {
    await Promise.all(
      entries.map(([itemID, viewState]) => this.save(itemID, viewState)),
    );
  }

  private async saveStates(
    state: SplitTabState,
    leftState: any,
    rightState: any,
    retainedState: any,
  ): Promise<void> {
    if (state.isSamePDF) {
      await this.save(state.leftItemID, retainedState);
    } else {
      await this.saveMany([
        [state.leftItemID, leftState],
        [state.rightItemID, rightState],
      ]);
    }
  }

  private async finishTarget(
    target: SeparateViewTarget,
    tabIndex: number,
    activate: boolean,
  ): Promise<void> {
    if (target.tabID) {
      await this.deps.targets.restore(target.tabID, target.viewState);
    } else {
      await this.deps.targets.prepare(target, tabIndex, activate, false);
    }
  }

  private requirePreparedTarget(target: SeparateViewTarget): void {
    if (!target.tabID)
      throw new Error(
        `Reader tab was not prepared for attachment ${target.itemID}`,
      );
  }
}
