import { assert } from "chai";
import { config } from "../package.json";

const clientVersion = Zotero.version;

describe(`startup (Zotero ${clientVersion})`, function () {
  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
    assert.isTrue(Zotero[config.addonInstance].data.initialized);
  });

  it("loads plugin Fluent messages", function () {
    const locale = Zotero[config.addonInstance].data.locale.current;
    const [message] = locale.formatMessagesSync([
      { id: `${config.addonRef}-splitview-command-label` },
    ]);
    assert.isString(message?.value);
    assert.isNotEmpty(message.value);
  });
});
