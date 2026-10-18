const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadSource, owner } = require('./helpers/account-hook-harness.cjs');
const context = require('../src/core/transactionContext');
const { deferred, flush } = require('./helpers/native-adapter-vm.cjs');
const { createPhotoManager } = loadSource(path.join(__dirname, '../src/attachments/photoManager.js'), {
  '../core/transactionContext': context,
  '../reminders/store': owner,
});
let ordinal = 0;
const info = { mimeType: 'image/png', width: 20, height: 10, byteSize: 120 };
function fixture() {
  const id = ++ordinal,
    bytes = new Map(),
    files = new Map(),
    calls = [];
  const entered = deferred(),
    copy = deferred();
  let ids = 0;
  const config = {
    family: {
      scope: { kind: 'test', namespace: `photo-drain-${id}` },
      actor: { kind: 'firebase', uid: 'synthetic-A' },
    },
    files: {
      async inspectSource() {
        calls.push('source');
        return { ...info };
      },
      async copyIntoOwned(uri, photo) {
        calls.push('copy-start');
        entered.resolve();
        await copy.promise;
        files.set(photo.fileName, { ...info });
        calls.push('copy-end');
      },
      async inspectOwned(photo) {
        calls.push('inspect');
        return files.get(photo.fileName) ?? null;
      },
      uriFor(photo) {
        return `file:///owned/${photo.fileName}`;
      },
      async removeOwned(photo) {
        calls.push('remove');
        files.delete(photo.fileName);
      },
    },
    journal: {
      async getItem(key) {
        calls.push('read');
        return bytes.get(key) ?? null;
      },
      async setItem(key, value) {
        calls.push('write');
        bytes.set(key, value);
      },
    },
    ledgerStorage: {
      async withRetainedPhotoReferences(work) {
        calls.push('references');
        return work({ complete: true, references: [] });
      },
    },
    now: () => Date.UTC(2026, 9, 18),
    newId: (kind) => `${kind}-${id}-${++ids}`,
  };
  return { config, manager: createPhotoManager(config), entered, copy, calls, files };
}
test('real manager drain waits for in-flight copy and disposal cleanup without starting new IO itself', async () => {
  const f = fixture(),
    draft = f.manager.beginDraft('wallet-a');
  const stage = f.manager.stage(draft, { uri: 'content://synthetic/receipt' });
  const rejected = assert.rejects(stage, /canceled/);
  await f.entered.promise;
  f.manager.dispose();
  let finished = false;
  const drain = f.manager.drain();
  assert.equal(f.manager.drain(), drain);
  drain.then(() => {
    finished = true;
  });
  await flush();
  assert.equal(finished, false);
  assert.throws(() => f.manager.beginDraft('wallet-a'), /active wallet/);
  f.copy.resolve();
  await rejected;
  await drain;
  assert.equal(finished, true);
  assert.equal(f.files.size, 0);
  assert.ok(f.calls.indexOf('copy-end') < f.calls.indexOf('remove'));
  const after = [...f.calls];
  await f.manager.drain();
  await f.manager.drain();
  assert.deepEqual(f.calls, after);
});
test('a newly constructed same-family manager can drain an older binding without initialization or extra cleanup', async () => {
  const f = fixture(),
    draft = f.manager.beginDraft('wallet-a');
  const stage = f.manager.stage(draft, { uri: 'file:///synthetic/receipt.png' });
  const rejected = assert.rejects(stage, /canceled/);
  await f.entered.promise;
  f.manager.dispose();
  const before = [...f.calls],
    successor = createPhotoManager(f.config);
  const draining = successor.drain();
  assert.deepEqual(f.calls, before);
  assert.equal(draining, f.manager.drain());
  f.copy.resolve();
  await rejected;
  await draining;
  const settled = [...f.calls];
  await successor.drain();
  assert.deepEqual(f.calls, settled);
});
