const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/core/model');
const a = require('../src/core/achievements');
const oldDemo = require('../src/demo/ledger');
const {
  createLedgerStorage,
  STORAGE_KEY,
  PREVIOUS_STORAGE_KEY: VERSION_4_STORAGE_KEY,
  VERSION_3_STORAGE_KEY: PREVIOUS_STORAGE_KEY,
  VERSION_2_STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  MIGRATION_STORAGE_KEYS,
} = require('../src/core/storage');
const time = { today: '2026-11-02', nowMs: Date.parse('2026-11-02T12:00:00Z') };
const context = { clock: time, newIncarnationId: () => 'migration-owner' };
function fresh() {
  return m.createEmptyLedger({}, context);
}
function older(version = 3) {
  const { achievements, ...value } = m.createDemoLedger(new Date(2026, 9, 17), context);
  const { incarnationId, trackingStartedOn, ...wallet } = value.wallet;
  const result = { ...value, wallet, version };
  if (version === 2) {
    delete result.budgets;
    delete result.goal;
  }
  return result;
}
function memory(entries = []) {
  const data = new Map(entries),
    reads = [],
    writes = [];
  const adapter = {
    async getItem(key) {
      reads.push(key);
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      writes.push(key);
      data.set(key, value);
    },
  };
  return { data, reads, writes, adapter };
}

test('current copy migration preserves v1/v2/v3 originals, financial fields, unknown metadata and no invented events', () => {
  for (const old of [oldDemo.createDemoLedger(new Date(2026, 9, 17)), older(2), older(3)]) {
    old.extension = { preserved: ['value'] };
    old.wallet.preference = 'unchanged';
    old.transactions[0].note = 'Original note';
    const raw = JSON.stringify(old),
      current = m.migrateLedger(old, context);
    assert.equal(current.version, 5);
    assert.equal(current.wallet.incarnationId, 'migration-owner');
    assert.equal(current.wallet.trackingStartedOn, time.today);
    assert.equal(current.achievements.ownerIncarnationId, current.wallet.incarnationId);
    assert.deepEqual(current.achievements.awards, []);
    assert.deepEqual(current.achievements.completedDays, []);
    assert.deepEqual(current.achievements.weeklyReviews, []);
    assert.equal(current.wallet.name, old.wallet.name);
    assert.equal(current.wallet.id, old.wallet.id);
    assert.equal(current.wallet.preference, 'unchanged');
    assert.deepEqual(current.extension, old.extension);
    assert.equal(JSON.stringify(old), raw);
    assert.deepEqual(
      current.transactions.map((t) => [t.id, t.date, t.title, t.amountMinor]),
      old.transactions.map((t) => [t.id, t.date, t.title, t.amountMinor ?? t.amountCents]),
    );
    assert.equal(current.transactions[0].note, 'Original note');
  }
});

test('default new key prefers v3 history and preserves every earlier store byte for byte', async () => {
  const oldV3 = older();
  oldV3.wallet.name = 'Latest saved history';
  const sources = [
    [PREVIOUS_STORAGE_KEY, JSON.stringify(oldV3, null, 3)],
    [VERSION_2_STORAGE_KEY, JSON.stringify(older(2), null, 4)],
    [LEGACY_STORAGE_KEY, JSON.stringify(oldDemo.createDemoLedger(), null, 2)],
  ];
  const store = memory(sources);
  let generated = 0;
  const identityContext = { clock: time, newIncarnationId: () => `owner-${++generated}` };
  const current = await createLedgerStorage(store.adapter, { identityContext }).load();
  assert.equal(STORAGE_KEY, '@mymoney/core/v5');
  assert.deepEqual(MIGRATION_STORAGE_KEYS, [
    VERSION_4_STORAGE_KEY,
    PREVIOUS_STORAGE_KEY,
    VERSION_2_STORAGE_KEY,
    LEGACY_STORAGE_KEY,
  ]);
  assert.equal(current.wallet.name, 'Latest saved history');
  assert.equal(current.wallet.incarnationId, 'owner-1');
  assert.equal(generated, 1);
  assert.deepEqual(store.reads, [STORAGE_KEY, VERSION_4_STORAGE_KEY, PREVIOUS_STORAGE_KEY]);
  assert.deepEqual(store.writes, [STORAGE_KEY]);
  for (const [key, bytes] of sources) assert.equal(store.data.get(key), bytes);
  assert.deepEqual(await createLedgerStorage(store.adapter, { identityContext }).load(), current);
  assert.equal(generated, 1);
  assert.equal(store.writes.length, 1);
});

test('new/fresh/sample identity is independent, normal edits preserve it, and sample date is not tracking date', () => {
  let n = 0;
  const factory = { clock: time, newIncarnationId: () => `new-${++n}` };
  const first = m.createEmptyLedger({}, factory),
    second = m.createEmptyLedger({}, factory),
    sample = m.createDemoLedger(new Date(2024, 0, 1), factory);
  assert.equal(
    new Set([first.wallet.incarnationId, second.wallet.incarnationId, sample.wallet.incarnationId])
      .size,
    3,
  );
  assert.equal(sample.wallet.trackingStartedOn, '2026-11-02');
  assert.equal(sample.transactions[0].date, '2024-01-01');
  assert.equal(
    m.updateWallet(first, { name: 'Renamed' }).wallet.incarnationId,
    first.wallet.incarnationId,
  );
  assert.equal(
    m.migrateLedger(first, {
      newIncarnationId: () => {
        throw Error('must not run');
      },
    }),
    first,
  );
  assert.deepEqual(second.achievements.awards, []);
  assert.deepEqual(second.achievements.weeklyReviews, []);
  assert.throws(
    () => m.createEmptyLedger({}, { clock: time, newIncarnationId: () => '' }),
    /identifier/,
  );
});

test('complete reserved data on old known version is preserved; partial or malformed data is never replaced', () => {
  const current = fresh();
  current.achievements.extension = { keep: true };
  const reserved = { ...current, version: 3 };
  const migrated = m.migrateLedger(reserved, {
    newIncarnationId: () => {
      throw Error('must not regenerate');
    },
  });
  assert.equal(migrated.wallet.incarnationId, current.wallet.incarnationId);
  assert.equal(migrated.achievements, reserved.achievements);
  const old = older();
  for (const bad of [
    { ...old, wallet: { ...old.wallet, incarnationId: 'partial' } },
    { ...old, wallet: { ...old.wallet, trackingStartedOn: time.today } },
    { ...old, achievements: current.achievements },
    { ...reserved, achievements: { ...current.achievements, version: 99 } },
    { ...reserved, achievements: { ...current.achievements, ownerIncarnationId: 'someone-else' } },
  ]) {
    const raw = JSON.stringify(bad);
    assert.throws(() => m.migrateLedger(bad, context));
    assert.equal(JSON.stringify(bad), raw);
  }
});

test('failed migration before write exposes no owner, retry creates once, rejected-after-write reload adopts actual stored owner', async () => {
  const bytes = JSON.stringify(older()),
    store = memory([[PREVIOUS_STORAGE_KEY, bytes]]);
  let count = 0;
  const identityContext = { clock: time, newIncarnationId: () => `attempt-${++count}` };
  const normal = store.adapter.setItem;
  store.adapter.setItem = async () => {
    throw Error('before-write');
  };
  await assert.rejects(
    () => createLedgerStorage(store.adapter, { identityContext }).load(),
    /before-write/,
  );
  assert.equal(store.data.has(STORAGE_KEY), false);
  assert.equal(store.data.get(PREVIOUS_STORAGE_KEY), bytes);
  store.adapter.setItem = async (key, value) => {
    await normal(key, value);
    throw Error('after-write');
  };
  await assert.rejects(
    () => createLedgerStorage(store.adapter, { identityContext }).load(),
    /after-write/,
  );
  store.adapter.setItem = normal;
  const recovered = await createLedgerStorage(store.adapter, { identityContext }).load();
  assert.equal(recovered.wallet.incarnationId, 'attempt-2');
  assert.equal(count, 2);
  assert.equal(store.data.get(PREVIOUS_STORAGE_KEY), bytes);
});

test('readCurrent reads only active store, never migration or identity creation, including absent/corrupt cases', async () => {
  const bytes = JSON.stringify(older()),
    store = memory([[PREVIOUS_STORAGE_KEY, bytes]]);
  const wallet = createLedgerStorage(store.adapter, {
    identityContext: {
      newIncarnationId: () => {
        throw Error('must not migrate');
      },
    },
  });
  assert.equal(await wallet.readCurrent(), null);
  assert.deepEqual(store.reads, [STORAGE_KEY]);
  assert.deepEqual(store.writes, []);
  for (const raw of [
    'broken',
    JSON.stringify({ ...fresh(), version: 99 }),
    JSON.stringify(older()),
  ]) {
    store.reads.length = 0;
    store.data.set(STORAGE_KEY, raw);
    await assert.rejects(() => wallet.readCurrent());
    assert.deepEqual(store.reads, [STORAGE_KEY]);
    assert.equal(store.data.get(STORAGE_KEY), raw);
    assert.equal(store.writes.length, 0);
  }
  const actual = fresh();
  store.data.set(STORAGE_KEY, JSON.stringify(actual));
  assert.deepEqual(await wallet.readCurrent(), actual);
});

test('current malformed achievement state and corrupt newest prior data preserve bytes instead of falling back', async () => {
  const valid = fresh();
  const invalids = [
    { ...valid, achievements: undefined },
    { ...valid, wallet: { ...valid.wallet, incarnationId: undefined } },
    { ...valid, wallet: { ...valid.wallet, trackingStartedOn: '2026-02-30' } },
    { ...valid, achievements: { ...valid.achievements, ownerIncarnationId: 'foreign' } },
    { ...valid, achievements: { ...valid.achievements, awards: null } },
  ];
  for (const value of invalids) {
    const raw = JSON.stringify(value),
      store = memory([
        [STORAGE_KEY, raw],
        [PREVIOUS_STORAGE_KEY, JSON.stringify(older())],
      ]);
    await assert.rejects(() => createLedgerStorage(store.adapter).load());
    assert.deepEqual(store.reads, [STORAGE_KEY]);
    assert.equal(store.writes.length, 0);
    assert.equal(store.data.get(STORAGE_KEY), raw);
  }
  const store = memory([
    [PREVIOUS_STORAGE_KEY, 'broken v3'],
    [VERSION_2_STORAGE_KEY, JSON.stringify(older(2))],
  ]);
  await assert.rejects(() => createLedgerStorage(store.adapter).load());
  assert.deepEqual(store.reads, [STORAGE_KEY, VERSION_4_STORAGE_KEY, PREVIOUS_STORAGE_KEY]);
  assert.equal(store.writes.length, 0);
});

test('award and explicit event validation rejects malformed rules, dates, ownership, duplicates and sample evidence', () => {
  let ledger = fresh();
  const tx = m.transactionFromDraft(
    {
      title: 'Income',
      type: 'income',
      date: '2026-11-02',
      amount: '1',
      categoryId: 'income-salary',
    },
    'one',
    ledger,
  );
  ledger = a.reconcileAchievements(m.saveTransaction(ledger, tx), time).ledger;
  const award = ledger.achievements.awards[0];
  for (const changed of [
    { ...award, id: 'unknown' },
    { ...award, ruleVersion: 'future' },
    { ...award, earnedAtMs: NaN },
    { ...award, earnedOnDate: '2026-11-01' },
    { ...award, evidence: { ...award.evidence, date: '2026-11-03' } },
    { ...award, evidence: { kind: 'first_budget', budgetId: 'one' } },
  ])
    assert.throws(() =>
      m.validateLedger({ ...ledger, achievements: { ...ledger.achievements, awards: [changed] } }),
    );
  assert.throws(() =>
    m.validateLedger({
      ...ledger,
      achievements: { ...ledger.achievements, awards: [award, award] },
    }),
  );
  assert.throws(() => m.validateLedger({ ...ledger, mode: 'sample' }));
  const events = [{ date: '2026-11-02', confirmedAtMs: time.nowMs }];
  assert.throws(() =>
    m.validateLedger({
      ...fresh(),
      achievements: { ...fresh().achievements, completedDays: [...events, ...events] },
    }),
  );
  assert.throws(() =>
    m.validateLedger({
      ...fresh(),
      achievements: {
        ...fresh().achievements,
        completedDays: [{ date: '2026-11-01', confirmedAtMs: time.nowMs }],
      },
    }),
  );
  for (const review of [
    {
      weekStart: '2026-11-03',
      completedOnDate: '2026-11-03',
      completedAtMs: time.nowMs,
      expenseMinor: 0,
      debtMinor: 0,
      budgetCount: 0,
    },
    {
      weekStart: '2026-11-02',
      completedOnDate: '2026-11-09',
      completedAtMs: time.nowMs,
      expenseMinor: 0,
      debtMinor: 0,
      budgetCount: 0,
    },
    {
      weekStart: '2026-11-02',
      completedOnDate: '2026-11-02',
      completedAtMs: time.nowMs,
      expenseMinor: -1,
      debtMinor: 0,
      budgetCount: 0,
    },
  ])
    assert.throws(() =>
      m.validateLedger({
        ...fresh(),
        achievements: { ...fresh().achievements, weeklyReviews: [review] },
      }),
    );
});

test('rejected award write does not mutate committed ledger and readCurrent resolves ambiguous saved bytes', async () => {
  const before = fresh(),
    raw = JSON.stringify(before),
    store = memory([[STORAGE_KEY, raw]]),
    wallet = createLedgerStorage(store.adapter);
  const tx = m.transactionFromDraft(
    { title: 'Income', type: 'income', date: time.today, amount: '1', categoryId: 'income-salary' },
    'one',
    before,
  );
  const candidate = a.reconcileAchievements(m.saveTransaction(before, tx), time).ledger;
  const normal = store.adapter.setItem;
  store.adapter.setItem = async () => {
    throw Error('full');
  };
  await assert.rejects(() => wallet.save(candidate), /full/);
  assert.equal(store.data.get(STORAGE_KEY), raw);
  assert.deepEqual(before.achievements.awards, []);
  assert.deepEqual(await wallet.readCurrent(), before);
  store.adapter.setItem = async (key, value) => {
    await normal(key, value);
    throw Error('uncertain');
  };
  await assert.rejects(() => wallet.save(candidate), /uncertain/);
  assert.deepEqual(await wallet.readCurrent(), candidate);
  assert.equal(a.reconcileAchievements(await wallet.readCurrent(), time).newAwards.length, 0);
});

test('custom current-version test namespaces and explicit synthetic migrations never touch canonical preview bytes', async () => {
  const canonical = [
    [STORAGE_KEY, JSON.stringify(fresh())],
    [PREVIOUS_STORAGE_KEY, JSON.stringify(older())],
    [VERSION_2_STORAGE_KEY, JSON.stringify(older(2))],
    [LEGACY_STORAGE_KEY, JSON.stringify(oldDemo.createDemoLedger())],
  ];
  const store = memory([...canonical, ['@test/old', JSON.stringify(older())]]);
  assert.equal(
    await createLedgerStorage(store.adapter, { key: '@test/clean', legacyKey: null }).load(),
    null,
  );
  const current = await createLedgerStorage(store.adapter, {
    key: '@test/new',
    legacyKeys: ['@test/old'],
    identityContext: context,
  }).load();
  assert.equal(current.version, 5);
  assert.deepEqual(store.reads, ['@test/clean', '@test/new', '@test/old']);
  assert.deepEqual(store.writes, ['@test/new']);
  for (const [key, bytes] of canonical) assert.equal(store.data.get(key), bytes);
  for (const key of MIGRATION_STORAGE_KEYS)
    assert.throws(() => createLedgerStorage(store.adapter, { key }));
});
