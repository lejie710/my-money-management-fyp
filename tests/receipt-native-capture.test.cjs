const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const vm = require("node:vm"),
  ts = require("typescript");
function loadTsSource(file, imports) {
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    setTimeout,
    clearTimeout,
    require(name) {
      if (!Object.hasOwn(imports, name))
        throw Error(`Unexpected dependency: ${name}`);
      return imports[name];
    },
  });
  return exports;
}
const imageHeader = require("../src/attachments/imageHeader");
const captureCore = require("../src/receipts/captureManager");
const bytes = new Uint8Array(
  fs.readFileSync(
    path.join(__dirname, "./fixtures/images/blank.png"),
  ),
);
const header = imageHeader.inspectImageHeader(bytes);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const owner = {
  scope: { kind: "test", namespace: "native-capture" },
  actor: { kind: "firebase", uid: "synthetic-account" },
  incarnationId: "same-wallet",
};
function fixture(options = {}) {
  const records = new Map([
      ["content://synthetic/provider", { bytes: new Uint8Array(bytes) }],
    ]),
    calls = [];
  const join = (parts) =>
    parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
  class Directory {
    constructor(...parts) {
      this.uri = join(parts);
      calls.push([
        "directory",
        ...parts.map((p) => (typeof p === "string" ? p : p.uri)),
      ]);
    }
    create(settings) {
      calls.push(["mkdir", this.uri, settings]);
    }
  }
  class File {
    constructor(...parts) {
      this.uri = join(parts);
    }
    info() {
      calls.push(["info", this.uri]);
      if (options.infoError) throw Error("private file path");
      const record = records.get(this.uri);
      return record
        ? { exists: true, size: record.size ?? record.bytes.length }
        : { exists: false };
    }
    open(mode) {
      calls.push(["open", this.uri, mode]);
      const record = records.get(this.uri),
        uri = this.uri;
      return {
        get size() {
          return record.handleSize ?? record.bytes.length;
        },
        async readBytes(length) {
          calls.push(["readBytes", uri, length]);
          return record.bytes.slice(0, length);
        },
        close() {
          calls.push(["close-handle", uri]);
        },
      };
    }
    create(settings) {
      calls.push(["create", this.uri, settings]);
      if (options.createCollision) {
        records.set(this.uri, { bytes: new Uint8Array(bytes) });
        throw Error(
          "Synthetic native create collision after the existence check",
        );
      }
      records.set(this.uri, { bytes: new Uint8Array() });
    }
    async write(input) {
      calls.push(["write-start", this.uri]);
      if (options.writeGate) await options.writeGate.promise;
      records.set(this.uri, { bytes: new Uint8Array(input) });
      calls.push(["write-finish", this.uri]);
      if (options.writeError) throw Error("private path");
    }
    delete() {
      calls.push(["delete", this.uri]);
      records.delete(this.uri);
    }
  }
  const picker = {
    getPendingResultAsync: async () => {
      calls.push(["pending"]);
      return options.pending ?? null;
    },
    getCameraPermissionsAsync: async () => {
      calls.push(["camera-get"]);
      return options.permission ?? { granted: true, canAskAgain: true };
    },
    requestCameraPermissionsAsync: async () => {
      calls.push(["camera-request"]);
      return (
        options.requestPermission ?? { granted: false, canAskAgain: false }
      );
    },
    launchImageLibraryAsync: async (value) => {
      calls.push(["library", value]);
      return (
        options.result ?? {
          canceled: false,
          assets: [{ uri: "content://synthetic/provider" }],
        }
      );
    },
    launchCameraAsync: async (value) => {
      calls.push(["camera", value]);
      return (
        options.result ?? {
          canceled: false,
          assets: [{ uri: "content://synthetic/provider" }],
        }
      );
    },
  };
  const module = loadTsSource(
    path.join(__dirname, "../src/receipts/expoCapture.ts"),
    {
      "expo-file-system": {
        Directory,
        File,
        FileMode: { ReadOnly: "read-only" },
        Paths: { cache: { uri: "file:///cache" } },
      },
      "expo-image-picker": picker,
      "react-native": {
        Platform: { OS: options.platform ?? "android" },
        Image: {
          getSize(uri, success, error) {
            calls.push(["decode", uri]);
            if (options.decodeError) error();
            else
              success(
                options.width ?? header.width,
                options.height ?? header.height,
              );
          },
        },
      },
      "../attachments/imageHeader": imageHeader,
      "./captureManager": {
        ...captureCore,
        createReceiptCaptureManager: (config) => config,
      },
    },
  );
  return {
    records,
    calls,
    module,
    files: module.createExpoReceiptFiles(owner),
    config: () =>
      module.createExpoReceiptCapture({
        owner,
        sessionKey: "one",
        storage: {},
        newId: () => "one",
        isCurrent: () => true,
      }),
  };
}

test("actual adapter reads bounded bytes and validates header before native dimensions", async () => {
  const f = fixture(),
    output = await f.files.readSource("content://synthetic/provider");
  assert.deepEqual(output.bytes, bytes);
  assert.deepEqual(output.inspection, header);
  const read = f.calls.find(([name]) => name === "readBytes");
  assert.equal(read[2], bytes.length);
  assert.ok(
    f.calls.findIndex(([name]) => name === "close-handle") <
      f.calls.findIndex(([name]) => name === "decode"),
  );
  f.records.get("content://synthetic/provider").bytes = new Uint8Array(8);
  const decodes = f.calls.filter(([name]) => name === "decode").length;
  await assert.rejects(f.files.readSource("content://synthetic/provider"));
  assert.equal(f.calls.filter(([name]) => name === "decode").length, decodes);
});

test("oversize, changed size and wrong native dimensions refuse the source without a file write", async () => {
  const f = fixture();
  f.records.get("content://synthetic/provider").size =
    imageHeader.MAX_PHOTO_BYTES + 1;
  await assert.rejects(
    f.files.readSource("content://synthetic/provider"),
    /10 MiB/,
  );
  assert.equal(
    f.calls.some(([name]) => name === "open"),
    false,
  );
  f.records.get("content://synthetic/provider").size = bytes.length;
  f.records.get("content://synthetic/provider").handleSize = bytes.length + 1;
  await assert.rejects(
    f.files.readSource("content://synthetic/provider"),
    /changed/,
  );
  assert.ok(f.calls.some(([name]) => name === "close-handle"));
  const wrong = fixture({ width: header.width + 1 });
  await assert.rejects(
    wrong.files.readSource("content://synthetic/provider"),
    /dimensions/,
  );
  assert.equal(
    wrong.calls.some(([name]) => name === "write-start"),
    false,
  );
});

test("owned write is awaited and does not reopen or copy the gallery URI", async () => {
  const gate = deferred(),
    f = fixture({ writeGate: gate });
  let settled = false;
  const pending = f.files.writeOwned("receipt-one.image", bytes).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(
    f.calls.some(
      ([name, uri]) => name === "open" && uri.startsWith("content://"),
    ),
    false,
  );
  gate.resolve();
  await pending;
  assert.equal(settled, true);
  assert.deepEqual((await f.files.readOwned("receipt-one.image")).bytes, bytes);
  assert.deepEqual(f.records.get("content://synthetic/provider").bytes, bytes);
  await f.files.removeOwned("receipt-one.image");
  assert.ok(f.records.has("content://synthetic/provider"));
});

test("exclusive target refusal and owned write failure are distinct for safe cleanup", async () => {
  const f = fixture();
  f.records.set(f.files.uriFor("receipt-one.image"), { bytes });
  await assert.rejects(
    f.files.writeOwned("receipt-one.image", bytes),
    (e) => e.code === "TARGET_EXISTS",
  );
  assert.equal(
    f.calls.some(([name]) => name === "create"),
    false,
  );
  const failed = fixture({ writeError: true });
  await assert.rejects(
    failed.files.writeOwned("receipt-one.image", bytes),
    (e) =>
      e.code === "OWNED_WRITE_FAILED" && !e.message.includes("private path"),
  );
  assert.deepEqual(
    (await failed.files.readOwned("receipt-one.image")).bytes,
    bytes,
  );
});

test("native exclusive-create failure cannot be adopted or deleted merely because existing bytes match the selection", async () => {
  const f = fixture({ createCollision: true }),
    journal = new Map();
  const config = f.module.createExpoReceiptCapture({
    owner: {
      ...owner,
      scope: { kind: "test", namespace: "native-create-race" },
    },
    sessionKey: "create-race-session",
    storage: {
      async getItem(key) {
        return journal.get(key) ?? null;
      },
      async setItem(key, value) {
        journal.set(key, value);
      },
    },
    newId: () => "race-one",
    isCurrent: () => true,
  });
  const manager = captureCore.createReceiptCaptureManager(config);
  await assert.rejects(
    manager.pickPhoto(),
    (error) => error.code === "CREATE_UNCONFIRMED",
  );
  assert.equal(
    f.calls.some(([name]) => name === "write-start"),
    false,
  );
  const target = config.files.uriFor("receipt-race-one.image");
  assert.deepEqual(f.records.get(target).bytes, bytes);
  assert.equal((await manager.close()).pending, true);
  assert.equal((await manager.retryCleanup()).pending, true);
  assert.equal(
    f.calls.some(([name]) => name === "delete"),
    false,
  );
  assert.deepEqual(f.records.get(target).bytes, bytes);
});

test("exact generated names and fixed family directory block arbitrary paths and support long account IDs", async () => {
  const f = fixture();
  for (const name of [
    "../original.png",
    "receipt-one.image/child",
    "receipt-one.image?x",
    "file:///foreign",
  ]) {
    assert.throws(() => f.files.uriFor(name));
    await assert.rejects(f.files.removeOwned(name));
  }
  await assert.rejects(f.files.readSource("https://example.test/image.png"));
  const long = f.module.createExpoReceiptFiles({
    ...owner,
    actor: { kind: "firebase", uid: "x".repeat(128) },
  });
  const uri = long.uriFor("receipt-one.image");
  assert.match(uri, /receipt-captures/);
  assert.ok(uri.split("/").every((part) => part.length <= 100));
  const different = f.module.createExpoReceiptFiles({
    ...owner,
    actor: { kind: "firebase", uid: "other" },
  });
  assert.notEqual(
    f.files.uriFor("receipt-one.image"),
    different.uriFor("receipt-one.image"),
  );
});

test("gallery is explicit, image-only, single-select and returns cancellation without camera permission work", async () => {
  const f = fixture({ result: { canceled: true, assets: null } });
  assert.equal(await f.config().picker.pick("library"), null);
  const settings = f.calls.find(([name]) => name === "library")[1];
  assert.deepEqual(Array.from(settings.mediaTypes), ["images"]);
  assert.equal(settings.allowsMultipleSelection, false);
  assert.equal(settings.exif, false);
  assert.equal(settings.base64, false);
  assert.equal(
    f.calls.some(([name]) => name.startsWith("camera")),
    false,
  );
});

test("camera permission denial stops capture; explicit grant opens native camera only", async () => {
  const denied = fixture({
    permission: { granted: false, canAskAgain: false },
  });
  await assert.rejects(
    denied.config().picker.pick("camera"),
    (error) => error.code === "CAMERA_PERMISSION",
  );
  assert.equal(
    denied.calls.some(
      ([name]) => name === "camera-request" || name === "camera",
    ),
    false,
  );
  const allowed = fixture({
    permission: { granted: false, canAskAgain: true },
    requestPermission: { granted: true },
  });
  assert.equal(
    (await allowed.config().picker.pick("camera")).uri,
    "content://synthetic/provider",
  );
  assert.equal(
    allowed.calls.filter(([name]) => name === "camera-request").length,
    1,
  );
  assert.equal(allowed.calls.filter(([name]) => name === "camera").length, 1);
  assert.equal(
    allowed.calls.some(([name]) => name === "library"),
    false,
  );
});

test("interrupted Android picker results are never silently adopted by a new session", async () => {
  const f = fixture({
    pending: {
      canceled: false,
      assets: [{ uri: "content://earlier-session" }],
    },
  });
  await assert.rejects(
    f.config().picker.pick("library"),
    (error) => error.code === "PICKER_INTERRUPTED",
  );
  assert.equal(
    f.calls.some(([name]) => name === "library"),
    false,
  );
  const web = fixture({ platform: "web" });
  assert.equal(web.config().picker.cameraAvailable, false);
  await assert.rejects(
    web.config().picker.pick("camera"),
    (error) => error.code === "CAPTURE_UNAVAILABLE",
  );
});
