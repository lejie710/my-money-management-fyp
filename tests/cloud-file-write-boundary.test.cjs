const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { loadSource } = require('./helpers/account-hook-harness.cjs'),
  { inspectImageHeader } = require('../src/attachments/imageHeader'),
  { sha256Hex } = require('../src/cloud/hash'),
  { validatePhotoRef } = require('../src/core/transactionContext');
const family = {
  scope: { kind: 'test', namespace: 'async-cloud-photo-write' },
  actor: { kind: 'firebase-hosted', projectId: 'demo-photo-write', uid: 'synthetic-owner' },
};
const bytes = new Uint8Array(
    fs.readFileSync(path.join(__dirname, 'fixtures/images/receipt-a.png')),
  ),
  hash = sha256Hex(bytes),
  photo = {
    id: 'photo-cloud-write',
    ownerIncarnationId: 'wallet-photo-write',
    fileName: 'photo-cloud-write.png',
    ...inspectImageHeader(bytes),
  };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(kind) {
  const gate = deferred(),
    started = deferred(),
    data = new Map(),
    calls = {
      writeStarted: 0,
      writeSettled: 0,
      imported: 0,
      closed: 0,
      disposed: 0,
      drained: 0,
      deleted: 0,
    };
  let active = true;
  class Directory {
    constructor(...parts) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
      this.present = false;
    }
    create() {
      assert.equal(this.present, false);
      this.present = true;
    }
    info() {
      return { exists: this.present };
    }
    delete() {
      calls.deleted++;
      this.present = false;
      for (const key of data.keys()) if (key.startsWith(this.uri + '/')) data.delete(key);
    }
  }
  class File {
    constructor(parent, name) {
      this.uri = name === undefined ? parent : parent.uri + '/' + name;
    }
    info() {
      return { exists: data.has(this.uri), size: data.get(this.uri)?.length ?? 0 };
    }
    async write(value) {
      calls.writeStarted++;
      data.set(this.uri, new Uint8Array());
      started.resolve();
      await gate.promise;
      data.set(this.uri, new Uint8Array(value));
      calls.writeSettled++;
    }
    async bytes() {
      if (!data.has(this.uri)) throw Error('missing owned file');
      return new Uint8Array(data.get(this.uri));
    }
    delete() {
      data.delete(this.uri);
    }
  }
  const owned = 'file:///owned/' + photo.fileName;
  const importFile = async (picked) => {
    calls.imported++;
    assert.equal(calls.writeSettled, 1, 'Native inspection must start after File.write resolves');
    const value = data.get(picked.uri);
    assert.equal(value?.length, bytes.length);
    assert.equal(sha256Hex(value), hash);
    data.set(owned, new Uint8Array(value));
    return photo;
  };
  const manager = {
    async initialize() {
      return { pending: false };
    },
    beginDraft() {
      return { id: 'draft-write', ownerIncarnationId: photo.ownerIncarnationId };
    },
    async stage(_, picked) {
      return importFile(picked);
    },
    async importRetained(_, picked) {
      return importFile(picked);
    },
    async closeDraft() {
      calls.closed++;
      return { pending: false };
    },
    dispose() {
      calls.disposed++;
    },
    async drain() {
      calls.drained++;
    },
  };
  const adapter = {
    async inspectOwned() {
      return data.has(owned) ? inspectImageHeader(data.get(owned)) : null;
    },
    uriFor: () => owned,
  };
  const imports = {
    '@react-native-async-storage/async-storage': {},
    'expo-file-system': { Directory, File, Paths: { cache: 'file:///cache' } },
    '../attachments/photoFiles': { createPhotoFileAdapter: () => adapter },
    '../attachments/photoManager': {
      createPhotoManager: () => manager,
      photoFamilyToken: () => 'synthetic-photo-family',
    },
    '../attachments/imageHeader': { inspectImageHeader },
    '../core/transactionContext': { validatePhotoRef },
    './hash': { sha256Hex },
    './nativeFiles': { createBackupFileServices: () => ({ read: async () => bytes }) },
  };
  const module = loadSource(
    path.join(
      __dirname,
      '../src/cloud/' + (kind === 'backup' ? 'nativeFiles.ts' : 'everydayFiles.ts'),
    ),
    imports,
  );
  const current = () => {
    if (!active) throw Error('The account changed.');
  };
  const start =
    kind === 'backup'
      ? () =>
          module
            .createBackupFileServices()
            .stage(
              family,
              {},
              photo.ownerIncarnationId,
              [{ sha256: hash, mimeType: photo.mimeType, byteSize: bytes.length }],
              async () => bytes,
              current,
            )
      : () =>
          module
            .createEverydayPhotoServices()
            .hydrate(family, {}, [{ photo, sha256: hash }], async () => bytes, current);
  return {
    gate,
    started,
    calls,
    data,
    start,
    retire() {
      active = false;
    },
  };
}
for (const kind of ['backup', 'everyday']) {
  test(`${kind} temporary photo waits for asynchronous write before inspection and cleanup`, async () => {
    const f = fixture(kind),
      pending = f.start().then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    try {
      await f.started.promise;
      await tick();
      assert.equal(f.calls.imported, 0);
      assert.equal(f.calls.deleted, 0);
      f.gate.resolve();
      const outcome = await pending;
      assert.equal(outcome.error, undefined);
      assert.equal(f.calls.imported, 1);
      assert.equal(f.calls.writeSettled, 1);
      if (kind === 'backup') await outcome.value.close();
      assert.equal(f.calls.deleted, 1);
      assert.equal(f.calls.disposed, 1);
    } finally {
      f.gate.resolve();
      await pending;
    }
  });
  test(`${kind} rejected asynchronous write never imports a partial image and still cleans owned temporary state`, async () => {
    const f = fixture(kind),
      pending = f.start().then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    await f.started.promise;
    f.gate.reject(Error('Synthetic native write failure'));
    const result = await pending;
    assert.ok(result.error);
    assert.equal(f.calls.writeSettled, 0);
    assert.equal(f.calls.imported, 0);
    assert.equal(f.calls.deleted, 1);
    assert.equal(f.calls.disposed, 1);
    assert.equal(f.data.size, 0);
    if (kind === 'backup') assert.equal(f.calls.closed, 1);
    else assert.equal(f.calls.drained, 1);
  });
  test(`${kind} account retirement during a write prevents import after the native write settles`, async () => {
    const f = fixture(kind),
      pending = f.start().then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    await f.started.promise;
    f.retire();
    f.gate.resolve();
    const result = await pending;
    assert.ok(result.error);
    assert.equal(f.calls.writeSettled, 1);
    assert.equal(f.calls.imported, 0);
    assert.equal(f.calls.deleted, 1);
    assert.equal(f.calls.disposed, 1);
    assert.equal(f.data.size, 0);
  });
}
