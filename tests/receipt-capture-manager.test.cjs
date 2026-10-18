const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const managerPath = "../src/receipts/captureManager";
const core = require(managerPath);
const { inspectImageHeader } = require("../src/attachments/imageHeader");
const bytes = new Uint8Array(
  fs.readFileSync(
    path.join(__dirname, "./fixtures/images/blank.png"),
  ),
);
const inspection = inspectImageHeader(bytes);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
let sequence = 0;
function fixture(overrides = {}) {
  const namespace = `capture-${++sequence}`,
    records = new Map(),
    store = new Map(),
    calls = [];
  const owner = {
    scope: { kind: "test", namespace },
    actor: { kind: "local" },
    incarnationId: "wallet-one",
  };
  let active = true,
    id = 0;
  const storage = {
    async getItem(key) {
      if (overrides.get) return overrides.get(key, store);
      return store.get(key) ?? null;
    },
    async setItem(key, value) {
      calls.push(["store", JSON.parse(value)]);
      if (overrides.set) return overrides.set(key, value, store);
      store.set(key, value);
    },
  };
  const files = {
    async readSource(uri) {
      calls.push(["read-source", uri]);
      return { bytes: new Uint8Array(bytes), inspection: { ...inspection } };
    },
    async writeOwned(name, input) {
      calls.push(["write", name]);
      if (overrides.write) return overrides.write(name, input, records);
      records.set(name, new Uint8Array(input));
    },
    async readOwned(name) {
      calls.push(["read", name]);
      if (overrides.read) return overrides.read(name, records);
      if (!records.has(name)) throw Error("missing");
      const input = new Uint8Array(records.get(name));
      return { bytes: input, inspection: inspectImageHeader(input) };
    },
    async statOwned(name) {
      if (overrides.stat) return overrides.stat(name, records);
      return records.has(name) ? { byteSize: records.get(name).length } : null;
    },
    async removeOwned(name) {
      calls.push(["delete", name]);
      if (overrides.remove) return overrides.remove(name, records);
      records.delete(name);
    },
    uriFor: (name) => `file:///owned/${namespace}/${name}`,
  };
  const picker = {
    cameraAvailable: overrides.cameraAvailable ?? true,
    async pick(kind) {
      calls.push(["pick", kind]);
      return overrides.pick
        ? overrides.pick(kind)
        : { uri: "content://synthetic/receipt" };
    },
  };
  const options = {
    owner,
    sessionKey: `${namespace}/session-one`,
    storage,
    files,
    picker,
    isCurrent: () => active,
    newId: () => `image-${++id}`,
  };
  const manager = core.createReceiptCaptureManager(options);
  return {
    manager,
    options,
    records,
    store,
    calls,
    files,
    owner,
    deactivate: () => {
      active = false;
    },
  };
}
const noSignal = () => ({ signal: new AbortController().signal });

test("selection writes a unique owned snapshot, returns only frozen id/URI and never changes the provider", async () => {
  const f = fixture(),
    selected = await f.manager.pickPhoto(),
    again = await f.manager.pickPhoto();
  assert.deepEqual(Object.keys(selected).sort(), ["id", "uri"]);
  assert.ok(Object.isFrozen(selected));
  assert.notEqual(selected.id, again.id);
  assert.notEqual(selected.uri, "content://synthetic/receipt");
  const output = await f.manager.readBytes(selected, noSignal());
  assert.deepEqual(output, bytes);
  output[0] = 0;
  assert.deepEqual(await f.manager.readBytes(selected, noSignal()), bytes);
  await f.manager.release(selected);
  await f.manager.release(selected);
  assert.equal(f.records.size, 1);
  assert.ok(
    f.calls
      .filter(([name]) => name === "delete")
      .every(([, name]) => name.startsWith("receipt-")),
  );
  await f.manager.release(again);
  await f.manager.close();
  assert.equal(f.records.size, 0);
});

test("native cancellation and denied camera capability cannot create a snapshot", async () => {
  const f = fixture({ pick: async () => null, cameraAvailable: false });
  assert.equal(await f.manager.pickPhoto(), null);
  await assert.rejects(
    f.manager.takePhoto(),
    (error) => error.code === "CAMERA_UNAVAILABLE",
  );
  assert.equal(f.store.size, 0);
  assert.equal(f.records.size, 0);
  await f.manager.close();
});

test("duplicate selection and closing during a picker reject late work before any file copy", async () => {
  const gate = deferred(),
    f = fixture({ pick: () => gate.promise });
  const first = f.manager.pickPhoto();
  await assert.rejects(f.manager.pickPhoto(), (error) => error.code === "BUSY");
  await flush();
  const closed = f.manager.close();
  gate.resolve({ uri: "content://late" });
  await assert.rejects(first, (error) => error.code === "STALE");
  await closed;
  assert.equal(
    f.calls.some(([name]) => name === "read-source"),
    false,
  );
  assert.equal(f.records.size, 0);
});

test("release waits for a real read to settle even when its consumer aborts", async () => {
  const f = fixture(),
    selected = await f.manager.pickPhoto(),
    gate = deferred();
  f.files.readOwned = async (name) => {
    await gate.promise;
    return { bytes: new Uint8Array(f.records.get(name)), inspection };
  };
  const abort = new AbortController(),
    reading = f.manager.readBytes(selected, { signal: abort.signal });
  await flush();
  abort.abort();
  const releasing = f.manager.release(selected);
  await flush();
  assert.equal(f.records.size, 1);
  gate.resolve();
  await assert.rejects(reading, (error) => error.code === "ABORTED");
  await releasing;
  assert.equal(f.records.size, 0);
  await f.manager.close();
});

test("close during a write drains the write and cleans the late owned snapshot without returning it", async () => {
  const gate = deferred(),
    f = fixture({
      write: async (name, input, records) => {
        await gate.promise;
        records.set(name, new Uint8Array(input));
      },
    });
  const selecting = f.manager.pickPhoto();
  await flush();
  const closing = f.manager.close();
  assert.equal(f.records.size, 0);
  gate.resolve();
  await assert.rejects(selecting, (error) => error.code === "STALE");
  await closing;
  assert.equal(f.records.size, 0);
});

test("registered handle checks block arbitrary paths and another actor even with the same incarnation", async () => {
  const f = fixture(),
    selected = await f.manager.pickPhoto();
  const other = core.createReceiptCaptureManager({
    ...f.options,
    owner: { ...f.owner, actor: { kind: "firebase", uid: "other-actor" } },
    sessionKey: "other",
  });
  for (const image of [
    { ...selected, uri: "file:///foreign/original.png" },
    { ...selected, id: "unknown" },
    { ...selected, extra: true },
  ]) {
    await assert.rejects(
      f.manager.readBytes(image, noSignal()),
      (error) => error.code === "SELECTION_INVALID",
    );
    await assert.rejects(
      f.manager.release(image),
      (error) => error.code === "SELECTION_INVALID",
    );
  }
  await assert.rejects(
    other.release(selected),
    (error) => error.code === "SELECTION_INVALID",
  );
  assert.equal(f.records.size, 1);
  await other.close();
  await f.manager.release(selected);
  await f.manager.close();
});

test("failed registration before copy prevents native writes; exact write-then-throw is adopted", async () => {
  let reject = true;
  const f = fixture({
    set: async (key, value, store) => {
      if (reject) throw Error("disk");
      store.set(key, value);
    },
  });
  await assert.rejects(
    f.manager.pickPhoto(),
    (error) => error.code === "JOURNAL_SAVE",
  );
  assert.equal(
    f.calls.some(([name]) => name === "write"),
    false,
  );
  reject = false;
  await f.manager.close();
  const after = fixture({
    set: async (key, value, store) => {
      store.set(key, value);
      throw Error("after effect");
    },
  });
  const selection = await after.manager.pickPhoto();
  assert.deepEqual(await after.manager.readBytes(selection, noSignal()), bytes);
  assert.equal(after.calls.filter(([name]) => name === "write").length, 1);
  await after.manager.release(selection);
  await after.manager.close();
});

test("write-then-throw must match the captured bytes; owned partial writes can be cleaned", async () => {
  const complete = fixture({
    write: async (name, input, records) => {
      records.set(name, new Uint8Array(input));
      throw new core.ReceiptCaptureError(
        "OWNED_WRITE_FAILED",
        "Synthetic write after successful exclusive creation.",
      );
    },
  });
  const selection = await complete.manager.pickPhoto();
  assert.ok(selection.id);
  await complete.manager.release(selection);
  await complete.manager.close();
  const partial = fixture({
    write: async (name, input, records) => {
      records.set(name, input.slice(0, 8));
      throw new core.ReceiptCaptureError(
        "OWNED_WRITE_FAILED",
        "Synthetic owned write failure.",
      );
    },
  });
  await assert.rejects(partial.manager.pickPhoto());
  assert.equal(partial.records.size, 0);
  await partial.manager.close();
});

test("release errors retain deletion intent and explicit cleanup retry repairs even a prior journal read failure", async () => {
  let readFail = false,
    deleteFail = true;
  const f = fixture({
    get: async (key, store) => {
      if (readFail) throw Error("read");
      return store.get(key) ?? null;
    },
    remove: async (name, records) => {
      if (deleteFail) throw Error("delete");
      records.delete(name);
    },
  });
  const selection = await f.manager.pickPhoto();
  readFail = true;
  await assert.rejects(f.manager.release(selection));
  readFail = false;
  assert.equal((await f.manager.retryCleanup()).pending, true);
  assert.equal(f.records.size, 1);
  assert.equal(
    JSON.parse(f.store.get(f.manager.journalKey)).entries[0].phase,
    "delete",
  );
  deleteFail = false;
  assert.equal((await f.manager.retryCleanup()).pending, false);
  assert.equal(f.records.size, 0);
  await f.manager.close();
});

test("delete-then-throw and repeated released-handle cleanup resolve confirmed absence without deletion repeats", async () => {
  const f = fixture({
    remove: async (name, records) => {
      records.delete(name);
      throw Error("after delete");
    },
  });
  const selection = await f.manager.pickPhoto();
  await f.manager.release(selection);
  await f.manager.release(selection);
  await f.manager.retryCleanup();
  assert.equal(f.calls.filter(([name]) => name === "delete").length, 1);
  await f.manager.close();
});

test("corrupt, foreign, future or disappeared journals never reset ownership or delete files", async () => {
  for (const mode of ["corrupt", "foreign", "future", "missing"]) {
    const f = fixture(),
      selection = await f.manager.pickPhoto();
    const original = f.store.get(f.manager.journalKey),
      value = JSON.parse(original);
    if (mode === "corrupt") f.store.set(f.manager.journalKey, "{broken");
    if (mode === "foreign")
      f.store.set(
        f.manager.journalKey,
        JSON.stringify({ ...value, familyToken: "foreign" }),
      );
    if (mode === "future")
      f.store.set(
        f.manager.journalKey,
        JSON.stringify({ ...value, version: 2 }),
      );
    if (mode === "missing") f.store.delete(f.manager.journalKey);
    const before = f.store.get(f.manager.journalKey);
    await assert.rejects(f.manager.release(selection));
    await assert.rejects(f.manager.retryCleanup());
    assert.equal(f.records.size, 1);
    assert.equal(f.store.get(f.manager.journalKey), before);
    f.store.set(f.manager.journalKey, original);
    await f.manager.close();
  }
});

test("temporary-file cap fails before another native picker and does not evict active captures", async () => {
  const f = fixture();
  const selected = [];
  for (let index = 0; index < core.MAX_RECEIPT_CAPTURES; index++)
    selected.push(await f.manager.pickPhoto());
  await assert.rejects(
    f.manager.pickPhoto(),
    (error) => error.code === "CACHE_FULL",
  );
  assert.equal(f.calls.filter(([name]) => name === "pick").length, 8);
  assert.equal((await f.manager.retryCleanup()).retained, 8);
  assert.equal((await f.manager.close()).pending, true);
  assert.equal(f.records.size, 8);
  for (const image of selected) await f.manager.release(image);
  assert.equal(f.records.size, 0);
});

test("native target collision is never adopted or removed, including failed removal of its journal reservation", async () => {
  let afterCollision = false;
  const f = fixture({
    write: async (name, input, records) => {
      records.set(name, new Uint8Array(input));
      afterCollision = true;
      throw new core.ReceiptCaptureError(
        "TARGET_EXISTS",
        "Synthetic collision.",
      );
    },
    set: async (key, value, store) => {
      if (afterCollision) throw Error("journal failure");
      store.set(key, value);
    },
  });
  await assert.rejects(f.manager.pickPhoto());
  const result = await f.manager.retryCleanup();
  assert.equal(result.pending, true);
  assert.equal(f.records.size, 1);
  assert.equal(
    f.calls.some(([name]) => name === "delete"),
    false,
  );
  await f.manager.close();
});

test("relaunch cleanup removes abandoned ready snapshots but retains ambiguous copy intent and unregistered files", async () => {
  const f = fixture(),
    selected = await f.manager.pickPhoto();
  const state = JSON.parse(f.store.get(f.manager.journalKey));
  state.entries.push({
    ...state.entries[0],
    id: "uncertain",
    fileName: "receipt-uncertain.image",
    phase: "copying",
  });
  f.store.set(f.manager.journalKey, JSON.stringify(state));
  f.records.set("receipt-uncertain.image", new Uint8Array(bytes));
  f.records.set("unregistered.image", new Uint8Array(bytes));
  // A fresh module represents process memory being lost; no native process is started.
  delete require.cache[require.resolve(managerPath)];
  const fresh = require(managerPath).createReceiptCaptureManager({
    ...f.options,
    sessionKey: "new-process-session",
  });
  const result = await fresh.retryCleanup();
  assert.equal(result.pending, true);
  assert.equal(f.records.has(`receipt-${selected.id}.image`), false);
  assert.equal(f.records.has("receipt-uncertain.image"), true);
  assert.equal(f.records.has("unregistered.image"), true);
  await fresh.close();
});

test("raw native errors are replaced with fixed user messages and no private provider path", async () => {
  const f = fixture({
    pick: async () => {
      throw Error("content://private-account/path");
    },
  });
  await assert.rejects(
    f.manager.pickPhoto(),
    (error) =>
      error.code === "CAPTURE_UNAVAILABLE" &&
      !error.message.includes("private-account"),
  );
  await f.manager.close();
});

test("an unclassified write failure cannot adopt matching bytes without successful-create proof", async () => {
  const f = fixture({
    write: async (name, input, records) => {
      records.set(name, new Uint8Array(input));
      throw Error("unknown native create or write outcome");
    },
  });
  await assert.rejects(
    f.manager.pickPhoto(),
    (error) => error.code === "CAPTURE_FAILED",
  );
  assert.equal((await f.manager.close()).pending, true);
  assert.equal((await f.manager.retryCleanup()).pending, true);
  assert.equal(f.records.size, 1);
  assert.equal(
    f.calls.some(([name]) => name === "delete"),
    false,
  );
});

test("closing retains a published URI until UI releases it after the permanent photo copy drains", async () => {
  const f = fixture(),
    image = await f.manager.pickPhoto();
  assert.equal((await f.manager.close()).pending, true);
  assert.equal(f.records.size, 1);
  assert.equal((await f.manager.retryCleanup()).pending, true);
  await assert.rejects(
    f.manager.readBytes(image, noSignal()),
    (error) => error.code === "STALE",
  );
  // This release represents the UI awaiting PhotoManager.closeDraft first.
  await f.manager.release(image);
  assert.equal(f.records.size, 0);
  assert.equal((await f.manager.retryCleanup()).pending, false);
});
