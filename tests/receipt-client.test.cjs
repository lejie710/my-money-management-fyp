const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { createReceiptClient } = require("../src/receipts/client");
const config = {
    url: "http://127.0.0.1:8790/v1/recognize",
    token: crypto.randomBytes(32).toString("base64url"),
  },
  bytes = fs.readFileSync(path.join(__dirname, "./fixtures/images/receipt-a.png"));
const ocr = {
  version: 1,
  provider: "windows-media-ocr",
  language: "en-US",
  width: 1100,
  height: 900,
  elapsedMs: 1,
  textAngle: null,
  words: [],
};
const response = (data, status = 200) => {
  const body = JSON.stringify(data);
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  });
};
test("client preserves source bytes and uses exact loopback endpoint with cancellation and safe transport options", async () => {
  let calls = 0;
  const before = Buffer.from(bytes),
    client = createReceiptClient(config, {
      async fetch(url, options) {
        calls++;
        assert.equal(url, config.url);
        assert.equal(options.redirect, "error");
        assert.equal(options.credentials, "omit");
        assert.equal(options.headers["Content-Type"], "image/png");
        assert.equal(options.signal.aborted, false);
        assert.deepEqual(Buffer.from(options.body), before);
        return response({ version: 1, ocr });
      },
    });
  assert.equal((await client.recognize(bytes)).provider, "windows-media-ocr");
  assert.equal(calls, 1);
  assert.deepEqual(bytes, before);
});
test("arbitrary remote endpoints, URL tokens, short credentials and invalid bytes are refused", async () => {
  for (const url of [
    "http://localhost:8790/v1/recognize",
    "https://example.test/v1/recognize",
    "http://127.0.0.1:8790/v1/recognize?token=x",
    "http://127.0.0.1:0/v1/recognize",
  ])
    assert.throws(() => createReceiptClient({ ...config, url }));
  assert.throws(() => createReceiptClient({ ...config, token: "hardcoded" }));
  let called = false;
  const client = createReceiptClient(config, {
    async fetch() {
      called = true;
    },
  });
  await assert.rejects(
    client.recognize(new Uint8Array([1, 2, 3])),
    (e) => e.code === "IMAGE_INVALID",
  );
  assert.equal(called, false);
});
test("timeout and user cancellation abort the actual request with distinct fixed errors and no retries", async () => {
  let calls = 0;
  const fetcher = (url, { signal }) => {
    calls++;
    return new Promise((resolve, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(new Error("private transport payload")),
        { once: true },
      ),
    );
  };
  await assert.rejects(
    createReceiptClient(config, { fetch: fetcher, timeoutMs: 50 }).recognize(
      bytes,
    ),
    (e) => e.code === "TIMEOUT",
  );
  const abort = new AbortController(),
    pending = createReceiptClient(config, { fetch: fetcher }).recognize(bytes, {
      signal: abort.signal,
    });
  abort.abort();
  await assert.rejects(pending, (e) => e.code === "CANCELLED");
  assert.equal(calls, 2);
});
test("unbounded or malformed responses and geometry mismatches are rejected", async () => {
  const values = [
    new Response("{}", { headers: { "Content-Type": "application/json" } }),
    new Response("{}", {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": 1048577,
      },
    }),
    response({ version: 2, ocr }),
    response({ version: 1, ocr: { ...ocr, width: 1099 } }),
  ];
  for (const value of values) {
    const client = createReceiptClient(config, {
      async fetch() {
        return value;
      },
    });
    await assert.rejects(
      client.recognize(bytes),
      (e) => e.code === "INVALID_RESPONSE",
    );
  }
});
test("server and network error payloads never become receipt messages or copied logs", async () => {
  const client = createReceiptClient(config, {
    async fetch() {
      return response(
        {
          error: { code: "OCR_FAILED", message: "private raw receipt content" },
        },
        503,
      );
    },
  });
  await assert.rejects(
    client.recognize(bytes),
    (e) => e.code === "OCR_FAILED" && !e.message.includes("private"),
  );
  await assert.rejects(
    createReceiptClient(config, {
      async fetch() {
        throw new Error("private network body");
      },
    }).recognize(bytes),
    (e) => e.code === "NETWORK" && !e.message.includes("private"),
  );
});

test("actual response UTF8 byte length must fit and match the declared bound, including multibyte text", async () => {
  const text = JSON.stringify({
    version: 1,
    ocr,
    unexpected: "界".repeat(400000),
  });
  const client = createReceiptClient(config, {
    async fetch() {
      return new Response(text, {
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(text.length),
        },
      });
    },
  });
  await assert.rejects(
    client.recognize(bytes),
    (error) => error.code === "INVALID_RESPONSE",
  );
  const mismatch = createReceiptClient(config, {
    async fetch() {
      return new Response(JSON.stringify({ version: 1, ocr }), {
        headers: { "Content-Type": "application/json", "Content-Length": "10" },
      });
    },
  });
  await assert.rejects(
    mismatch.recognize(bytes),
    (error) => error.code === "INVALID_RESPONSE",
  );
});
