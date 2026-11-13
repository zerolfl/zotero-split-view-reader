const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function load(filename, globals, imports = {}) {
  const module = { exports: {} };
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  vm.runInNewContext(
    outputText,
    {
      module,
      exports: module.exports,
      require: (id) => {
        assert.ok(id in imports, `Unexpected import: ${id}`);
        return imports[id];
      },
      ...globals,
    },
    { filename },
  );
  return module.exports;
}

module.exports = { load };
