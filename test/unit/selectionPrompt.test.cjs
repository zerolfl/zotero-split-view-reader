const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers.cjs");

function promptRuntime() {
  let mutationCallback;
  let disconnected = false;
  const prompt = {
    promptNode: {
      style: { display: "none" },
      querySelectorAll: () => [],
      ownerDocument: {
        defaultView: {
          MutationObserver: class {
            constructor(callback) {
              mutationCallback = callback;
            }
            observe() {}
            disconnect() {
              disconnected = true;
            }
          },
        },
      },
    },
    inputNode: { focus() {} },
    commands: [],
    showSuggestions(text) {
      return text;
    },
    exit() {},
    createCommandsContainer() {},
    showCommands() {},
  };
  const { createSelectionPrompt } = load("src/platform/selectionPrompt.ts", {
    ztoolkit: { Prompt: { prompt } },
  });
  return {
    prompt,
    createSelectionPrompt,
    mutate: () => mutationCallback(),
    disconnected: () => disconnected,
  };
}

test("selection prompt restores exact methods and forwards external close", () => {
  const runtime = promptRuntime();
  const { prompt } = runtime;
  const originalSearch = prompt.showSuggestions;
  const originalExit = prompt.exit;
  let closed = false;
  const queries = [];
  const view = runtime.createSelectionPrompt();
  view.open("PDF", {
    input: (text) => queries.push(text),
    back() {},
    close: () => {
      closed = true;
    },
  });
  prompt.showSuggestions("query");
  assert.deepEqual(queries, ["query"]);
  prompt.promptNode.style.display = "none";
  runtime.mutate();
  assert.equal(closed, true);
  view.dispose(false);
  assert.equal(prompt.showSuggestions, originalSearch);
  assert.equal(prompt.exit, originalExit);
  assert.equal(runtime.disconnected(), true);
});

test("selection cleanup preserves a later hook and drops its own callbacks", () => {
  const { prompt, createSelectionPrompt } = promptRuntime();
  let called = false;
  const view = createSelectionPrompt();
  view.open("PDF", {
    input: () => {
      called = true;
    },
    back() {},
    close() {},
  });
  const wrapped = prompt.showSuggestions;
  const later = (text) => wrapped(text);
  prompt.showSuggestions = later;
  view.dispose(false);
  assert.equal(prompt.showSuggestions, later);
  assert.equal(prompt.showSuggestions("original"), "original");
  assert.equal(called, false);
});
