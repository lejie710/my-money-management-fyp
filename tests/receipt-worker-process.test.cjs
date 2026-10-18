const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  vm = require("node:vm");
const { EventEmitter } = require("node:events"),
  { createRequire } = require("node:module");
const { randomUUID } = require("node:crypto");
const sourcePath = path.join(__dirname, "../scripts/companion/ocr/windowsWorker.cjs");
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const output = {
  version: 1,
  provider: "windows-media-ocr",
  language: "en-US",
  width: 1100,
  height: 900,
  elapsedMs: 1,
  textAngle: null,
  words: [],
};
async function fixture() {
  const root = path.join(__dirname, "../.runtime/receipt-tests", randomUUID()),
    entered = deferred(),
    child = new EventEmitter();
  const timers = new Map();
  let callback, directory, launchOptions;
  const localRequire = createRequire(sourcePath),
    module = { exports: {} };
  vm.runInNewContext(await fs.readFile(sourcePath, "utf8"), {
    module,
    exports: module.exports,
    __dirname: path.dirname(sourcePath),
    process,
    setTimeout(callback, milliseconds) {
      const token = {};
      timers.set(token, { callback, milliseconds });
      return token;
    },
    clearTimeout(token) {
      timers.delete(token);
    },
    require(name) {
      if (name === "node:child_process")
        return {
          execFile(executable, args, options, done) {
            callback = done;
            directory = options.cwd;
            launchOptions = options;
            entered.resolve();
            return child;
          },
        };
      return localRequire(name);
    },
  });
  return {
    root,
    entered,
    child,
    get directory() {
      return directory;
    },
    get launchOptions() {
      return launchOptions;
    },
    fireDeadline() {
      assert.equal(timers.size, 1);
      const [token, timer] = [...timers][0];
      timers.delete(token);
      timer.callback();
      return timer.milliseconds;
    },
    callback(error) {
      callback(error);
    },
    worker: module.exports.createWindowsOcrWorker({
      workRoot: root,
      platform: "win32",
    }),
    async cleanup() {
      assert.equal(
        path.dirname(path.resolve(root)),
        path.resolve(__dirname, "../.runtime/receipt-tests"),
      );
      assert.match(path.basename(root), /^[a-f0-9-]{36}$/);
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
test("AbortSignal callback does not release the worker or remove owned files before native child close", async () => {
  const f = await fixture(),
    signal = new AbortController();
  const pending = f.worker.recognize(
    await fs.readFile(path.join(__dirname, "./fixtures/images/receipt-a.png")),
    { signal: signal.signal },
  );
  let settled = false;
  const result = pending.then(
    (value) => {
      settled = true;
      return value;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  try {
    await f.entered.promise;
    assert.equal(f.launchOptions.signal, signal.signal);
    signal.abort();
    f.callback(
      Object.assign(new Error("synthetic abort"), {
        name: "AbortError",
        code: "ABORT_ERR",
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.deepEqual(await fs.readdir(f.directory), ["input.png"]);
    f.child.emit("close", null, "SIGTERM");
    assert.equal((await result).code, "CANCELLED");
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally {
    await f.cleanup();
  }
});
test("spawn error still waits for close and reports unavailable with owned files cleaned", async () => {
  const f = await fixture();
  const pending = f.worker.recognize(
    await fs.readFile(path.join(__dirname, "./fixtures/images/receipt-a.png")),
  );
  let settled = false;
  const result = pending.catch((error) => {
    settled = true;
    return error;
  });
  try {
    await f.entered.promise;
    f.callback(
      Object.assign(new Error("synthetic spawn rejection"), { code: "EPERM" }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    f.child.emit("close", -1, null);
    assert.equal((await result).code, "OCR_UNAVAILABLE");
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally {
    await f.cleanup();
  }
});
test("successful callback plus child close reads verified output and cleans its copied input", async () => {
  const f = await fixture();
  const pending = f.worker.recognize(
    await fs.readFile(path.join(__dirname, "./fixtures/images/receipt-a.png")),
  );
  try {
    await f.entered.promise;
    await fs.writeFile(
      path.join(f.directory, "output.json"),
      JSON.stringify(output),
    );
    f.callback(null);
    f.child.emit("close", 0, null);
    assert.equal((await pending).provider, "windows-media-ocr");
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally {
    await f.cleanup();
  }
});
test("unconfirmed termination is bounded, retains only its job, blocks new OCR and cleans up only after actual close", async () => {
  const f = await fixture(),
    bytes = await fs.readFile(
      path.join(__dirname, "./fixtures/images/receipt-a.png"),
    );
  const pending = f.worker.recognize(bytes),
    result = pending.catch((error) => error);
  try {
    await f.entered.promise;
    f.callback(
      Object.assign(new Error("synthetic abort"), { code: "ABORT_ERR" }),
    );
    assert.equal(f.fireDeadline(), 5000);
    assert.equal((await result).code, "WORKER_UNCONFIRMED");
    assert.equal(f.worker.hasUnconfirmedProcess(), true);
    assert.deepEqual(await fs.readdir(f.directory), ["input.png"]);
    await assert.rejects(
      f.worker.drain(),
      (error) => error.code === "WORKER_UNCONFIRMED",
    );
    await assert.rejects(
      f.worker.recognize(bytes),
      (error) => error.code === "WORKER_UNCONFIRMED",
    );
    f.child.emit("close", null, "SIGTERM");
    for (let i = 0; i < 30 && f.worker.hasUnconfirmedProcess(); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(f.worker.hasUnconfirmedProcess(), false);
    await f.worker.drain();
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally {
    await f.cleanup();
  }
});
test("missing callback and missing close are bounded without treating a failed kill as reaped", async () => {
  const f = await fixture();
  const pending = f.worker.recognize(
      await fs.readFile(path.join(__dirname, "./fixtures/images/receipt-a.png")),
    ),
    result = pending.catch((error) => error);
  try {
    await f.entered.promise;
    assert.equal(f.fireDeadline(), 40000);
    assert.equal((await result).code, "WORKER_UNCONFIRMED");
    assert.equal(f.worker.hasUnconfirmedProcess(), true);
    assert.deepEqual(await fs.readdir(f.directory), ["input.png"]);
    f.child.emit("close", null, "SIGTERM");
    for (let i = 0; i < 30 && f.worker.hasUnconfirmedProcess(); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(f.worker.hasUnconfirmedProcess(), false);
  } finally {
    await f.cleanup();
  }
});
