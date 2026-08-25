import { assert } from "chai";
import {
  createSplitReaderAdapter,
  forwardReaderCustomEvent,
} from "../src/utils/readerEventBridge";

describe("readerEventBridge", function () {
  it("forwards reader extension events with a ReaderInstance-compatible adapter", function () {
    const appended: any[] = [];
    const dispatched: any[] = [];
    const item = { id: 42 };
    const adapter = createSplitReaderAdapter({
      tabID: "tab-1",
      item,
      iframeWindow: {},
      getInternalReader: () => ({ ready: true }),
      addToNote: () => undefined,
      instanceID: "split-tab-1-left",
    });
    const data = {
      type: "renderTextSelectionPopup",
      append: (...args: any[]) => appended.push(args),
    };

    forwardReaderCustomEvent(
      { detail: { wrappedJSObject: data } },
      adapter,
      (args) => args.map((value) => `cloned:${value}`),
      (eventData) => dispatched.push(eventData),
    );
    data.append("button");

    assert.equal(dispatched[0].reader, adapter);
    assert.equal(adapter.itemID, 42);
    assert.equal(adapter._item, item);
    assert.deepEqual(appended, [["cloned:button"]]);
  });
});
