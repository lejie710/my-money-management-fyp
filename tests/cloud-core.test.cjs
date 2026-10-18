const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const model = require('../src/core/model'),
  format = require('../src/cloud/backupFormat'),
  { sha256Hex } = require('../src/cloud/hash'),
  { createCloudTransport } = require('../src/cloud/transport'),
  { validateCloudConfiguration } = require('../src/cloud/config');
const { encodeDataFamily } = require('../src/accounts/identity'),
  { encodeReminderOwner, decodeReminderOwner } = require('../src/reminders/store');
const clone = (value) => JSON.parse(JSON.stringify(value)),
  owner = { projectId: 'demo-money-backup', uid: 'synthetic-a' };
const id = 'backup-0123456789abcdef';
function ledger() {
  let value = model.createEmptyLedger({ name: 'Synthetic wallet' });
  return model.saveTransaction(
    value,
    model.transactionFromDraft(
      {
        type: 'expense',
        title: 'Lunch',
        amount: '12.50',
        date: '2026-10-18',
        categoryId: 'expense-food',
      },
      'expense-1',
      value,
    ),
  );
}
function snapshot(value = ledger(), photos = [], includePhotos = false) {
  return format.makeSnapshot({
    ledger: value,
    owner,
    id,
    createdAtMs: 1000,
    photos,
    includePhotos,
  });
}
function fixture() {
  const blobs = new Map(),
    indices = new Map(),
    events = [];
  let afterWrite = false;
  const sdk = {
    async getIndex(id) {
      return indices.get(id) || null;
    },
    async listIndices() {
      return [...indices.values()];
    },
    async createIndex(id, value) {
      events.push('index');
      indices.set(id, Object.fromEntries(Object.entries(value).reverse()));
      if (afterWrite) throw Error('uncertain-write');
    },
    async head(path) {
      const value = blobs.get(path);
      return value
        ? {
            size: value.bytes.length,
            contentType: value.meta.contentType,
            sha256: value.meta.sha256,
          }
        : null;
    },
    async put(path, bytes, meta) {
      events.push(path);
      blobs.set(path, { bytes: new Uint8Array(bytes), meta });
    },
    async get(path) {
      if (!blobs.has(path)) throw Error('missing');
      return new Uint8Array(blobs.get(path).bytes);
    },
    async remove(path) {
      blobs.delete(path);
    },
  };
  return {
    blobs,
    indices,
    events,
    sdk,
    transport: createCloudTransport({ owner, sdk }),
    setAfterWrite(value) {
      afterWrite = value;
    },
  };
}
test('SHA256 agrees with independent Node implementation for Unicode and bytes', () => {
  for (const value of ['', 'abc', '午餐 RM12.50', 'x'.repeat(200000)]) {
    const bytes = format.utf8(value);
    assert.equal(
      sha256Hex(bytes),
      crypto.createHash('sha256').update(Buffer.from(value)).digest('hex'),
    );
    assert.equal(format.decodeUtf8(bytes), value);
  }
});
test('hosted project identity never collides with old local/emulator tokens or another project', () => {
  const scope = { kind: 'canonical' },
    local = { scope, actor: { kind: 'local' } },
    emulator = { scope, actor: { kind: 'firebase', uid: 'same' } };
  assert.equal(encodeDataFamily(local), '["canonical",null,"local",null]');
  assert.equal(encodeDataFamily(emulator), '["canonical",null,"firebase","same"]');
  const hosted = (projectId) => ({
    scope,
    actor: { kind: 'firebase-hosted', projectId, uid: 'same' },
  });
  const tokens = [local, emulator, hosted('project-alpha'), hosted('project-bravo')].map((f) =>
    encodeReminderOwner({ ...f, incarnationId: 'wallet-one' }),
  );
  assert.equal(new Set(tokens).size, 4);
  for (const token of tokens) assert.equal(encodeReminderOwner(decodeReminderOwner(token)), token);
});
test('configuration is explicit and emulator mode cannot accidentally select a live project', () => {
  const firebase = {
    projectId: 'demo-money-backup',
    apiKey: 'demo-only-key',
    appId: 'demo-app',
    authDomain: 'demo-money-backup.firebaseapp.com',
    storageBucket: 'demo-money-backup.appspot.com',
  };
  assert.equal(
    validateCloudConfiguration({
      mode: 'emulator',
      firebase,
      emulators: { auth: 19099, firestore: 18080, storage: 19199 },
    }).mode,
    'emulator',
  );
  assert.throws(() =>
    validateCloudConfiguration({
      mode: 'emulator',
      firebase: { ...firebase, projectId: 'real-project' },
      emulators: { auth: 19099, firestore: 18080, storage: 19199 },
    }),
  );
  assert.throws(() =>
    validateCloudConfiguration({
      mode: 'hosted',
      firebase: { ...firebase, private_key: 'never-accepted' },
    }),
  );
});
test('portable snapshot preserves financial values, planning and metadata without mutating source', () => {
  const value = ledger(),
    before = JSON.stringify(value),
    saved = snapshot(value);
  assert.equal(JSON.stringify(value), before);
  assert.deepEqual(saved.ledger, value);
  assert.equal(model.totals(saved.ledger).balance, -1250);
  assert.equal(saved.owner.uid, owner.uid);
});
test('unsupported financial extension fields refuse export rather than leaking arbitrary data', () => {
  const value = { ...ledger(), privateExtension: 'not-published' };
  assert.throws(() => snapshot(value), /unsupported fields/);
  const nested = ledger();
  nested.transactions[0].privateKey = 'not-published';
  assert.throws(() => snapshot(nested), /unsupported fields/);
});
test('snapshot rejects wrong owner/project, extra fields, malformed records and mismatched photo sets', () => {
  const value = snapshot();
  assert.throws(() => format.validateSnapshot(value, { ...owner, uid: 'other' }));
  assert.throws(() => format.validateSnapshot(value, { ...owner, projectId: 'other-project' }));
  assert.throws(() => format.validateSnapshot({ ...value, extra: 'bad' }, owner));
  const bad = clone(value);
  bad.ledger.transactions[0].amountMinor = 1.5;
  assert.throws(() => format.validateSnapshot(bad, owner));
});
test('photo inclusion requires explicit complete manifests and removes local ownership paths', () => {
  const value = ledger(),
    bytes = fs.readFileSync(path.join(__dirname, 'fixtures/images/receipt-a.png')),
    hash = sha256Hex(bytes);
  const photo = {
    id: 'photo-synthetic',
    ownerIncarnationId: value.wallet.incarnationId,
    fileName: 'photo-synthetic.png',
    mimeType: 'image/png',
    width: 1100,
    height: 900,
    byteSize: bytes.length,
  };
  value.transactions[0].context = { notes: 'Receipt', photo, withPerson: null, location: null };
  const noPhoto = snapshot(value);
  assert.equal(noPhoto.ledger.transactions[0].context.photo, null);
  assert.throws(() => snapshot(value, [], true), /all be included/);
  const manifest = {
    sha256: hash,
    mimeType: 'image/png',
    width: 1100,
    height: 900,
    byteSize: bytes.length,
    transactionIds: ['expense-1'],
  };
  const full = snapshot(value, [manifest], true);
  assert.equal(full.photos.length, 1);
  assert.equal(JSON.stringify(full).includes('photo-synthetic.png'), false);
  const restoredPhoto = { ...photo, ownerIncarnationId: 'restored-wallet' };
  const restored = format.restoreLedger(full, owner, 'restored-wallet', { [hash]: restoredPhoto });
  assert.equal(restored.transactions[0].context.photo.ownerIncarnationId, 'restored-wallet');
  assert.equal(restored.achievements.ownerIncarnationId, 'restored-wallet');
});
test('existing historical wallets are not empty restore targets even after deleting records', () => {
  const empty = model.createEmptyLedger();
  assert.equal(format.isEmptyTarget(empty), true);
  assert.equal(
    format.isEmptyTarget({ ...empty, wallet: { ...empty.wallet, hasTransactionHistory: true } }),
    false,
  );
  assert.equal(format.isEmptyTarget(ledger()), false);
});
test('snapshot creation and restore preserve explicit synthetic fixture mode and milestone evidence', () => {
  const fixtures = require('../src/verification/fixtures');
  for (const scenario of ['health-goal', 'achievements-completion']) {
    const value = fixtures.createVerificationLedger('cloud-format-test', scenario),
      saved = snapshot(value),
      restored = format.restoreLedger(saved, owner, 'restored-wallet');
    assert.equal(restored.mode, value.mode);
    assert.equal(restored.wallet.trackingStartedOn, value.wallet.trackingStartedOn);
    assert.deepEqual(restored.achievements.awards, value.achievements.awards);
  }
});
test('upload publishes the immutable index last and a retry reconciles the same ID', async () => {
  const f = fixture(),
    value = snapshot();
  const first = await f.transport.backup(value, () => {
    throw Error('No photos expected');
  });
  assert.equal(f.events.at(-1), 'index');
  const count = f.events.length;
  const again = await f.transport.backup(value, () => {
    throw Error('No photos expected');
  });
  assert.deepEqual(first, again);
  assert.equal(f.events.length, count);
  assert.deepEqual(await f.transport.download(first), value);
});
test('write-then-error is reconciled by index readback on deliberate retry without duplicate upload', async () => {
  const f = fixture(),
    value = snapshot();
  f.setAfterWrite(true);
  await assert.rejects(f.transport.backup(value, async () => new Uint8Array()));
  const writes = f.events.length;
  f.setAfterWrite(false);
  await f.transport.backup(value, async () => new Uint8Array());
  assert.equal(f.indices.size, 1);
  assert.equal(f.events.length, writes);
});
test('foreign existing object and corrupted snapshot fail without overwrite or false restore', async () => {
  const f = fixture(),
    value = snapshot();
  const index = await f.transport.backup(value, async () => new Uint8Array());
  const key = [...f.blobs.keys()][0];
  f.blobs.get(key).bytes[0] = 0;
  await assert.rejects(f.transport.download(index), /integrity/);
  f.indices.clear();
  await assert.rejects(
    f.transport.backup(value, async () => new Uint8Array()),
    /integrity/,
  );
});
test('upload cancellation and missing snapshot never fabricate a completed backup', async () => {
  const f = fixture(),
    signal = new AbortController();
  signal.abort();
  await assert.rejects(
    f.transport.backup(snapshot(), async () => new Uint8Array(), { signal: signal.signal }),
  );
  assert.equal(f.events.length, 0);
  const index = await f.transport.backup(snapshot(), async () => new Uint8Array());
  f.blobs.clear();
  await assert.rejects(f.transport.download(index));
});

test('matching index never reconciles a pending backup when its immutable snapshot is missing or corrupted', async () => {
  for (const failure of ['missing', 'corrupt']) {
    const f = fixture(),
      value = snapshot();
    await f.transport.backup(value, async () => new Uint8Array());
    const key = [...f.blobs.keys()][0];
    if (failure === 'missing') f.blobs.delete(key);
    else f.blobs.get(key).bytes[0] = 0;
    await assert.rejects(f.transport.backup(value, async () => new Uint8Array()));
    assert.equal(f.events.filter((x) => x === 'index').length, 1);
  }
});

test('hosted mode refuses demo project identity instead of reusing emulator persistence as a cloud session', () => {
  assert.throws(
    () =>
      validateCloudConfiguration({
        mode: 'hosted',
        firebase: {
          projectId: 'demo-money-backup',
          apiKey: 'demo-only-key',
          appId: 'demo-app',
          authDomain: 'demo-money-backup.firebaseapp.com',
          storageBucket: 'demo-money-backup.appspot.com',
        },
      }),
    /reserved for emulator/,
  );
});
