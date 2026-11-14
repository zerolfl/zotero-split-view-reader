import { Config, Test } from "zotero-plugin-scaffold";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const workspace = await realpath(".");
const testRoot = join(workspace, ".scaffold", "test");
await mkdir(testRoot, { recursive: true });
if (
  (await realpath(testRoot)) !== testRoot ||
  (await lstat(testRoot)).isSymbolicLink()
)
  throw new Error("Unexpected test directory");

const ctx = await Config.loadConfig({
  server: { devtools: false, startArgs: ["-no-remote", "-headless"] },
  test: {
    headless: false,
    watch: false,
    prefs: {
      "app.update.auto": false,
      "network.security.ports.banned.override": "10080",
    },
    hooks: {
      "test:prebuild": async (context) => {
        const path = resolve(context.dist, "addon/manifest.json");
        const manifest = JSON.parse(await readFile(path, "utf8"));
        if (manifest.applications.zotero.strict_max_version !== "10.*") {
          throw new Error(
            "Test build does not declare Zotero 10 compatibility",
          );
        }
      },
    },
  },
});
if (process.argv[2])
  process.env.ZOTERO_PLUGIN_ZOTERO_BIN_PATH = process.argv[2];
process.env.ZOTERO_PLUGIN_KILL_COMMAND = `"${process.execPath}" -e "process.exit(0)"`;
const tester = new Test(ctx);
const onExit = tester.onZoteroExit;
tester.onZoteroExit = () => {
  const exitCode = tester.zotero.zotero.exitCode;
  if (exitCode !== 0) {
    process.stderr.write(`Zotero exited abnormally (${exitCode})\n`);
    process.exit(1);
  }
  onExit();
};
await tester.run();
