const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

function load(filename, globals, imports = {}) {
  const module = { exports: {} };
  const { code } = transformSync(readFileSync(filename, "utf8"), {
    loader: "ts",
    format: "cjs",
    target: "es2022",
  });
  vm.runInNewContext(
    code,
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
