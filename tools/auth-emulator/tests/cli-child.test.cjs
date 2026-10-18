const test = require("node:test"),
  assert = require("node:assert/strict");
const path = require("node:path");
const { Readable } = require("node:stream");
const { validateStart, startCli, boundedLines } = require("../cli_child.cjs");
const appRoot = path.resolve(__dirname, "../../..");
const runtimeRoot = path.join(appRoot, ".runtime/auth-test");
const config = {
  version: 1,
  runId: "owned",
  runtimeRoot,
  runDirectory: path.join(runtimeRoot, "runs/owned"),
  importDirectory: null,
};
function fixture(options = {}) {
  const events = [],
    writes = new Map();
  const proc = {
    env: {
      FIREBASE_TOKEN: "synthetic-old",
      GOOGLE_APPLICATION_CREDENTIALS: "synthetic-old",
    },
    execPath: "node",
    chdir(value) {
      events.push(["cwd", value]);
    },
  };
  const configFile = path.join(
    config.runDirectory,
    "cli-config/configstore/firebase-tools.json",
  );
  const logger = { logger: {}, useFileLogger() {}, useConsoleLoggers() {} };
  const dependencies = {
    appRoot,
    toolRoot: path.resolve(__dirname, ".."),
    process: proc,
    fs: {
      realpathSync: (value) => value,
      readFileSync: () =>
        JSON.stringify({ version: options.version ?? "15.34.0" }),
      mkdirSync() {},
      writeFileSync(file, content, settings) {
        assert.equal(settings.flag, "wx");
        if (writes.has(file)) throw Error("exists");
        writes.set(file, content);
      },
    },
    load(file) {
      events.push(["load", file]);
      if (file.endsWith("configstore.js"))
        return {
          configstore: {
            path: options.configPath ?? configFile,
            get: () => options.usage ?? false,
            all: options.oldAccount
              ? { usage: false, user: "old" }
              : { usage: false },
          },
        };
      if (file.endsWith("track.js"))
        return { usageEnabled: () => options.usage ?? false };
      if (file.endsWith("logger.js")) return logger;
      if (file.endsWith("firebase.js")) {
        assert.equal(proc.env.FIREBASE_TOKEN, undefined);
        assert.equal(proc.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
        assert.equal(proc.env.CI, "1");
        assert.equal(proc.env.NO_UPDATE_NOTIFIER, "1");
        assert.equal(logger.logger.silent, true);
        return {};
      }
      if (file.endsWith("controller.js"))
        return {
          cleanShutdown: async () => {
            events.push(["graceful-stop"]);
          },
        };
      throw Error("Unexpected CLI import");
    },
  };
  return { dependencies, events, writes, proc, logger };
}
test("only fixed demo-project Auth CLI starts after isolated fresh configuration and disabled app logs", async () => {
  const f = fixture(),
    child = startCli(config, f.dependencies);
  assert.ok(f.proc.argv.includes("demo-fyp-local"));
  assert.deepEqual(f.proc.argv.slice(2, 5), [
    "emulators:start",
    "--only",
    "auth",
  ]);
  assert.equal(f.proc.argv.includes("--export-on-exit"), false); // Owner verifies export first.
  assert.equal(f.proc.env.START_LOGGING_EMULATOR, "true");
  assert.equal(f.proc.env.TMP, path.join(config.runDirectory, "tmp"));
  await Promise.all([child.stop(), child.stop()]);
  assert.equal(f.events.filter(([name]) => name === "graceful-stop").length, 1);
});
test("unreviewed CLI, foreign Configstore, telemetry or old account keys refuse before service import", () => {
  for (const options of [
    { version: "15.35.0" },
    { configPath: path.join(appRoot, "foreign.json") },
    { usage: true },
    { oldAccount: true },
  ]) {
    const f = fixture(options);
    assert.throws(() => startCli(config, f.dependencies));
    assert.equal(
      f.events.some(
        ([name, file]) => name === "load" && file.endsWith("bin/firebase.js"),
      ),
      false,
    );
  }
});
test("startup schema refuses other roots, imports, extra fields and malformed run names", () => {
  for (const changed of [
    { ...config, runId: "../bad" },
    { ...config, version: true },
    { ...config, runtimeRoot: path.join(appRoot, "source") },
    { ...config, runDirectory: path.join(runtimeRoot, "runs/another") },
    { ...config, importDirectory: path.join(appRoot, "old-probe") },
    { ...config, extra: true },
  ])
    assert.throws(() => validateStart(changed, appRoot));
  const imported = {
    ...config,
    importDirectory: path.join(runtimeRoot, "exports/snapshot-one"),
  };
  assert.equal(
    validateStart(imported, appRoot).importDirectory,
    imported.importDirectory,
  );
});
test("stdin messages are bounded while streaming, incomplete data never starts CLI", async () => {
  const collect = async (parts) => {
    const output = [];
    for await (const line of boundedLines(Readable.from(parts)))
      output.push(line);
    return output;
  };
  assert.deepEqual(
    await collect([Buffer.from("first\nsto"), Buffer.from("p\n")]),
    ["first", "stop"],
  );
  await assert.rejects(collect([Buffer.alloc(4097, 65)]), /byte limit/);
  await assert.rejects(collect([Buffer.from("incomplete")]), /Incomplete/);
});
