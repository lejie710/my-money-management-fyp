const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  http = require("node:http"),
  crypto = require("node:crypto");
const { createReceiptCompanion } = require("../scripts/companion/ocr/companion.cjs");
const {
  createWindowsOcrWorker,
  ReceiptServiceError,
} = require("../scripts/companion/ocr/windowsWorker.cjs");
const png = () =>
  fs.readFile(path.join(__dirname, "./fixtures/images/receipt-a.png"));
const result = () => ({
  version: 1,
  provider: "windows-media-ocr",
  language: "en-US",
  width: 1100,
  height: 900,
  elapsedMs: 1,
  textAngle: null,
  words: [],
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function cleanTestRoot(root) {
  assert.equal(
    path.dirname(path.resolve(root)),
    path.resolve(__dirname, "../.runtime/receipt-tests"),
  );
  assert.match(path.basename(root), /^[a-f0-9-]{36}$/);
  await fs.rm(root, { recursive: true, force: true });
}
async function connection(worker, options = {}) {
  const server = createReceiptCompanion({ worker, ...options }),
    config = await server.listen(0);
  return { server, config };
}
async function request(
  config,
  {
    bytes,
    token = config.token,
    mime = "image/png",
    route = config.url,
    origin,
    method = "POST",
  } = {},
) {
  const headers = { "Content-Type": mime, Authorization: `Bearer ${token}` };
  if (origin) headers.Origin = origin;
  const response = await fetch(route, { method, headers, body: bytes });
  return { status: response.status, body: await response.json() };
}
test("actual loopback transport uses a generated per-run token and returns only validated bounded OCR words", async () => {
  let calls = 0;
  const { server, config } = await connection({
    async recognize(bytes) {
      calls++;
      assert.ok(bytes.byteLength > 0);
      return {
        ...result(),
        sourceFile: "private path",
        text: "private flat text",
        secret: "canary",
      };
    },
  });
  try {
    assert.match(config.url, /^http:\/\/127\.0\.0\.1:\d+\/v1\/recognize$/);
    assert.ok(config.token.length >= 43);
    const response = await request(config, { bytes: await png() });
    assert.equal(response.status, 200);
    assert.equal(response.body.ocr.provider, "windows-media-ocr");
    assert.ok(!JSON.stringify(response.body).includes("private"));
    assert.ok(!JSON.stringify(response.body).includes("canary"));
    assert.equal(calls, 1);
  } finally {
    await server.close();
  }
});
test("wrong token, browser origin, route and content-type never invoke OCR", async () => {
  let calls = 0;
  const { server, config } = await connection({
    async recognize() {
      calls++;
      return result();
    },
  });
  try {
    const bytes = await png();
    assert.equal(
      (await request(config, { bytes, token: "invalid" })).status,
      401,
    );
    assert.equal(
      (await request(config, { bytes, origin: "http://example.test" })).status,
      403,
    );
    assert.equal(
      (await request(config, { bytes, route: config.url + "?path=private" }))
        .status,
      404,
    );
    assert.equal(
      (await request(config, { bytes, mime: "text/plain" })).status,
      415,
    );
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});
test("actual bytes, declared type and response dimensions are checked before returning success", async () => {
  let calls = 0;
  const { server, config } = await connection({
    async recognize() {
      calls++;
      return { ...result(), width: 1099 };
    },
  });
  try {
    assert.equal(
      (await request(config, { bytes: Buffer.from("not an image") })).status,
      422,
    );
    assert.equal(
      (await request(config, { bytes: await png(), mime: "image/jpeg" }))
        .status,
      422,
    );
    assert.equal(calls, 0);
    assert.equal((await request(config, { bytes: await png() })).status, 503);
    assert.equal(calls, 1);
  } finally {
    await server.close();
  }
});
test("only one receipt can be in flight and a timeout cancels the underlying recognition", async () => {
  const entered = deferred();
  let aborted = false;
  const worker = {
    recognize(bytes, { signal }) {
      entered.resolve();
      return new Promise((resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("private native payload"));
          },
          { once: true },
        ),
      );
    },
  };
  const { server, config } = await connection(worker, {
    requestTimeoutMs: 150,
    uploadTimeoutMs: 100,
  });
  try {
    const bytes = await png(),
      first = request(config, { bytes });
    await entered.promise;
    assert.equal((await request(config, { bytes })).status, 429);
    const timedOut = await first;
    assert.equal(timedOut.status, 504);
    assert.equal(timedOut.body.error.code, "TIMEOUT");
    assert.equal(aborted, true);
    assert.ok(!JSON.stringify(timedOut.body).includes("private"));
  } finally {
    await server.close();
  }
});
test("disconnect aborts OCR and helper close drains the cancelled worker", async () => {
  const entered = deferred(),
    stopped = deferred();
  const { server, config } = await connection({
    recognize(bytes, { signal }) {
      entered.resolve();
      return new Promise((resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            stopped.resolve();
            reject(new Error("cancelled"));
          },
          { once: true },
        ),
      );
    },
  });
  const bytes = await png(),
    url = new URL(config.url);
  const req = http.request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "image/png",
      "Content-Length": bytes.length,
    },
  });
  req.on("error", () => {});
  req.end(bytes);
  await entered.promise;
  req.destroy();
  await stopped.promise;
  await server.close();
});
test("declared oversized input is refused before uploading or invoking a worker", async () => {
  let calls = 0;
  const { server, config } = await connection({
    async recognize() {
      calls++;
      return result();
    },
  });
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        config.url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.token}`,
            "Content-Type": "image/png",
            "Content-Length": 10485761,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 413);
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});
test("worker gets hidden safe argument execution, only owned copied files, and cleanup preserves the source", async () => {
  const root = path.join(__dirname, "../.runtime/receipt-tests", crypto.randomUUID()),
    source = await png();
  let directory;
  const worker = createWindowsOcrWorker({
    workRoot: root,
    platform: "win32",
    async run(executable, args, options) {
      directory = options.cwd;
      assert.equal(options.windowsHide, true);
      assert.ok(executable.endsWith("powershell.exe"));
      assert.ok(args.includes("-NonInteractive"));
      assert.equal(args[args.length - 1], directory);
      assert.equal(path.dirname(directory), root);
      assert.deepEqual(await fs.readdir(directory), ["input.png"]);
      assert.deepEqual(
        await fs.readFile(path.join(directory, "input.png")),
        source,
      );
      await fs.writeFile(
        path.join(directory, "output.json"),
        JSON.stringify(result()),
      );
    },
  });
  try {
    assert.equal(
      (await worker.recognize(source)).provider,
      "windows-media-ocr",
    );
    assert.deepEqual(await fs.readdir(root), []);
    assert.deepEqual(await png(), source);
  } finally {
    await cleanTestRoot(root);
  }
});
test("worker failure, bounded output, malformed response and cancellation still clean owned request files", async () => {
  const source = await png();
  for (const kind of ["missing", "huge", "malformed", "cancelled"]) {
    const root = path.join(__dirname, "../.runtime/receipt-tests", crypto.randomUUID()),
      abort = new AbortController();
    const worker = createWindowsOcrWorker({
      workRoot: root,
      platform: "win32",
      async run(executable, args, { cwd }) {
        if (kind === "huge")
          await fs.writeFile(
            path.join(cwd, "output.json"),
            "x".repeat(1024 * 1024 + 1),
          );
        if (kind === "malformed")
          await fs.writeFile(path.join(cwd, "output.json"), "{");
        if (kind === "cancelled") abort.abort();
        throw new Error("private worker details");
      },
    });
    try {
      await assert.rejects(
        worker.recognize(source, { signal: abort.signal }),
        (error) =>
          ["OCR_FAILED", "CANCELLED"].includes(error.code) &&
          !error.message.includes("private"),
      );
      assert.deepEqual(await fs.readdir(root), []);
    } finally {
      await cleanTestRoot(root);
    }
  }
});
test("provider and token configuration do not silently fall back to another endpoint or recognizer", async () => {
  assert.throws(() => createReceiptCompanion({ token: "fixed" }));
  const worker = createWindowsOcrWorker({ platform: "linux" });
  await assert.rejects(
    worker.recognize(await png()),
    (error) => error.code === "OCR_UNAVAILABLE",
  );
});

test("extension routes share Bearer and Origin checks without receiving a separate token or overriding receipt routing", async () => {
  let calls = 0,
    closed = 0;
  const route = {
    method: "POST",
    path: "/v1/assistant/explain",
    async handle(req, res) {
      calls++;
      req.resume();
      const body = JSON.stringify({ version: 1, result: "synthetic" });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
    },
    async close() {
      closed++;
    },
  };
  assert.throws(() =>
    createReceiptCompanion({ routes: [{ ...route, path: "/v1/recognize" }] }),
  );
  assert.throws(() => createReceiptCompanion({ routes: [route, route] }));
  const { server, config } = await connection(
    {
      async recognize() {
        return result();
      },
    },
    { routes: [route] },
  );
  const address = config.url.replace("/recognize", "/assistant/explain");
  try {
    assert.equal(
      (
        await request(config, {
          route: address,
          bytes: Buffer.from("{}"),
          mime: "application/json",
          token: "wrong",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(config, {
          route: address,
          bytes: Buffer.from("{}"),
          mime: "application/json",
          origin: "http://example.test",
        })
      ).status,
      403,
    );
    assert.equal(calls, 0);
    assert.equal(
      (
        await request(config, {
          route: address,
          bytes: Buffer.from("{}"),
          mime: "application/json",
        })
      ).status,
      200,
    );
    assert.equal(calls, 1);
  } finally {
    await server.close();
    await server.close();
  }
  assert.equal(closed, 1);
});

test("shared shutdown invokes extension close and drains its work before waiting for a response; OCR and extension busy states are independent", async () => {
  const entered = deferred(),
    drain = deferred();
  let closeCalls = 0;
  const route = {
    method: "POST",
    path: "/v1/assistant/explain",
    async handle(req, res) {
      req.resume();
      entered.resolve();
      await drain.promise;
    },
    async close() {
      closeCalls++;
      drain.resolve();
    },
  };
  const { server, config } = await connection(
    {
      async recognize() {
        return result();
      },
    },
    { routes: [route] },
  );
  const waiting = request(config, {
    route: config.url.replace("/recognize", "/assistant/explain"),
    bytes: Buffer.from("{}"),
    mime: "application/json",
  }).catch(() => null);
  await entered.promise;
  assert.equal((await request(config, { bytes: await png() })).status, 200);
  await server.close();
  await waiting;
  assert.equal(closeCalls, 1);
});

test("extension exceptions and failed close return generic outcomes without exposing exception payloads", async () => {
  const route = {
    method: "POST",
    path: "/v1/assistant/explain",
    async handle() {
      throw new Error("Private prompt canary");
    },
    async close() {
      throw new Error("Private process canary");
    },
  };
  const { server, config } = await connection(
    {
      async recognize() {
        return result();
      },
    },
    { routes: [route] },
  );
  const response = await request(config, {
    route: config.url.replace("/recognize", "/assistant/explain"),
    bytes: Buffer.from("{}"),
    mime: "application/json",
  });
  assert.equal(response.status, 503);
  assert.ok(!JSON.stringify(response.body).includes("Private"));
  await assert.rejects(
    server.close(),
    (error) =>
      !error.message.includes("Private") && /cleanup/.test(error.message),
  );
});

test("unconfirmed OCR quarantines further uploads and failed shutdown still closes other owned routes", async () => {
  let unknown = false,
    calls = 0,
    routeClose = 0;
  const worker = {
    async recognize() {
      calls++;
      unknown = true;
      throw new ReceiptServiceError("WORKER_UNCONFIRMED", "private child data");
    },
    hasUnconfirmedProcess() {
      return unknown;
    },
    async drain() {
      if (unknown)
        throw new ReceiptServiceError(
          "WORKER_UNCONFIRMED",
          "Owned worker shutdown is unconfirmed.",
        );
    },
  };
  const { server, config } = await connection(worker, {
    routes: [
      {
        method: "GET",
        path: "/v1/status",
        handle() {},
        async close() {
          routeClose++;
        },
      },
    ],
  });
  try {
    const response = await request(config, { bytes: await png() });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "WORKER_UNCONFIRMED");
    assert.ok(!JSON.stringify(response.body).includes("private"));
    const second = await request(config, { bytes: await png() });
    assert.equal(second.body.error.code, "WORKER_UNCONFIRMED");
    assert.equal(calls, 1);
    await assert.rejects(
      server.close(),
      (error) => error.code === "WORKER_UNCONFIRMED",
    );
    assert.equal(routeClose, 1);
    unknown = false;
    await server.close();
    assert.equal(routeClose, 1);
  } finally {
    unknown = false;
    await server.close();
  }
});
