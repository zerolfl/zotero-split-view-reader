import { assert } from "chai";
import { config } from "../package.json";

describe("command palette shortcut integration", function () {
  let win: _ZoteroTypes.MainWindow;
  let root: HTMLElement;
  let input: HTMLInputElement;
  let toolkitGlobal: any;
  let sharedRoot: HTMLElement | undefined;
  let sharedKey: ((event: KeyboardEvent) => void) | undefined;

  beforeEach(function () {
    win = Zotero.getMainWindow();
    root = win.document.querySelector(".split-view-palette")!;
    assert.ok(root);
    input = root.querySelector("input")!;
    toolkitGlobal = (Zotero as any)._toolkitGlobal;
    (Zotero as any)._toolkitGlobal = undefined;
  });

  afterEach(function () {
    root.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
    if (sharedKey) win.document.removeEventListener("keydown", sharedKey, true);
    sharedKey = undefined;
    sharedRoot?.remove();
    sharedRoot = undefined;
    (Zotero as any)._toolkitGlobal = toolkitGlobal;
  });

  function shortcut(ctrlKey = false) {
    const event = new win.KeyboardEvent("keydown", {
      key: "P",
      shiftKey: !ctrlKey,
      ctrlKey,
      bubbles: true,
      cancelable: true,
    });
    win.document.documentElement.dispatchEvent(event);
    return event;
  }

  function text(id: string) {
    return Zotero[config.addonInstance].data.locale.current.formatMessagesSync([
      { id: `${config.addonRef}-${id}` },
    ])[0].value;
  }

  it("opens a visible command with Shift+P and Enter starts PDF selection", function () {
    win.Zotero_Tabs.select("zotero-pane");
    assert.isTrue(shortcut().defaultPrevented);
    assert.isFalse(root.hidden);
    const options = root.querySelectorAll('[role="option"]');
    assert.lengthOf(options, 2);
    const readerOption = options[0] as HTMLElement;
    const splitOption = options[1] as HTMLElement;
    assert.include(
      readerOption.textContent,
      text("splitview-command-open-reader"),
    );
    assert.include(
      splitOption.textContent,
      text("splitview-command-open-split-view"),
    );
    assert.isAbove(readerOption.getBoundingClientRect().height, 0);
    assert.notEqual(win.getComputedStyle(readerOption).display, "none");
    input.dispatchEvent(
      new win.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
    input.dispatchEvent(
      new win.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.isFalse(root.hidden);
    assert.equal(input.placeholder, text("splitview-select-first-pdf"));
  });

  function sharedPrompt(containers: number, ctrlKey = false) {
    const doc = win.document;
    sharedRoot = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    sharedRoot.style.display = "none";
    doc.documentElement.appendChild(sharedRoot);
    for (let index = 0; index < containers; index++) {
      const node = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      node.className = "commands-container";
      sharedRoot.appendChild(node);
    }
    const prompt = {
      promptNode: sharedRoot,
      commands: [{ id: "other", name: "Other command", callback() {} }],
      showCommands(commands: any[], clear: boolean) {
        if (clear) this.promptNode.replaceChildren();
        const list = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
        list.className = "commands-container";
        for (const command of commands) {
          const row = doc.createElementNS(
            "http://www.w3.org/1999/xhtml",
            "div",
          );
          row.className = "command";
          row.textContent = command.name;
          row.addEventListener("click", () => command.callback());
          list.appendChild(row);
        }
        this.promptNode.appendChild(list);
      },
    };
    sharedKey = (event) => {
      if (event.key !== "P" || event.ctrlKey !== ctrlKey) return;
      prompt.promptNode.style.display = "flex";
      if (
        prompt.promptNode.querySelectorAll(".commands-container").length === 1
      )
        prompt.showCommands(prompt.commands, true);
    };
    doc.addEventListener("keydown", sharedKey, true);
    (Zotero as any)._toolkitGlobal = { prompt: { instance: prompt } };
    return prompt;
  }

  for (const containers of [0, 1]) {
    it(`renders a late shared palette with ${containers} existing lists`, function () {
      win.Zotero_Tabs.select("zotero-pane");
      const prompt = sharedPrompt(containers);
      assert.isFalse(shortcut().defaultPrevented);
      assert.isTrue(root.hidden);
      assert.equal(prompt.promptNode.style.display, "flex");
      const rows = prompt.promptNode.querySelectorAll(".command");
      assert.lengthOf(rows, 3);
      assert.equal(rows[0].textContent, "Other command");
      assert.include(
        rows[1].textContent,
        text("splitview-command-open-reader"),
      );
      assert.include(
        rows[2].textContent,
        text("splitview-command-open-split-view"),
      );
      (rows[2] as HTMLElement).click();
      assert.equal(prompt.promptNode.style.display, "none");
      assert.isFalse(root.hidden);
      assert.equal(input.placeholder, text("splitview-select-first-pdf"));
    });
  }

  it("registers a late Ctrl+P shared palette before its shortcut runs", function () {
    const prompt = sharedPrompt(0, true);
    assert.isFalse(shortcut(true).defaultPrevented);
    assert.isTrue(root.hidden);
    assert.lengthOf(prompt.promptNode.querySelectorAll(".command"), 3);
  });

  it("preserves an active nested shared workflow", function () {
    const prompt = sharedPrompt(2);
    const lists = [...prompt.promptNode.children];
    shortcut();
    assert.deepEqual([...prompt.promptNode.children], lists);
    assert.lengthOf(prompt.commands, 3);
  });
});
