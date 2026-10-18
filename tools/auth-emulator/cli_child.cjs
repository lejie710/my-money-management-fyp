// A bounded stdin bootstrap. Requiring this module never imports Firebase or starts a service.
const fs = require("node:fs");
const path = require("node:path");
const TOOL_ROOT = __dirname;
const APP_ROOT = path.resolve(TOOL_ROOT, "../..");
const VERSION = "15.34.0";
const PROJECT = "demo-fyp-local";
const inside = (value, parent) => {
  const resolved = path.resolve(value),
    root = path.resolve(parent);
  if (!resolved.startsWith(root + path.sep))
    throw Error("Invalid private runtime path.");
  return resolved;
};
function validateStart(value, appRoot = APP_ROOT) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "importDirectory,runDirectory,runId,runtimeRoot,version" ||
    value.version !== 1 ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.runId)
  )
    throw Error("Invalid local Auth startup configuration.");
  const runtimeRoot = inside(value.runtimeRoot, path.join(appRoot, ".runtime"));
  const runDirectory = inside(value.runDirectory, runtimeRoot);
  if (runDirectory !== path.join(runtimeRoot, "runs", value.runId))
    throw Error("Unexpected run directory.");
  const importDirectory =
    value.importDirectory === null
      ? null
      : inside(value.importDirectory, path.join(runtimeRoot, "exports"));
  return { ...value, runtimeRoot, runDirectory, importDirectory };
}
function startCli(value, dependencies = {}) {
  const io = dependencies.fs || fs,
    proc = dependencies.process || process,
    load = dependencies.load || require;
  const toolRoot = dependencies.toolRoot || TOOL_ROOT;
  const config = validateStart(value, dependencies.appRoot || APP_ROOT);
  if (
    io.realpathSync(config.runDirectory).toLowerCase() !==
      config.runDirectory.toLowerCase() ||
    io.realpathSync(config.runtimeRoot).toLowerCase() !==
      config.runtimeRoot.toLowerCase()
  )
    throw Error("Private run paths must be real owned directories.");
  const cliRoot = path.join(toolRoot, "node_modules/firebase-tools");
  if (
    JSON.parse(io.readFileSync(path.join(cliRoot, "package.json"), "utf8"))
      .version !== VERSION
  )
    throw Error("Install the exact pinned local Auth tooling first.");
  const configRoot = path.join(config.runDirectory, "cli-config");
  const configFile = path.join(configRoot, "configstore/firebase-tools.json");
  io.mkdirSync(path.dirname(configFile), { recursive: true });
  io.writeFileSync(configFile, '{"usage":false}', { flag: "wx" });
  for (const name of [
    "FIREBASE_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "FIREBASE_CONFIG",
    "GCLOUD_PROJECT",
    "GOOGLE_CLOUD_PROJECT",
    "FIREBASE_PROJECT",
    "DEBUG",
  ])
    delete proc.env[name];
  Object.assign(proc.env, {
    XDG_CONFIG_HOME: configRoot,
    XDG_CACHE_HOME: path.join(config.runDirectory, "cache"),
    XDG_DATA_HOME: path.join(config.runDirectory, "data"),
    TMP: path.join(config.runDirectory, "tmp"),
    TEMP: path.join(config.runDirectory, "tmp"),
    CI: "1",
    NO_UPDATE_NOTIFIER: "1",
    IS_FIREBASE_CLI: "true",
    START_LOGGING_EMULATOR: "true",
  });
  io.mkdirSync(proc.env.TMP, { recursive: true });
  const { configstore } = load(path.join(cliRoot, "lib/configstore.js"));
  if (
    path.resolve(configstore.path).toLowerCase() !== configFile.toLowerCase() ||
    configstore.get("usage") !== false ||
    Object.keys(configstore.all).some((key) => key !== "usage")
  )
    throw Error("CLI account configuration is not isolated.");
  if (load(path.join(cliRoot, "lib/track.js")).usageEnabled() !== false)
    throw Error("CLI telemetry must be disabled.");
  // Auth's console/debug output may contain local reset links. Disable only this
  // child CLI's application log transports; the owner writes fixed lifecycle records.
  const logging = load(path.join(cliRoot, "lib/logger.js"));
  if (
    typeof logging.useFileLogger !== "function" ||
    typeof logging.useConsoleLoggers !== "function" ||
    !logging.logger
  )
    throw Error("Pinned CLI logging interface changed.");
  logging.logger.silent = true;
  logging.useFileLogger = () =>
    path.join(config.runDirectory, "unused-cli-log");
  logging.useConsoleLoggers = () => {};
  const cli = path.join(cliRoot, "lib/bin/firebase.js");
  const args = [
    "emulators:start",
    "--only",
    "auth",
    "--project",
    PROJECT,
    "--config",
    path.join(toolRoot, "firebase.json"),
    "--non-interactive",
  ];
  if (config.importDirectory) args.push("--import", config.importDirectory);
  proc.chdir(config.runDirectory);
  proc.argv = [proc.execPath, cli, ...args];
  load(cli);
  let stopping = null;
  return {
    stop() {
      if (!stopping)
        stopping = Promise.resolve().then(() =>
          load(
            path.join(cliRoot, "lib/emulator/controller.js"),
          ).cleanShutdown(),
        );
      return stopping;
    },
  };
}
async function* boundedLines(input) {
  let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(10)) >= 0) {
      if (end > 4096)
        throw Error("Local control message exceeds its byte limit.");
      const line = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      yield line.toString("utf8");
    }
    if (pending.length > 4096)
      throw Error("Local control message exceeds its byte limit.");
  }
  if (pending.length) throw Error("Incomplete local control message.");
}
async function main() {
  const lines = boundedLines(process.stdin),
    first = await lines.next();
  if (first.done) throw Error("Missing private startup configuration.");
  const cli = startCli(JSON.parse(first.value));
  for await (const line of lines) {
    if (line !== "stop") throw Error("Unsupported local control command.");
    await cli.stop();
    process.exit(0);
  }
  // Parent loss is abnormal. The parent-held Job provides the final process boundary.
  await cli.stop();
  process.exit(1);
}
if (require.main === module)
  main().catch(() => {
    console.error(
      "The isolated local Auth process could not complete. No account contents were printed.",
    );
    process.exitCode = 1;
  });
module.exports = { validateStart, startCli, boundedLines, VERSION, PROJECT };
