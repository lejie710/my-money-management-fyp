const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = require('../src/core/model');
const { commitLedger } = require('../src/core/commitLedger');
const { createEverydayCloudStore } = require('../src/cloud/everydayStore');
const {
  everydayKeys,
  makeRecord,
  decodeRecord,
  ledgerPhotos,
  MAX_WALLET_BYTES,
} = require('../src/cloud/everydayFormat');
const { sha256Hex } = require('../src/cloud/hash');
const { photoKey } = require('../src/core/transactionContext');
const { inspectImageHeader } = require('../src/attachments/imageHeader');
const clock = { today: '2026-10-19', nowMs: Date.UTC(2026, 9, 19, 4) };
const family = {
  scope: { kind: 'test', namespace: 'everyday-cloud-test' },
  actor: { kind: 'firebase-hosted', projectId: 'demo-everyday-wallet', uid: 'owner-a' },
};
const owner = { projectId: family.actor.projectId, uid: family.actor.uid };
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
function ledger(id = 'first') {
  return model.createEmptyLedger({ name: 'Cloud wallet' }, { clock, newIncarnationId: () => id });
}
function expense(value, amount = '12.50', id = 'expense-one') {
  return model.saveTransaction(
    value,
    model.transactionFromDraft(
      { title: 'Coffee', type: 'expense', categoryId: 'expense-food', date: '2026-10-19', amount },
      id,
      value,
    ),
  );
}
let clientNumber = 0;
function fixture(options = {}) {
  const clientId = ++clientNumber;
  const data = options.data ?? new Map(),
    server = options.server ?? {
      record: null,
      receipts: new Map(),
      photos: new Map(),
      online: true,
      commits: 0,
      uploads: 0,
      reads: 0,
    };
  const selected = options.family ?? family,
    keys = everydayKeys(selected),
    faults = {
      readKey: null,
      dropKey: null,
      writeThenThrow: null,
      beforeCommit: null,
      afterCommit: null,
      upload: false,
    };
  let active = true,
    serial = 0;
  const localPhotos = options.localPhotos ?? new Map(),
    legacy = { value: options.legacy ?? null };
  const device = {
    async getItem(key) {
      if (faults.readKey === key) throw Error('private storage error');
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      if (faults.dropKey === key) throw Error('private storage error');
      data.set(key, value);
      if (faults.writeThenThrow === key) throw Error('write then throw');
    },
    async removeItem(key) {
      if (faults.dropKey === key) throw Error('private storage error');
      data.delete(key);
    },
  };
  const connected = () => {
    if (!server.online) throw Error('offline private endpoint');
  };
  const ports = {
    async readWallet() {
      server.reads++;
      connected();
      return clone(server.record);
    },
    async readOperation(_, id) {
      connected();
      return clone(server.receipts.get(id) ?? null);
    },
    async commitWallet(_, plan) {
      server.commits++;
      connected();
      if (faults.beforeCommit) await faults.beforeCommit(plan);
      const previous = server.receipts.get(plan.record.operationId);
      if (previous) return clone(server.record);
      if (
        (server.record?.revision ?? 0) !== plan.baseRevision ||
        (server.record?.payloadHash ?? null) !== plan.baseHash
      )
        throw Error('CAS conflict');
      server.record = clone(plan.record);
      server.receipts.set(plan.record.operationId, {
        version: 1,
        ownerUid: selected.actor.uid,
        operationId: plan.record.operationId,
        revision: plan.record.revision,
        payloadHash: plan.record.payloadHash,
      });
      if (faults.afterCommit) await faults.afterCommit(plan);
      return clone(server.record);
    },
    async headPhoto(_, hash) {
      connected();
      const value = server.photos.get(hash);
      return value ? { size: value.bytes.length, sha256: hash, contentType: value.mimeType } : null;
    },
    async putPhoto(_, hash, bytes, mimeType) {
      connected();
      if (faults.upload) throw Error('upload failed');
      server.uploads++;
      server.photos.set(hash, { bytes: new Uint8Array(bytes), mimeType });
    },
    async getPhoto(_, hash) {
      connected();
      const value = server.photos.get(hash);
      if (!value) throw Error('missing photo');
      return new Uint8Array(value.bytes);
    },
  };
  const files = {
    async read(_, photo) {
      const bytes = localPhotos.get(photoKey(photo));
      if (!bytes) throw Error('missing source photo');
      return new Uint8Array(bytes);
    },
    async hydrate(_, storage, photos, read, current) {
      for (const item of photos) {
        current();
        const bytes = await read(item);
        assert.equal(sha256Hex(bytes), item.sha256);
        localPhotos.set(photoKey(item.photo), bytes);
      }
    },
  };
  const store = createEverydayCloudStore({
    family: selected,
    deviceStorage: device,
    legacyStorage: {
      async readCurrent() {
        return clone(legacy.value);
      },
    },
    ports: () => ports,
    files: options.files ?? files,
    assertCurrent() {
      if (!active) throw Error('owner retired');
    },
    now: () => clock.nowMs,
    newId: () => options.fixedId ?? 'wallet-test-client-' + clientId + '-operation-' + ++serial,
  });
  return {
    store,
    data,
    server,
    keys,
    faults,
    localPhotos,
    legacy,
    device,
    ports,
    setActive(value) {
      active = value;
    },
    async initialize(initial = ledger()) {
      assert.equal(await store.load(), null);
      const result = await commitLedger({ current: initial, next: initial, storage: store });
      assert.equal(result.ok, true);
      return result.ledger;
    },
  };
}

test('configured account creates only an empty server wallet and preserves its older device wallet', async () => {
  const original = expense(ledger('legacy'), '30.00');
  const f = fixture({ legacy: original });
  assert.equal(await f.store.load(), null);
  assert.equal(f.server.commits, 0);
  const fresh = await f.initialize();
  assert.equal(fresh.transactions.length, 0);
  assert.equal(decodeRecord(f.server.record, owner).ledger.transactions.length, 0);
  assert.deepEqual(f.legacy.value, original);
  assert.equal(f.store.getSnapshot().revision, 1);
  assert.equal(f.store.isReadOnly(), false);
  assert.notEqual(
    f.keys.cache,
    require('../src/accounts/familyStorage').familyStorageKeys(family).key,
  );
});

test('ordinary save confirms complete validated financial state and a second device reads it', async () => {
  const f = fixture(),
    first = await f.initialize();
  let next = expense(first);
  next = model.createCategory(next, { id: 'custom-expense', name: 'Books', type: 'expense' });
  next = model.saveBudget(
    next,
    model.budgetFromDraft(
      { categoryId: 'expense-food', amount: '200', period: 'month', anchorDate: '2026-10-19' },
      'budget-food',
      next,
    ),
  );
  next = model.saveGoal(
    next,
    model.goalFromDraft({ kind: 'emergencyFund', amount: '5000' }, 'goal-one', next),
  );
  const result = await commitLedger({ current: first, next, storage: f.store });
  assert.equal(result.ok, true);
  assert.deepEqual(decodeRecord(f.server.record, owner).ledger, next);
  assert.equal(f.server.record.revision, 2);
  assert.equal(f.server.receipts.size, 2);
  const second = fixture({ server: f.server });
  assert.deepEqual(await second.store.load(), next);
  assert.equal(second.server.commits, 2);
});

test('server revision conflict retains the stale draft without overwriting another device', async () => {
  const a = fixture(),
    first = await a.initialize(),
    b = fixture({ server: a.server });
  assert.deepEqual(await b.store.load(), first);
  const winner = expense(first, '15.00', 'from-a'),
    loser = expense(first, '25.00', 'from-b');
  assert.equal((await commitLedger({ current: first, next: winner, storage: a.store })).ok, true);
  const outcome = await commitLedger({ current: first, next: loser, storage: b.store });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.blocked, false);
  assert.deepEqual(outcome.ledger, winner);
  assert.deepEqual(decodeRecord(a.server.record, owner).ledger, winner);
  assert.equal(b.store.getSnapshot().draft.phase, 'conflict');
  assert.deepEqual((await b.store.readDraft()).ledger, loser);
  assert.equal(a.server.commits, 2);
});

test('fresh process offline reads only confirmed cache and keeps an explicit failed-save draft for retry', async () => {
  const a = fixture(),
    first = await a.initialize();
  a.server.online = false;
  const b = fixture({ data: a.data, server: a.server });
  assert.deepEqual(await b.store.load(), first);
  assert.equal(b.store.getSnapshot().status, 'offline');
  assert.equal(b.store.isReadOnly(), true);
  const candidate = expense(first);
  const result = await commitLedger({ current: first, next: candidate, storage: b.store });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.ledger, first);
  assert.equal(a.server.commits, 1);
  const pending = await b.store.readDraft();
  assert.equal(pending.phase, 'draft');
  assert.deepEqual(pending.ledger, candidate);
  const c = fixture({ data: a.data, server: a.server });
  assert.deepEqual(await c.store.load(), first);
  assert.equal((await c.store.readDraft()).operationId, pending.operationId);
  a.server.online = true;
  assert.deepEqual(await c.store.retryDraft(pending.operationId), candidate);
  assert.equal(await c.store.readDraft(), null);
  assert.equal(a.server.record.operationId, pending.operationId);
});

test('acknowledgement loss is confirmed from server operation receipt, never a candidate cache', async () => {
  const f = fixture(),
    first = await f.initialize(),
    next = expense(first);
  f.faults.afterCommit = async () => {
    throw Error('reply lost');
  };
  const result = await commitLedger({ current: first, next, storage: f.store });
  assert.equal(result.ok, true);
  assert.equal(result.blocked, false);
  assert.equal(f.server.commits, 2);
  assert.equal(await f.store.readDraft(), null);
  assert.deepEqual(await f.store.readCurrent(), next);
});

test('unconfirmed dispatched save remains blocked across restart and retries the same operation only', async () => {
  const f = fixture(),
    first = await f.initialize(),
    next = expense(first);
  f.faults.beforeCommit = async () => {
    throw Error('transport ended before known outcome');
  };
  const result = await commitLedger({ current: first, next, storage: f.store });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  const draft = await f.store.readDraft();
  assert.equal(draft.phase, 'submitted');
  await assert.rejects(f.store.discardDraft(draft.operationId));
  const restarted = fixture({ data: f.data, server: f.server });
  await assert.rejects(restarted.store.load(), /unconfirmed/i);
  assert.equal((await restarted.store.readDraft()).operationId, draft.operationId);
  assert.deepEqual(await restarted.store.retryDraft(draft.operationId), next);
  assert.equal(f.server.record.operationId, draft.operationId);
  assert.equal(f.server.receipts.size, 2);
});

test('offline readback cannot claim a rejected submitted write was saved from local data', async () => {
  const f = fixture(),
    first = await f.initialize(),
    next = expense(first);
  f.faults.afterCommit = async () => {
    f.server.online = false;
    throw Error('server reply lost');
  };
  const result = await commitLedger({ current: first, next, storage: f.store });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.ledger, first);
  assert.equal((await f.store.readDraft()).phase, 'submitted');
  await assert.rejects(f.store.readCurrent());
  f.server.online = true;
  assert.deepEqual(await f.store.refresh(), next);
  assert.equal(await f.store.readDraft(), null);
});

test('unreadable or malformed durable draft blocks a new save before dispatch', async () => {
  for (const malformed of [false, true]) {
    const f = fixture(),
      first = await f.initialize(),
      next = expense(first);
    if (malformed) f.data.set(f.keys.draft, '{"private malformed');
    else f.faults.readKey = f.keys.draft;
    await assert.rejects(f.store.saveWithExpected(first, next));
    assert.equal(f.server.commits, 1);
    if (malformed) assert.equal(f.data.get(f.keys.draft), '{"private malformed');
    assert.equal(f.store.getSnapshot().message.includes('private malformed'), false);
  }
});

test('unconfirmed journal persistence prevents uploads and financial dispatch', async () => {
  const f = fixture(),
    first = await f.initialize();
  f.faults.dropKey = f.keys.draft;
  await assert.rejects(f.store.saveWithExpected(first, expense(first)));
  assert.equal(f.server.commits, 1);
  assert.equal(f.server.uploads, 0);
  assert.deepEqual(decodeRecord(f.server.record, owner).ledger, first);
});

test('a retained server commit recovers after a local confirmed-cache write failure', async () => {
  const f = fixture(),
    first = await f.initialize(),
    next = expense(first);
  f.faults.dropKey = f.keys.cache;
  await assert.rejects(f.store.saveWithExpected(first, next));
  assert.equal((await f.store.readDraft()).phase, 'submitted');
  f.faults.dropKey = null;
  assert.deepEqual(await f.store.refresh(), next);
  assert.equal(await f.store.readDraft(), null);
  assert.equal(f.server.commits, 2);
});

test('exact expected ledger and old draft guards reject stale or replacement saves', async () => {
  const f = fixture(),
    first = await f.initialize(),
    next = expense(first);
  await f.store.saveWithExpected(first, next);
  await assert.rejects(f.store.saveWithExpected(first, expense(first, '99.00')), /changed/i);
  f.server.online = false;
  await assert.rejects(f.store.saveWithExpected(next, expense(next, '2.00', 'two')));
  const retained = await f.store.readDraft();
  await assert.rejects(
    f.store.saveWithExpected(next, expense(next, '3.00', 'three')),
    /existing cloud draft/i,
  );
  assert.equal((await f.store.readDraft()).operationId, retained.operationId);
  assert.equal(f.server.commits, 2);
});

test('per-project, per-user and per-test-scope cache keys cannot expose another family', async () => {
  const alternate = { ...family, actor: { ...family.actor, projectId: 'demo-other-project' } };
  const variants = [
    alternate,
    { ...family, actor: { ...family.actor, uid: 'owner-b' } },
    { ...family, scope: { kind: 'test', namespace: 'other-test' } },
  ];
  for (const value of variants)
    assert.notEqual(everydayKeys(value).cache, everydayKeys(family).cache);
  const f = fixture(),
    first = await f.initialize();
  const other = fixture({ family: alternate, data: f.data });
  assert.equal(await other.store.load(), null);
  other.data.set(other.keys.cache, f.data.get(f.keys.cache));
  await assert.rejects(other.store.load(), /recovery/i);
  assert.deepEqual(decodeRecord(f.server.record, owner).ledger, first);
});

test('retired owner cannot dispatch or publish its cloud save as current', async () => {
  const f = fixture(),
    first = await f.initialize();
  f.setActive(false);
  await assert.rejects(f.store.saveWithExpected(first, expense(first)));
  assert.equal(f.server.commits, 1);
  assert.equal(f.data.has(f.keys.draft), false);
});

test('attached photo is uploaded before commit and hydrates with the same bytes on another device', async () => {
  const f = fixture(),
    first = await f.initialize(),
    bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/images/receipt-a.png')));
  const photo = {
    id: 'photo-cloud-one',
    ownerIncarnationId: first.wallet.incarnationId,
    fileName: 'photo-cloud-one.png',
    ...inspectImageHeader(bytes),
  };
  let next = expense(first);
  next.transactions[0] = model.patchTransactionContext(
    next.transactions[0],
    { photo, notes: 'Fictional receipt.' },
    next,
  );
  model.validateLedger(next);
  f.localPhotos.set(photoKey(photo), bytes);
  await f.store.saveWithExpected(first, next);
  assert.equal(f.server.uploads, 1);
  const hash = sha256Hex(bytes);
  assert.ok(f.server.photos.has(hash));
  const record = decodeRecord(f.server.record, owner);
  assert.equal(record.photos[0].sha256, hash);
  assert.equal(record.record.payload.includes('file://'), false);
  const b = fixture({ server: f.server });
  assert.deepEqual(await b.store.load(), next);
  assert.equal(sha256Hex(b.localPhotos.get(photoKey(photo))), hash);
});

test('failed photo upload retains candidate and all legacy/draft photo references without a finance commit', async () => {
  const f = fixture(),
    first = await f.initialize(),
    bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/images/receipt-a.png')));
  const photo = {
    id: 'photo-cloud-two',
    ownerIncarnationId: first.wallet.incarnationId,
    fileName: 'photo-cloud-two.png',
    ...inspectImageHeader(bytes),
  };
  let next = expense(first);
  next.transactions[0] = model.patchTransactionContext(next.transactions[0], { photo }, next);
  f.localPhotos.set(photoKey(photo), bytes);
  f.faults.upload = true;
  await assert.rejects(f.store.saveWithExpected(first, next));
  assert.equal(f.server.commits, 1);
  const refs = await f.store.withRetainedPhotoReferences(async (value) => value);
  assert.equal(refs.complete, true);
  assert.ok(refs.references.some((value) => photoKey(value) === photoKey(photo)));
  assert.deepEqual((await f.store.readDraft()).ledger, next);
});

test('cloud records reject extra private fields, foreign owners, bad hashes and oversized payloads', () => {
  const original = ledger(),
    record = makeRecord({
      ledger: original,
      photos: [],
      owner,
      revision: 1,
      id: 'wallet-format-operation-0001',
      nowMs: clock.nowMs,
    });
  assert.throws(() => decodeRecord({ ...record, ownerUid: 'another' }, owner));
  assert.throws(() => decodeRecord({ ...record, payloadHash: 'a'.repeat(64) }, owner));
  assert.throws(() =>
    makeRecord({
      ledger: { ...original, privateToken: 'never upload' },
      photos: [],
      owner,
      revision: 1,
      id: 'wallet-format-operation-0001',
      nowMs: clock.nowMs,
    }),
  );
  assert.throws(() =>
    decodeRecord(
      {
        ...record,
        payload: ' '.repeat(MAX_WALLET_BYTES + 1),
        payloadHash: sha256Hex(new Uint8Array(MAX_WALLET_BYTES + 1).fill(32)),
      },
      owner,
    ),
  );
  assert.equal(ledgerPhotos(original).length, 0);
});

test('confirmed write-then-throw device journal outcome remains usable through exact readback', async () => {
  const f = fixture(),
    first = await f.initialize(),
    next = expense(first);
  f.faults.writeThenThrow = f.keys.draft;
  assert.deepEqual(await f.store.saveWithExpected(first, next), next);
  assert.equal(f.server.commits, 2);
  assert.equal(await f.store.readDraft(), null);
});

test('an accidental operation-ID collision cannot overwrite an unrelated confirmed receipt', async () => {
  const f = fixture(),
    first = await f.initialize();
  const previousId = f.server.record.operationId;
  const other = fixture({ data: f.data, server: f.server, fixedId: previousId });
  await other.store.load();
  await assert.rejects(other.store.saveWithExpected(first, expense(first)), /receipt/i);
  assert.equal(f.server.commits, 1);
  assert.deepEqual(decodeRecord(f.server.record, owner).ledger, first);
  assert.equal((await other.store.readDraft()).phase, 'draft');
});

test('retained-photo callback is invoked exactly once and callback failures are not reclassified as an ownership read', async () => {
  const f = fixture();
  await f.initialize();
  let calls = 0;
  await assert.rejects(
    f.store.withRetainedPhotoReferences(() => {
      calls++;
      throw Error('caller work failed');
    }),
    /caller work failed/,
  );
  assert.equal(calls, 1);
  f.faults.readKey = f.keys.draft;
  const snapshot = await f.store.withRetainedPhotoReferences((value) => {
    calls++;
    return value;
  });
  assert.equal(snapshot.complete, false);
  assert.equal(calls, 2);
});

test('owner retirement during photo hydration rejects the old owner ledger instead of reporting missing photos', async () => {
  const f = fixture(),
    first = await f.initialize(),
    bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/images/receipt-a.png')));
  const photo = {
    id: 'photo-retirement',
    ownerIncarnationId: first.wallet.incarnationId,
    fileName: 'photo-retirement.png',
    ...inspectImageHeader(bytes),
  };
  const next = expense(first);
  next.transactions[0] = model.patchTransactionContext(next.transactions[0], { photo }, next);
  f.localPhotos.set(photoKey(photo), bytes);
  await f.store.saveWithExpected(first, next);
  let second;
  second = fixture({
    server: f.server,
    files: {
      async hydrate() {
        second.setActive(false);
        throw Error('Owner retired after photo await');
      },
    },
  });
  await assert.rejects(second.store.load(), /owner retired/i);
  assert.equal(second.store.getSnapshot().photosPending, 0);
});
