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

  it("loads labels from the registered preference pane locale", async function () {
    const panes = (Zotero as any).PreferencePanes.pluginPanes as {
      id: string;
      pluginID: string;
    }[];
    let pane = panes.find((item) => item.pluginID === config.addonID);
    for (let attempt = 0; !pane && attempt < 100; attempt++) {
      await Zotero.Promise.delay(50);
      pane = panes.find((item) => item.pluginID === config.addonID);
    }
    if (!pane) throw new Error("Preference pane was not registered");

    const markup = await Zotero.File.getContentsFromURLAsync(pane.src);
    assert.include(markup, `${config.addonRef}-preferences.ftl`);

    const locale = Zotero[config.addonInstance].data.locale.current;
    const preferenceLocale = new locale.constructor(
      [`${config.addonRef}-preferences.ftl`],
      true,
    );
    const ids = [
      "pref-section-basic",
      "pref-split-tabs-title-title-creator-year",
      "pref-split-tabs-title-creator-year-title",
      "pref-split-tabs-title-attachment-title",
      "pref-split-tabs-title-filename",
    ];
    const messages = preferenceLocale.formatMessagesSync(
      ids.map((id) => ({ id: `${config.addonRef}-${id}` })),
    );
    assert.isNotEmpty(messages[0]?.value);
    for (const id of [
      "pref-command-shortcut",
      "pref-command-shortcut-record",
      "pref-command-shortcut-reset",
    ]) {
      const [message] = preferenceLocale.formatMessagesSync([
        { id: `${config.addonRef}-${id}` },
      ]);
      assert.isNotEmpty(message?.value);
    }
    for (const message of messages.slice(1))
      assert.isNotEmpty(
        message?.attributes?.find(({ name }) => name === "label")?.value,
      );
  });
});
