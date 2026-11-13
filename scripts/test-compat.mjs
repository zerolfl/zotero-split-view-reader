import { Config, Test } from "zotero-plugin-scaffold";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
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
  server: { devtools: false, startArgs: ["-headless"] },
  test: {
    headless: false,
    watch: false,
    hooks: {
      "test:prebuild": async (context) => {
        const path = resolve(context.dist, "addon/manifest.json");
        const manifest = JSON.parse(await readFile(path, "utf8"));
        manifest.applications.zotero.strict_max_version = "10.*";
        await writeFile(path, JSON.stringify(manifest, null, 2));
      },
    },
  },
});
if (process.argv[2])
  process.env.ZOTERO_PLUGIN_ZOTERO_BIN_PATH = process.argv[2];
process.env.ZOTERO_PLUGIN_KILL_COMMAND = `"${process.execPath}" -e "process.exit(0)"`;
await new Test(ctx).run();
