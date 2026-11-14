import { Config, Test } from "zotero-plugin-scaffold";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const workspace = await realpath(".");
const testRoot = join(workspace, ".scaffold", "test");
const entries = join(workspace, ".scaffold", "restart-entry");
for (const directory of [testRoot, entries]) {
  await mkdir(directory, { recursive: true });
  if (
    (await realpath(directory)) !== directory ||
    (await lstat(directory)).isSymbolicLink()
  )
    throw new Error("Unexpected test directory");
}
await writeFile(
  join(entries, "session.test.ts"),
  'import "../../test/restart";\n',
);

const phasePref = "extensions.zotero.splitReaderRestartPhase";
const ctx = await Config.loadConfig({
  server: { devtools: false, startArgs: ["-no-remote", "-headless"] },
  test: {
    entries: [".scaffold/restart-entry"],
    headless: false,
    watch: false,
    prefs: {
      "app.update.auto": false,
      "network.security.ports.banned.override": "10080",
      [phasePref]: "prepare",
    },
    hooks: {
      "test:prebuild": async (context) => {
        const manifest = JSON.parse(
          await readFile(resolve(context.dist, "addon/manifest.json"), "utf8"),
        );
        if (manifest.applications.zotero.strict_max_version !== "10.*")
          throw new Error(
            "Test build does not declare Zotero 10 compatibility",
          );
      },
    },
  },
});
if (process.argv[2])
  process.env.ZOTERO_PLUGIN_ZOTERO_BIN_PATH = process.argv[2];
process.env.ZOTERO_PLUGIN_KILL_COMMAND = `"${process.execPath}" -e "process.exit(0)"`;

const tester = new Test(ctx);
let exited;
tester.onZoteroExit = () => exited();
try {
  const prepared = new Promise((resolve) => {
    exited = resolve;
  });
  await tester.run();
  const firstPID = tester.zotero.zotero.pid;
  await prepared;
  if (
    tester.zotero.zotero.exitCode !== 0 ||
    tester.reporter.failed ||
    tester.reporter.passed !== 1
  )
    throw new Error("Restart preparation did not complete");

  ctx.test.prefs[phasePref] = "restore";
  const restored = new Promise((resolve) => {
    exited = resolve;
  });
  process.stdout.write(
    "Restarting Zotero with the same profile and data directory.\n",
  );
  await tester.startZotero();
  if (tester.zotero.zotero.pid === firstPID)
    throw new Error("The client process did not change");
  await restored;
  if (
    tester.zotero.zotero.exitCode !== 0 ||
    tester.reporter.failed ||
    tester.reporter.passed !== 2
  )
    throw new Error("Restart verification did not complete");
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
} finally {
  tester.reporter.stop();
  await tester.testBundler?.esbuildContext?.dispose();
}
