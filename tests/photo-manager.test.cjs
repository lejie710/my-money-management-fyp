const test = require('node:test'),
  assert = require('node:assert/strict');
const m = require('../src/core/model'),
  c = require('../src/core/transactionContext'),
  s = require('../src/core/storage');
const { createPhotoManager, photoFamilyToken } = require('../src/attachments/photoManager');
const clock = { today: '2026-10-18', nowMs: Date.parse('2026-10-18T12:00:00Z') };
let number = 0;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const inspection = { mimeType: 'image/png', width: 100, height: 50, byteSize: 500 };
function setup(options = {}) {
  const ns = `photo-test-${++number}`,
    family = options.family ?? { scope: { kind: 'test', namespace: ns }, actor: { kind: 'local' } };
  const familyToken = photoFamilyToken(family),
    data = options.data ?? new Map(),
    fileData = options.fileData ?? new Map(),
    calls = [],
    reads = [],
    writes = [];
  const key = options.key ?? `@tests/${ns}/v5`,
    legacyKey = options.legacyKey;
  const ledger = m.createEmptyLedger(
    {},
    { clock, newIncarnationId: () => options.owner ?? 'wallet-photo' },
  );
  if (!data.has(key)) data.set(key, JSON.stringify(ledger));
  const journal = {
    async getItem(name) {
      reads.push(name);
      return data.get(name) ?? null;
    },
    async setItem(name, bytes) {
      writes.push(name);
      data.set(name, bytes);
    },
  };
  const store = s.createLedgerStorage(journal, { key, legacyKeys: legacyKey ? [legacyKey] : [] });
  const fileKey = (photo) => `${familyToken}/${c.photoKey(photo)}`;
  const files = {
    async inspectSource(uri) {
      calls.push(['inspect-source', uri]);
      return { ...inspection };
    },
    async copyIntoOwned(uri, photo) {
      calls.push(['copy', uri, c.photoKey(photo)]);
      fileData.set(fileKey(photo), { ...inspection });
    },
    async inspectOwned(photo) {
      calls.push(['inspect-owned', c.photoKey(photo)]);
      return fileData.get(fileKey(photo)) ?? null;
    },
    uriFor(photo) {
      return `file:///owned/${encodeURIComponent(familyToken)}/${photo.ownerIncarnationId}/${photo.fileName}`;
    },
    async removeOwned(photo) {
      calls.push(['remove', c.photoKey(photo)]);
      fileData.delete(fileKey(photo));
    },
  };
  let ids = 0;
  const config = {
    family,
    files,
    journal,
    ledgerStorage: store,
    now: () => clock.nowMs,
    newId: (kind) => `${kind}-${++ids}`,
  };
  const manager = createPhotoManager(config);
  return {
    family,
    familyToken,
    data,
    fileData,
    fileKey,
    calls,
    reads,
    writes,
    key,
    ledger,
    journal,
    store,
    files,
    config,
    manager,
  };
}
function withPhoto(ledger, photo, id = 'expense') {
  const tx = m.transactionFromDraft(
    {
      title: 'Photo transaction',
      type: 'expense',
      date: '2026-10-17',
      amount: '10',
      categoryId: 'expense-food',
    },
    id,
    ledger,
  );
  return m.saveTransaction(
    ledger,
    m.patchTransactionContext(tx, { photo }, ledger),
    ledger.transactions.some((item) => item.id === id),
  );
}
async function stage(f, uri = 'file:///picker/source.png') {
  const draft = f.manager.beginDraft(f.ledger.wallet.incarnationId);
  const photo = await f.manager.stage(draft, { uri });
  return { draft, photo };
}

test('manager construction and draft creation perform no IO; stage copies only after durable intent and validates its target', async () => {
  const f = setup();
  assert.equal(f.calls.length, 0);
  assert.equal(f.reads.length, 0);
  assert.equal(f.writes.length, 0);
  const draft = f.manager.beginDraft('wallet-photo');
  assert.equal(f.writes.length, 0);
  const original = f.files.copyIntoOwned;
  f.files.copyIntoOwned = async (uri, photo) => {
    const envelope = JSON.parse(f.data.get(f.manager.journalKey));
    assert.equal(envelope.entries[0].phase, 'copying');
    assert.deepEqual(envelope.entries[0].photo, photo);
    await original(uri, photo);
  };
  const photo = await f.manager.stage(draft, { uri: 'content://picker/synthetic' });
  assert.ok(Object.isFrozen(photo));
  assert.equal(photo.ownerIncarnationId, 'wallet-photo');
  assert.equal(photo.byteSize, 500);
  assert.equal(JSON.parse(f.data.get(f.manager.journalKey)).entries[0].phase, 'ready');
  assert.equal((await f.manager.retryCleanup()).retained, 1);
  assert.equal(f.fileData.size, 1);
  assert.equal(
    f.calls.some((call) => call[0] === 'remove'),
    false,
  );
  await f.manager.closeDraft(draft);
  assert.equal(f.fileData.size, 0);
});

test('confirmed financial save protects its staged photo on close, retry and manager restart', async () => {
  const f = setup(),
    { draft, photo } = await stage(f);
  const saved = await f.store.save(withPhoto(f.ledger, photo));
  const result = await f.manager.closeDraft(draft);
  assert.equal(result.pending, false);
  assert.equal(result.retained, 1);
  assert.equal(f.fileData.size, 1);
  assert.deepEqual(await f.store.readCurrent(), saved);
  assert.equal((await f.manager.retryCleanup()).retained, 1);
  f.manager.dispose();
  const next = createPhotoManager(f.config);
  assert.equal((await next.initialize()).retained, 1);
  assert.equal(f.fileData.size, 1);
  next.dispose();
});

test('cancelled draft removes only its new owned copy and never its picker source or committed old image', async () => {
  const f = setup(),
    first = await stage(f);
  await f.store.save(withPhoto(f.ledger, first.photo));
  await f.manager.closeDraft(first.draft);
  const second = await stage(f, 'file:///picker/second.png');
  await f.manager.closeDraft(second.draft);
  assert.equal(f.fileData.has(f.fileKey(first.photo)), true);
  assert.equal(f.fileData.has(f.fileKey(second.photo)), false);
  assert.deepEqual(
    f.calls.filter((call) => call[0] === 'remove').map((call) => call[1]),
    [c.photoKey(second.photo)],
  );
});

test('replacement commits before old cleanup; transaction deletion never resurrects financial state', async () => {
  const f = setup(),
    first = await stage(f);
  let saved = await f.store.save(withPhoto(f.ledger, first.photo));
  await f.manager.closeDraft(first.draft);
  const second = await stage(f);
  saved = await f.store.save(withPhoto(saved, second.photo));
  await f.manager.closeDraft(second.draft);
  await f.manager.queueCleanup([first.photo]);
  assert.equal(f.fileData.has(f.fileKey(first.photo)), false);
  assert.equal(f.fileData.has(f.fileKey(second.photo)), true);
  await f.store.save(m.deleteTransaction(saved, 'expense'));
  const bytes = f.data.get(f.key);
  await f.manager.queueCleanup([second.photo]);
  assert.equal(f.fileData.size, 0);
  assert.equal(f.data.get(f.key), bytes);
});

test('retained v4 or v5 references protect removed current photos and old-wallet photos after reset', async () => {
  for (const version of [4, 5]) {
    const f = setup({ legacyKey: `@tests/retained-photo-${version}` }),
      { draft, photo } = await stage(f);
    const saved = await f.store.save(withPhoto(f.ledger, photo));
    f.data.set(f.config.ledgerStorage.key.replace('/v5', '/unused'), 'unread unrelated metadata');
    f.data.set(`@tests/retained-photo-${version}`, JSON.stringify({ ...saved, version }));
    await f.manager.closeDraft(draft);
    const reset = m.createEmptyLedger({}, { clock, newIncarnationId: () => 'new-wallet' });
    await f.store.save(reset);
    const result = await f.manager.queueCleanup([photo]);
    assert.equal(result.retained, 1);
    assert.equal(result.pending, false);
    assert.equal(f.fileData.size, 1);
    assert.equal((await f.store.readCurrent()).wallet.incarnationId, 'new-wallet');
  }
});

test('unreadable retained data or missing active ledger retains files until a complete reference scan is possible', async () => {
  const oldKey = '@tests/uncertain-prior',
    f = setup({ legacyKey: oldKey }),
    { draft, photo } = await stage(f);
  f.data.set(oldKey, 'broken');
  assert.equal((await f.manager.closeDraft(draft)).pending, true);
  assert.equal(f.fileData.size, 1);
  f.data.delete(oldKey);
  const active = f.data.get(f.key);
  f.data.delete(f.key);
  assert.equal((await f.manager.retryCleanup()).pending, true);
  assert.equal(f.fileData.size, 1);
  f.data.set(f.key, active);
  assert.equal((await f.manager.retryCleanup()).pending, false);
  assert.equal(f.fileData.size, 0);
});

test('before-effect and after-effect copy failures clean only the owned partial target and preserve finances', async () => {
  for (const after of [false, true]) {
    const f = setup(),
      before = f.data.get(f.key),
      normal = f.files.copyIntoOwned;
    f.files.copyIntoOwned = async (uri, photo) => {
      if (after) await normal(uri, photo);
      throw Error('copy failed');
    };
    const draft = f.manager.beginDraft('wallet-photo');
    await assert.rejects(
      () => f.manager.stage(draft, { uri: 'file:///picker/image.png' }),
      /could not be copied/,
    );
    assert.equal(f.fileData.size, 0);
    assert.equal(f.data.get(f.key), before);
    assert.equal(JSON.parse(f.data.get(f.manager.journalKey)).entries.length, 0);
    await f.manager.closeDraft(draft);
  }
});

test('copy inspection mismatch or unsupported selected asset never returns a committable reference', async () => {
  const f = setup(),
    normal = f.files.copyIntoOwned;
  f.files.copyIntoOwned = async (uri, photo) => {
    await normal(uri, photo);
    f.fileData.set(f.fileKey(photo), { ...inspection, byteSize: 501 });
  };
  const draft = f.manager.beginDraft('wallet-photo');
  await assert.rejects(
    () => f.manager.stage(draft, { uri: 'file:///picker/image.png' }),
    /verified/,
  );
  assert.equal(f.fileData.size, 0);
  const other = setup();
  other.files.inspectSource = async () => ({ ...inspection, mimeType: 'image/heic' });
  await assert.rejects(
    () =>
      other.manager.stage(other.manager.beginDraft('wallet-photo'), { uri: 'file:///image.heic' }),
    /supported/,
  );
  assert.equal(
    other.calls.some((call) => call[0] === 'copy'),
    false,
  );
  await assert.rejects(
    () =>
      other.manager.stage(other.manager.beginDraft('wallet-photo'), {
        uri: 'https://example.invalid/image.png',
      }),
    /local image/,
  );
});

test('journal failure before copy has no file effect and write-then-throw intent is adopted exactly once', async () => {
  const f = setup();
  await f.manager.initialize();
  const normal = f.journal.setItem;
  f.journal.setItem = async (key, value) => {
    if (key === f.manager.journalKey) throw Error('before');
    return normal(key, value);
  };
  await assert.rejects(
    () =>
      f.manager.stage(f.manager.beginDraft('wallet-photo'), { uri: 'file:///picker/image.png' }),
    /metadata/,
  );
  assert.equal(
    f.calls.some((call) => call[0] === 'copy'),
    false,
  );
  f.journal.setItem = async (key, value) => {
    await normal(key, value);
    if (key === f.manager.journalKey) throw Error('after');
  };
  const { draft, photo } = await stage(f);
  assert.equal(f.calls.filter((call) => call[0] === 'copy').length, 1);
  assert.equal(f.fileData.has(f.fileKey(photo)), true);
  await f.manager.closeDraft(draft);
});

test('journal write with unconfirmable outcome blocks effects, retains bytes and recovers on restart', async () => {
  const f = setup();
  await f.manager.initialize();
  const normalWrite = f.journal.setItem,
    normalRead = f.journal.getItem;
  let uncertain = false;
  f.journal.setItem = async (key, value) => {
    await normalWrite(key, value);
    if (key === f.manager.journalKey) {
      uncertain = true;
      throw Error('write response lost');
    }
  };
  f.journal.getItem = async (key) => {
    if (uncertain && key === f.manager.journalKey) throw Error('read unavailable');
    return normalRead(key);
  };
  await assert.rejects(
    () =>
      f.manager.stage(f.manager.beginDraft('wallet-photo'), { uri: 'file:///picker/image.png' }),
    /could not be confirmed/,
  );
  assert.equal(
    f.calls.some((call) => call[0] === 'copy'),
    false,
  );
  f.journal.setItem = normalWrite;
  f.journal.getItem = normalRead;
  f.manager.dispose();
  const restarted = createPhotoManager(f.config);
  assert.equal((await restarted.initialize()).pending, false);
  assert.equal(f.fileData.size, 0);
  assert.equal(JSON.parse(f.data.get(f.manager.journalKey)).entries.length, 0);
  restarted.dispose();
});

test('definite failed financial save leaves stage pinned for retry; uncertain saved bytes protect it on cancel', async () => {
  const f = setup(),
    { draft, photo } = await stage(f),
    normal = f.journal.setItem;
  f.journal.setItem = async (key, value) => {
    if (key === f.key) throw Error('financial before');
    return normal(key, value);
  };
  await assert.rejects(() => f.store.save(withPhoto(f.ledger, photo)));
  assert.equal((await f.manager.retryCleanup()).retained, 1);
  assert.equal(f.fileData.size, 1);
  f.journal.setItem = async (key, value) => {
    await normal(key, value);
    if (key === f.key) throw Error('financial after');
  };
  await assert.rejects(() => f.store.save(withPhoto(f.ledger, photo)));
  f.journal.setItem = normal;
  await f.manager.closeDraft(draft);
  assert.equal(f.fileData.size, 1);
  assert.equal((await f.store.readCurrent()).transactions[0].context.photo.id, photo.id);
});

test('cancel during delayed native copy invalidates its return and waits before owned cleanup', async () => {
  const f = setup(),
    entered = deferred(),
    release = deferred(),
    normal = f.files.copyIntoOwned;
  f.files.copyIntoOwned = async (uri, photo) => {
    entered.resolve();
    await release.promise;
    await normal(uri, photo);
  };
  const draft = f.manager.beginDraft('wallet-photo'),
    pending = f.manager.stage(draft, { uri: 'file:///picker/image.png' });
  const rejected = assert.rejects(() => pending, /canceled/);
  await entered.promise;
  const closing = f.manager.closeDraft(draft);
  assert.equal(
    f.calls.some((call) => call[0] === 'remove'),
    false,
  );
  release.resolve();
  await rejected;
  assert.equal((await closing).pending, false);
  assert.equal(f.fileData.size, 0);
});

test('dispose and same-family replacement drain an old copy before cleanup and cannot return stale results', async () => {
  const f = setup(),
    entered = deferred(),
    release = deferred(),
    normal = f.files.copyIntoOwned;
  f.files.copyIntoOwned = async (uri, photo) => {
    entered.resolve();
    await release.promise;
    await normal(uri, photo);
  };
  const draft = f.manager.beginDraft('wallet-photo'),
    pending = f.manager.stage(draft, { uri: 'file:///picker/image.png' }),
    rejected = assert.rejects(() => pending, /canceled/);
  await entered.promise;
  f.manager.dispose();
  const replacement = createPhotoManager(f.config),
    initializing = replacement.initialize();
  assert.equal(
    f.calls.some((call) => call[0] === 'remove'),
    false,
  );
  release.resolve();
  await rejected;
  assert.equal((await initializing).pending, false);
  assert.equal(f.fileData.size, 0);
  replacement.dispose();
});

test('a live draft pin is shared across same-family bindings and foreign/forged handles are rejected', async () => {
  const f = setup(),
    { draft, photo } = await stage(f),
    other = createPhotoManager(f.config);
  assert.equal((await other.initialize()).retained, 1);
  assert.equal(f.fileData.size, 1);
  await assert.rejects(
    () => other.stage(draft, { uri: 'file:///picker/other.png' }),
    /no longer active/,
  );
  await assert.rejects(
    () => f.manager.stage({ ...draft }, { uri: 'file:///picker/other.png' }),
    /no longer active/,
  );
  await f.manager.closeDraft(draft);
  assert.equal(f.fileData.has(f.fileKey(photo)), false);
  assert.equal((await f.manager.closeDraft(draft)).pending, false);
  other.dispose();
});

test('deletion failure remains pending and a delete-then-throw is verified by target absence', async () => {
  const f = setup(),
    { draft, photo } = await stage(f),
    normal = f.files.removeOwned;
  f.files.removeOwned = async () => {
    throw Error('before');
  };
  const pending = await f.manager.closeDraft(draft);
  assert.equal(pending.pending, true);
  assert.equal(f.fileData.size, 1);
  f.files.removeOwned = async (ref) => {
    await normal(ref);
    throw Error('after');
  };
  assert.equal((await f.manager.retryCleanup()).pending, false);
  assert.equal(f.fileData.has(f.fileKey(photo)), false);
  assert.equal(JSON.parse(f.data.get(f.manager.journalKey)).entries.length, 0);
});

test('failed cleanup metadata persistence retains recoverable intent and never changes saved transactions', async () => {
  const f = setup(),
    { draft } = await stage(f),
    normal = f.journal.setItem,
    financial = f.data.get(f.key);
  let failed = false;
  f.journal.setItem = async (key, bytes) => {
    const envelope = JSON.parse(bytes);
    if (key === f.manager.journalKey && envelope.entries.length === 0 && !failed) {
      failed = true;
      throw Error('final delete metadata failure');
    }
    return normal(key, bytes);
  };
  assert.equal((await f.manager.closeDraft(draft)).pending, true);
  assert.equal(f.fileData.size, 0);
  assert.equal(JSON.parse(f.data.get(f.manager.journalKey)).entries.length, 1);
  assert.equal(f.data.get(f.key), financial);
  assert.equal((await f.manager.retryCleanup()).pending, false);
  assert.equal(JSON.parse(f.data.get(f.manager.journalKey)).entries.length, 0);
});

test('missing and corrupt journal differ; corruption blocks destructive cleanup while an existing photo remains viewable', async () => {
  const f = setup(),
    { draft, photo } = await stage(f);
  await f.store.save(withPhoto(f.ledger, photo));
  await f.manager.closeDraft(draft);
  f.data.set(f.manager.journalKey, 'broken');
  const restarted = createPhotoManager(f.config),
    callsBefore = f.calls.length;
  assert.equal((await restarted.initialize()).pending, true);
  assert.equal((await restarted.retryCleanup()).pending, true);
  assert.equal(f.data.get(f.manager.journalKey), 'broken');
  assert.equal(
    f.calls.slice(callsBefore).some((call) => call[0] === 'remove'),
    false,
  );
  assert.deepEqual(await restarted.inspect(photo), inspection);
  assert.match(restarted.uriFor(photo), /^file:\/\/\/owned\//);
  restarted.dispose();
});

test('cleanup refuses unjournaled targets and separate tagged scope/account families never delete each other', async () => {
  const canonical = setup({ family: { scope: { kind: 'canonical' }, actor: { kind: 'local' } } }),
    a = await stage(canonical);
  await canonical.store.save(withPhoto(canonical.ledger, a.photo));
  await canonical.manager.closeDraft(a.draft);
  const isolated = setup({
    family: {
      scope: { kind: 'test', namespace: 'canonical' },
      actor: { kind: 'firebase', uid: 'local' },
    },
    fileData: canonical.fileData,
  });
  const result = await isolated.manager.queueCleanup([a.photo]);
  assert.equal(result.pending, false);
  assert.equal(canonical.fileData.has(canonical.fileKey(a.photo)), true);
  assert.equal(
    isolated.calls.some((call) => call[0] === 'remove'),
    false,
  );
  assert.notEqual(canonical.manager.journalKey, isolated.manager.journalKey);
  assert.notEqual(canonical.familyToken, isolated.familyToken);
});

test('closeDraft cleanup and duplicate root/UI cleanup are idempotent after a confirmed replacement', async () => {
  const f = setup(),
    first = await stage(f);
  let saved = await f.store.save(withPhoto(f.ledger, first.photo));
  await f.manager.closeDraft(first.draft);
  const second = await stage(f);
  saved = await f.store.save(withPhoto(saved, second.photo));
  const results = await Promise.all([
    f.manager.closeDraft(second.draft),
    f.manager.queueCleanup([first.photo]),
    f.manager.queueCleanup([first.photo]),
  ]);
  assert.ok(results.every((result) => !result.pending));
  assert.equal(f.fileData.has(f.fileKey(first.photo)), false);
  assert.equal(f.fileData.has(f.fileKey(second.photo)), true);
  assert.equal(
    f.calls.filter((call) => call[0] === 'remove' && call[1] === c.photoKey(first.photo)).length,
    1,
  );
  assert.equal((await f.manager.queueCleanup([first.photo])).pending, false);
});

test('an unjournaled target is inspected only: absent is complete, present or unreadable remains pending', async () => {
  const f = setup();
  const photo = {
    id: 'photo-unjournaled',
    ownerIncarnationId: 'wallet-photo',
    fileName: 'photo-unjournaled.png',
    ...inspection,
  };
  assert.equal((await f.manager.queueCleanup([photo])).pending, false);
  f.fileData.set(f.fileKey(photo), { ...inspection });
  assert.equal((await f.manager.queueCleanup([photo])).pending, true);
  assert.equal(f.fileData.has(f.fileKey(photo)), true);
  f.files.inspectOwned = async () => {
    throw Error('cannot inspect');
  };
  assert.equal((await f.manager.queueCleanup([photo])).pending, true);
  assert.equal(
    f.calls.some((call) => call[0] === 'remove'),
    false,
  );
});
