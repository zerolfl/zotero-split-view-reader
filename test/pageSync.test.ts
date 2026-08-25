import { assert } from "chai";
import {
  calculatePageAnchoredScrollTop,
  copyDisplaySettings,
} from "../src/utils/pageSync";

describe("pageSync", function () {
  it("maps the same relative position across different page heights", function () {
    assert.equal(
      calculatePageAnchoredScrollTop(
        600,
        { top: 100, height: 1000 },
        { top: 200, height: 800 },
      ),
      600,
    );
  });

  it("clamps positions to the page", function () {
    assert.equal(
      calculatePageAnchoredScrollTop(
        2000,
        { top: 100, height: 1000 },
        { top: 300, height: 500 },
      ),
      800,
    );
  });

  it("copies scale and layout while preserving the target page", function () {
    assert.deepEqual(
      copyDisplaySettings(
        { pageIndex: 1, scale: "page-width", scrollMode: 0, spreadMode: 1 },
        { pageIndex: 8, top: 42, scale: 1.25 },
      ),
      {
        pageIndex: 8,
        top: 42,
        scale: "page-width",
        scrollMode: 0,
        spreadMode: 1,
      },
    );
  });
});
