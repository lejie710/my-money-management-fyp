const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/core/model'),
  c = require('../src/core/transactionContext'),
  s = require('../src/core/storage');
const oldModel = require('../src/core/model'),
  oldDemo = require('../src/demo/ledger');
const clock = { today: '2026-10-18', nowMs: Date.parse('2026-10-18T12:00:00Z') };
const identity = { clock, newIncarnationId: () => 'wallet-context' };
const fresh = () => m.createEmptyLedger({}, identity);
function add(ledger, id = 'expense') {
  return m.saveTransaction(
    ledger,
    m.transactionFromDraft(
      {
        type: 'expense',
        title: 'Groceries',
        categoryId: 'expense-food',
        amount: '12.34',
        date: '2026-10-17',
      },
      id,
      ledger,
    ),
  );
}
const photo = (owner = 'wallet-context', id = 'photo-one') => ({
  id,
  ownerIncarnationId: owner,
  fileName: `${id}.png`,
  mimeType: 'image/png',
  width: 100,
  height: 50,
  byteSize: 500,
});
function context(ledger) {
  return m.saveTransaction(
    ledger,
    m.patchTransactionContext(
      ledger.transactions[0],
      {
        notes: 'Original note',
        photo: photo(),
        withPerson: { name: 'Alex', source: 'contacts' },
        location: { label: 'Penang', source: 'device' },
      },
      ledger,
    ),
    true,
  );
}
function memory(entries = []) {
  const data = new Map(entries),
    reads = [],
    writes = [];
  return {
    data,
    reads,
    writes,
    adapter: {
      async getItem(key) {
        reads.push(key);
        return data.get(key) ?? null;
      },
      async setItem(key, value) {
        writes.push(key);
        data.set(key, value);
      },
    },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

test('v5 absent context is an empty detached view and bounded Unicode normalizes only blank labels', () => {
  const ledger = add(fresh()),
    tx = ledger.transactions[0];
  assert.equal(ledger.version, 5);
  assert.deepEqual(c.contextForTransaction(tx), {
    notes: '',
    photo: null,
    withPerson: null,
    location: null,
  });
  const patched = m.patchTransactionContext(
    tx,
    {
      notes: '  Café 中文 ☕\nsecond line  ',
      withPerson: { name: '  李 Alex  ', source: 'manual' },
      location: { label: '  Jalan 漢字  ', source: 'manual' },
    },
    ledger,
  );
  assert.equal(patched.context.notes, '  Café 中文 ☕\nsecond line  ');
  assert.equal(patched.context.withPerson.name, '李 Alex');
  assert.equal(patched.context.location.label, 'Jalan 漢字');
  const detached = c.contextForTransaction(patched);
  detached.notes = 'changed';
  detached.withPerson.name = 'other';
  assert.equal(patched.context.withPerson.name, '李 Alex');
  assert.notEqual(patched.context.notes, 'changed');
  assert.deepEqual(
    c.normalizeContextPatch({
      notes: ' \n ',
      withPerson: { name: ' ', source: 'manual' },
      location: { label: ' ', source: 'manual' },
    }),
    { notes: '', withPerson: null, location: null },
  );
});

test('context rejects unbounded text, raw address-book details, coordinates and unknown patch fields', () => {
  for (const patch of [
    { notes: 'x'.repeat(2001) },
    { notes: 1 },
    { withPerson: { name: 'x'.repeat(121), source: 'manual' } },
    { withPerson: { name: 'Alex', source: 'contacts', phone: 'not needed' } },
    { location: { label: 'Place', source: 'device', latitude: 1 } },
    { location: { label: 'x'.repeat(241), source: 'manual' } },
    { location: { label: 'Place', source: 'unknown' } },
    { photo: 'https://example.invalid/image' },
    { rawGps: 'unwanted' },
  ])
    assert.throws(() => c.normalizeContextPatch(patch));
  assert.equal(c.normalizeContextPatch({ notes: 'x'.repeat(2000) }).notes.length, 2000);
});

test('photo metadata uses generated names, exact owner/type/size bounds and no arbitrary URIs', () => {
  assert.equal(c.validatePhotoRef(photo(), 'wallet-context').fileName, 'photo-one.png');
  for (const change of [
    { fileName: '../other.png' },
    { fileName: 'file:///photo.png' },
    { fileName: 'photo-one.jpg' },
    { id: 'photo-../bad' },
    { ownerIncarnationId: 'other-wallet' },
    { mimeType: 'image/svg+xml' },
    { width: 0 },
    { height: Infinity },
    { width: 16385 },
    { width: 10000, height: 5000 },
    { byteSize: 10485761 },
    { byteSize: 0 },
    { byteSize: 0.5 },
    { uri: 'file:///private' },
  ])
    assert.throws(() => c.validatePhotoRef({ ...photo(), ...change }, 'wallet-context'));
  assert.doesNotThrow(() =>
    c.validatePhotoRef({ ...photo(), byteSize: 10485760, width: 8000, height: 5000 }),
  );
});

test('financial-only transaction edits preserve every context field, unknown provenance and actual date', () => {
  const ledger = context(add(fresh()));
  ledger.transactions[0].origin = { kind: 'recorded', capture: 'preserve' };
  const tx = m.transactionFromDraft(
    {
      type: 'expense',
      title: 'Edited groceries',
      categoryId: 'expense-food',
      amount: '20',
      date: '2026-10-17',
    },
    'expense',
    ledger,
  );
  assert.deepEqual(tx.context, ledger.transactions[0].context);
  assert.deepEqual(tx.origin, ledger.transactions[0].origin);
  const updated = m.saveTransaction(ledger, tx, true);
  assert.deepEqual(updated.transactions[0].context, ledger.transactions[0].context);
  assert.equal(updated.transactions[0].amountMinor, 2000);
  assert.equal(updated.transactions[0].date, '2026-10-17');
  const { context: ignored, ...partial } = tx;
  assert.deepEqual(
    m.saveTransaction(ledger, partial, true).transactions[0].context,
    ledger.transactions[0].context,
  );
  assert.deepEqual(
    m.saveTransaction(ledger, { ...tx, context: undefined }, true).transactions[0].context,
    ledger.transactions[0].context,
  );
  assert.equal(
    m.patchTransactionContext(partial, { notes: 'Changed' }, ledger).context.photo.id,
    'photo-one',
  );
});

test('explicit field clearing and whole-context clearing survive JSON without changing money or dates', () => {
  const ledger = context(add(fresh())),
    old = JSON.stringify(ledger);
  const cleared = m.saveTransaction(
    ledger,
    m.patchTransactionContext(
      ledger.transactions[0],
      { photo: null, withPerson: null, location: null, notes: null },
      ledger,
    ),
    true,
  );
  assert.deepEqual(cleared.transactions[0].context, c.emptyTransactionContext());
  assert.deepEqual(m.totals(cleared), m.totals(ledger));
  assert.deepEqual(
    m.periodTotals(cleared, '2026-10-01', '2026-10-31'),
    m.periodTotals(ledger, '2026-10-01', '2026-10-31'),
  );
  assert.equal(JSON.stringify(ledger), old);
  assert.deepEqual(
    m.validateLedger(JSON.parse(JSON.stringify(cleared))).transactions[0].context,
    c.emptyTransactionContext(),
  );
  assert.deepEqual(
    m.patchTransactionContext(ledger.transactions[0], null, ledger).context,
    c.emptyTransactionContext(),
  );
});

test('current malformed context and conflicting photo metadata fail without silently repairing records', () => {
  const ledger = context(add(fresh()));
  for (const value of [
    null,
    {},
    { ...ledger.transactions[0].context, notes: '  ' },
    { ...ledger.transactions[0].context, withPerson: { name: ' Alex ', source: 'manual' } },
    { ...ledger.transactions[0].context, photo: photo('other') },
  ])
    assert.throws(() =>
      m.validateLedger({
        ...ledger,
        transactions: [{ ...ledger.transactions[0], context: value }],
      }),
    );
  const second = {
    ...ledger.transactions[0],
    id: 'second',
    context: { ...ledger.transactions[0].context, photo: { ...photo(), width: 101 } },
  };
  assert.throws(() => m.saveTransaction(ledger, second), /ambiguous/);
  const same = {
    ...second,
    context: { ...second.context, photo: Object.fromEntries(Object.entries(photo()).reverse()) },
  };
  assert.doesNotThrow(() => m.saveTransaction(ledger, same));
});

test('v4 migration preserves identity, financial bytes and extras while promoting compatible legacy text only', () => {
  const old = { ...oldModel.createDemoLedger(new Date(2026, 9, 17), identity), version: 4 };
  old.transactions[0].notes = 'Original note';
  old.transactions[0].withPerson = ' Alex ';
  old.transactions[0].location = ' Penang ';
  old.transactions[0].imageUrl = 'https://example.invalid/legacy-photo';
  old.extra = { kept: true };
  const bytes = JSON.stringify(old),
    result = m.migrateLedger(old, {
      newIncarnationId: () => {
        throw Error('must preserve identity');
      },
    });
  assert.equal(result.version, 5);
  assert.deepEqual(result.wallet, old.wallet);
  assert.deepEqual(result.achievements, old.achievements);
  assert.deepEqual(result.extra, old.extra);
  assert.equal(JSON.stringify(old), bytes);
  assert.deepEqual(result.transactions[0].context, {
    notes: 'Original note',
    photo: null,
    withPerson: { name: 'Alex', source: 'recorded' },
    location: { label: 'Penang', source: 'recorded' },
  });
  assert.equal(result.transactions[0].imageUrl, old.transactions[0].imageUrl);
  assert.equal(result.transactions[0].withPerson, ' Alex ');
  assert.deepEqual(m.totals(result), { income: 320000, expense: 11200, debt: 0, balance: 308800 });
});

test('v1–v3 migration retains incompatible legacy extras without truncation or remote-photo ownership', () => {
  const old = oldDemo.createDemoLedger(new Date(2026, 9, 17));
  old.transactions[0].notes = 'x'.repeat(2001);
  old.transactions[0].withPerson = { name: 'Alex', phone: 'unpromoted' };
  old.transactions[0].location = 'Place';
  const result = m.migrateLedger(old, identity);
  assert.equal(result.transactions[0].notes.length, 2001);
  assert.deepEqual(result.transactions[0].withPerson, old.transactions[0].withPerson);
  assert.equal(result.transactions[0].context.notes, '');
  assert.equal(result.transactions[0].context.withPerson, null);
  assert.equal(result.transactions[0].context.location.label, 'Place');
  for (const version of [2, 3]) {
    const old4 = oldModel.createDemoLedger(new Date(2026, 9, 17), identity),
      { achievements, ...value } = old4;
    delete value.wallet.incarnationId;
    delete value.wallet.trackingStartedOn;
    value.version = version;
    if (version === 2) {
      delete value.budgets;
      delete value.goal;
    }
    const raw = JSON.stringify(value);
    const migrated = m.migrateLedger(value, identity);
    assert.equal(migrated.version, 5);
    assert.equal(migrated.wallet.incarnationId, 'wallet-context');
    assert.equal(JSON.stringify(value), raw);
  }
});

test('copy migration writes v5 once and keeps v4 bytes unchanged, including retained photo context', async () => {
  const current = context(add(fresh())),
    old = { ...current, version: 4 },
    bytes = JSON.stringify(old, null, 2);
  const mem = memory([[s.PREVIOUS_STORAGE_KEY, bytes]]),
    store = s.createLedgerStorage(mem.adapter);
  const migrated = await store.load();
  assert.equal(migrated.version, 5);
  assert.deepEqual(migrated.transactions[0].context, old.transactions[0].context);
  assert.equal(mem.data.get(s.PREVIOUS_STORAGE_KEY), bytes);
  assert.deepEqual(mem.writes, [s.STORAGE_KEY]);
  assert.deepEqual(await store.readCurrent(), migrated);
  assert.deepEqual(mem.writes, [s.STORAGE_KEY]);
});

test('reference scan includes retained v4/v5 and shared records without identity allocation or source mutation', async () => {
  const withPhoto = context(add(fresh())),
    retained = { ...withPhoto, version: 4 };
  const other = {
    ...withPhoto,
    transactions: [...withPhoto.transactions, { ...withPhoto.transactions[0], id: 'second' }],
  };
  const mem = memory([
    ['@test/v5', JSON.stringify(fresh())],
    ['@test/v4', JSON.stringify(retained)],
    ['@test/retained-v5', JSON.stringify(other)],
  ]);
  const before = [...mem.data];
  const store = s.createLedgerStorage(mem.adapter, {
    key: '@test/v5',
    legacyKeys: ['@test/v4', '@test/retained-v5'],
    identityContext: {
      newIncarnationId: () => {
        throw Error('must not allocate');
      },
    },
  });
  const snapshot = await store.withRetainedPhotoReferences(async (value) => value);
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.references, [photo()]);
  assert.deepEqual([...mem.data], before);
  assert.equal(mem.writes.length, 0);
});

test('missing active, corrupt/unsupported retained stores and read failures retain uncertain references', async () => {
  for (const entries of [
    [],
    [
      ['@test/v5', JSON.stringify(fresh())],
      ['@test/v4', 'broken'],
    ],
    [
      ['@test/v5', JSON.stringify(fresh())],
      ['@test/v4', JSON.stringify({ version: 99 })],
    ],
  ]) {
    const mem = memory(entries),
      store = s.createLedgerStorage(mem.adapter, { key: '@test/v5', legacyKey: '@test/v4' });
    const snapshot = await store.withRetainedPhotoReferences(async (value) => value);
    assert.equal(snapshot.complete, false);
    assert.equal(mem.writes.length, 0);
  }
  const mem = memory([['@test/v5', JSON.stringify(fresh())]]);
  mem.adapter.getItem = async () => {
    throw Error('read unavailable');
  };
  assert.equal(
    (
      await s
        .createLedgerStorage(mem.adapter, { key: '@test/v5' })
        .withRetainedPhotoReferences(async (value) => value)
    ).complete,
    false,
  );
});

test('reference barrier finishes before a queued save and captures caller drafts before waiting', async () => {
  const mem = memory([['@test/barrier', JSON.stringify(fresh())]]),
    store = s.createLedgerStorage(mem.adapter, { key: '@test/barrier' }),
    entered = deferred(),
    release = deferred(),
    events = [];
  const cleanup = store.withRetainedPhotoReferences(async (snapshot) => {
    assert.equal(snapshot.complete, true);
    events.push('scan');
    entered.resolve();
    await release.promise;
    events.push('cleanup');
  });
  await entered.promise;
  const next = m.updateWallet(fresh(), { name: 'Intended' }),
    saving = store.save(next);
  next.wallet.name = 'Late mutation';
  await Promise.resolve();
  assert.equal(mem.writes.length, 0);
  release.resolve();
  await cleanup;
  const saved = await saving;
  assert.equal(saved.wallet.name, 'Intended');
  assert.deepEqual(events, ['scan', 'cleanup']);
  assert.equal(JSON.parse(mem.data.get('@test/barrier')).wallet.name, 'Intended');
});

test('a save already in flight settles before reference scan and then protects its newly referenced photo', async () => {
  const mem = memory([['@test/forward', JSON.stringify(fresh())]]),
    store = s.createLedgerStorage(mem.adapter, { key: '@test/forward' }),
    entered = deferred(),
    release = deferred(),
    original = mem.adapter.setItem;
  mem.adapter.setItem = async (key, bytes) => {
    entered.resolve();
    await release.promise;
    return original(key, bytes);
  };
  const saving = store.save(context(add(fresh())));
  await entered.promise;
  let scanned = false;
  const reading = store.withRetainedPhotoReferences(async (snapshot) => {
    scanned = true;
    return snapshot;
  });
  await Promise.resolve();
  assert.equal(scanned, false);
  release.resolve();
  await saving;
  assert.deepEqual((await reading).references, [photo()]);
});

test('write rejection before/after effect preserves bytes or exposes actual state through active-only readCurrent', async () => {
  const old = fresh(),
    mem = memory([['@test/write', JSON.stringify(old)]]),
    store = s.createLedgerStorage(mem.adapter, { key: '@test/write' }),
    next = add(old),
    original = mem.adapter.setItem;
  mem.adapter.setItem = async () => {
    throw Error('before');
  };
  await assert.rejects(() => store.save(next));
  assert.deepEqual(await store.readCurrent(), old);
  mem.adapter.setItem = async (key, bytes) => {
    await original(key, bytes);
    throw Error('after');
  };
  await assert.rejects(() => store.save(next));
  assert.deepEqual(await store.readCurrent(), next);
});

test('isolated photo reference scans never read canonical keys and old/current malformed data never reseeds', async () => {
  const canary = JSON.stringify(context(add(fresh()))),
    mem = memory([
      [s.STORAGE_KEY, canary],
      ['@test/isolated', JSON.stringify(fresh())],
    ]),
    store = s.createLedgerStorage(mem.adapter, { key: '@test/isolated', legacyKeys: [] });
  assert.deepEqual(
    (await store.withRetainedPhotoReferences(async (value) => value)).references,
    [],
  );
  assert.deepEqual(mem.reads, ['@test/isolated']);
  assert.equal(mem.data.get(s.STORAGE_KEY), canary);
  mem.data.set('@test/isolated', JSON.stringify({ ...fresh(), version: 99 }));
  await assert.rejects(() => store.load());
  assert.equal(mem.writes.length, 0);
});
