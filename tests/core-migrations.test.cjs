const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/core/model');
const v1 = require('../src/demo/ledger');
const {
  createLedgerStorage,
  STORAGE_KEY,
  PREVIOUS_STORAGE_KEY,
  VERSION_3_STORAGE_KEY,
  VERSION_2_STORAGE_KEY,
  LEGACY_STORAGE_KEY,
} = require('../src/core/storage');

function version2Fixture() {
  const { budgets, goal, achievements, ...ledger } = model.createDemoLedger(new Date(2026, 9, 17));
  const { incarnationId, trackingStartedOn, ...wallet } = ledger.wallet;
  return { ...ledger, wallet, version: 2 };
}

function memoryStore(entries) {
  const data = new Map(entries);
  const reads = [];
  const writes = [];
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

test('v2 migration adds empty planning fields while preserving financial records and extra known-version data', () => {
  const old = version2Fixture();
  old.wallet.name = 'My wallet with later edits';
  old.extension = { harmlessFutureMetadata: 'keep me' };
  old.wallet.displayPreference = 'keep wallet metadata';
  old.transactions[0].note = 'Keep this original note';
  old.categories[0].iconPreference = 'keep category metadata';
  const before = JSON.stringify(old);
  const migrated = model.migrateLedger(old);
  assert.equal(migrated.version, 5);
  assert.deepEqual(migrated.budgets, []);
  assert.equal(migrated.goal, null);
  assert.deepEqual(migrated.transactions, old.transactions);
  assert.deepEqual(migrated.categories, old.categories);
  const { incarnationId, trackingStartedOn, ...financialWallet } = migrated.wallet;
  assert.deepEqual(financialWallet, old.wallet);
  assert.ok(incarnationId);
  assert.ok(model.validDate(trackingStartedOn));
  assert.deepEqual(migrated.extension, old.extension);
  assert.equal(JSON.stringify(old), before);
  assert.equal(model.migrateLedger(migrated), migrated);
  const renamed = model.updateWallet(migrated, { name: 'New wallet name' });
  assert.equal(renamed.wallet.displayPreference, old.wallet.displayPreference);
  const edited = model.saveTransaction(
    migrated,
    model.transactionFromDraft(
      {
        type: 'income',
        title: 'Edited salary',
        categoryId: 'income-salary',
        date: '2026-10-01',
        amount: '3300',
      },
      'sample-salary',
      migrated,
    ),
    true,
  );
  assert.equal(edited.transactions[0].note, 'Keep this original note');
  assert.deepEqual(edited.extension, old.extension);
});

test('already-present planning fields on a known old version are validated rather than discarded', () => {
  let ledger = model.createDemoLedger(new Date(2026, 9, 17));
  const budget = model.budgetFromDraft(
    { categoryId: 'expense-food', amount: '100', period: 'month', anchorDate: '2026-10-17' },
    'existing-budget',
    ledger,
  );
  ledger = model.saveBudget(ledger, budget);
  ledger = model.saveGoal(
    ledger,
    model.goalFromDraft({ kind: 'home', amount: '4000' }, 'existing-goal', ledger),
  );
  const old = { ...ledger, version: 2 };
  const migrated = model.migrateLedger(old);
  assert.deepEqual(migrated.budgets, ledger.budgets);
  assert.deepEqual(migrated.goal, ledger.goal);
  assert.throws(() => model.migrateLedger({ ...old, budgets: null }), /invalid format/);
  assert.throws(
    () => model.migrateLedger({ ...old, goal: { ...old.goal, targetMinor: 0 } }),
    /invalid format/,
  );
  assert.throws(
    () => model.migrateLedger({ ...old, budgets: [budget, { ...budget, id: 'duplicate-period' }] }),
    /invalid format/,
  );
});

test('v1 migration preserves unrelated metadata while replacing its obsolete amount/category fields', () => {
  const old = v1.createDemoLedger(new Date(2026, 9, 17));
  old.extension = { preserved: true };
  old.wallet.note = 'A wallet note';
  old.transactions[0].note = 'A transaction note';
  const before = JSON.stringify(old);
  const migrated = model.migrateLedger(old);
  assert.equal(migrated.version, 5);
  assert.deepEqual(migrated.extension, old.extension);
  assert.equal(migrated.wallet.note, old.wallet.note);
  assert.equal(migrated.transactions[0].note, old.transactions[0].note);
  assert.equal(Object.hasOwn(migrated.transactions[0], 'amountCents'), false);
  assert.equal(Object.hasOwn(migrated.transactions[0], 'category'), false);
  assert.equal(JSON.stringify(old), before);
  assert.deepEqual(migrated.budgets, []);
  assert.equal(migrated.goal, null);
});

test('current validation rejects missing planning fields, invalid references, noncanonical boundaries and unknown versions', () => {
  const ledger = model.createDemoLedger();
  const { budgets, ...noBudgets } = ledger;
  const { goal, ...noGoal } = ledger;
  assert.throws(() => model.validateLedger(noBudgets), /invalid format/);
  assert.throws(() => model.validateLedger(noGoal), /invalid format/);
  const budget = model.budgetFromDraft(
    { categoryId: 'expense-food', amount: '100', period: 'month', anchorDate: '2026-10-17' },
    'budget',
    ledger,
  );
  for (const bad of [
    { ...budget, categoryId: 'income-salary' },
    { ...budget, startDate: '2026-10-02' },
    { ...budget, plannedMinor: 0 },
    { ...budget, walletId: 'other' },
  ])
    assert.throws(() => model.validateLedger({ ...ledger, budgets: [bad] }), /invalid format/);
  assert.throws(() => model.migrateLedger({ ...ledger, version: 99 }));
  assert.throws(() =>
    model.migrateLedger({
      ...version2Fixture(),
      wallet: { ...ledger.wallet, hasTransactionHistory: false },
    }),
  );
});

test('default migration prefers newer v2 edits and preserves both earlier stores byte for byte', async () => {
  const oldV1 = JSON.stringify(v1.createDemoLedger(new Date(2026, 9, 17)), null, 2);
  const newer = version2Fixture();
  newer.wallet.name = 'Latest v2 edit';
  const oldV2 = JSON.stringify(newer, null, 4);
  const memory = memoryStore([
    [LEGACY_STORAGE_KEY, oldV1],
    [VERSION_2_STORAGE_KEY, oldV2],
  ]);
  const migrated = await createLedgerStorage(memory.adapter).load();
  assert.equal(migrated.version, 5);
  assert.equal(migrated.wallet.name, 'Latest v2 edit');
  assert.deepEqual(memory.reads, [
    STORAGE_KEY,
    PREVIOUS_STORAGE_KEY,
    VERSION_3_STORAGE_KEY,
    VERSION_2_STORAGE_KEY,
  ]);
  assert.deepEqual(memory.writes, [STORAGE_KEY]);
  assert.equal(memory.data.get(LEGACY_STORAGE_KEY), oldV1);
  assert.equal(memory.data.get(VERSION_2_STORAGE_KEY), oldV2);
  assert.deepEqual(await createLedgerStorage(memory.adapter).load(), migrated);
  assert.deepEqual(memory.writes, [STORAGE_KEY]);
});

test('corrupt or unsupported newer data stops migration instead of reviving stale v1 history', async () => {
  const stale = JSON.stringify(v1.createDemoLedger());
  for (const bad of ['', 'broken JSON', JSON.stringify({ ...version2Fixture(), version: 99 })]) {
    const memory = memoryStore([
      [LEGACY_STORAGE_KEY, stale],
      [VERSION_2_STORAGE_KEY, bad],
    ]);
    await assert.rejects(() => createLedgerStorage(memory.adapter).load());
    assert.deepEqual(memory.reads, [
      STORAGE_KEY,
      PREVIOUS_STORAGE_KEY,
      VERSION_3_STORAGE_KEY,
      VERSION_2_STORAGE_KEY,
    ]);
    assert.equal(memory.writes.length, 0);
    assert.equal(memory.data.get(VERSION_2_STORAGE_KEY), bad);
    assert.equal(memory.data.get(LEGACY_STORAGE_KEY), stale);
    assert.equal(memory.data.has(STORAGE_KEY), false);
  }
});

test('v2 migration write failure leaves all previous bytes available for a retry', async () => {
  const oldText = JSON.stringify(version2Fixture());
  const memory = memoryStore([[VERSION_2_STORAGE_KEY, oldText]]);
  const originalWrite = memory.adapter.setItem;
  memory.adapter.setItem = async () => {
    throw new Error('Synthetic write failure');
  };
  await assert.rejects(() => createLedgerStorage(memory.adapter).load(), /Synthetic write failure/);
  assert.equal(memory.data.get(VERSION_2_STORAGE_KEY), oldText);
  assert.equal(memory.data.has(STORAGE_KEY), false);
  memory.adapter.setItem = originalWrite;
  assert.equal((await createLedgerStorage(memory.adapter).load()).version, 5);
  assert.equal(memory.data.get(VERSION_2_STORAGE_KEY), oldText);
});

test('custom namespace and legacyKey null never inspect canonical or prior stores', async () => {
  const memory = memoryStore([
    [STORAGE_KEY, JSON.stringify(model.createDemoLedger())],
    [PREVIOUS_STORAGE_KEY, JSON.stringify(version2Fixture())],
    [LEGACY_STORAGE_KEY, JSON.stringify(v1.createDemoLedger())],
  ]);
  const before = [...memory.data.entries()];
  assert.equal(
    await createLedgerStorage(memory.adapter, { key: '@tests/branch2', legacyKey: null }).load(),
    null,
  );
  assert.deepEqual(memory.reads, ['@tests/branch2']);
  assert.deepEqual([...memory.data.entries()], before);
  assert.equal(memory.writes.length, 0);
  const noFallback = memoryStore([[PREVIOUS_STORAGE_KEY, JSON.stringify(version2Fixture())]]);
  assert.equal(await createLedgerStorage(noFallback.adapter, { legacyKey: null }).load(), null);
  assert.deepEqual(noFallback.reads, [STORAGE_KEY]);
});

test('explicit synthetic migration chains preserve priority and reject ambiguous or destructive key options', async () => {
  const oldText = JSON.stringify(version2Fixture());
  const memory = memoryStore([['@tests/v2', oldText]]);
  const chain = ['@tests/v2', '@tests/v1'];
  const store = createLedgerStorage(memory.adapter, { key: '@tests/v3', legacyKeys: chain });
  chain[0] = LEGACY_STORAGE_KEY;
  assert.equal((await store.load()).version, 5);
  assert.deepEqual(memory.reads, ['@tests/v3', '@tests/v2']);
  assert.deepEqual(memory.writes, ['@tests/v3']);
  assert.equal(memory.data.get('@tests/v2'), oldText);
  for (const options of [
    { key: PREVIOUS_STORAGE_KEY },
    { key: LEGACY_STORAGE_KEY },
    { key: '@tests/same', legacyKeys: ['@tests/same'] },
    { legacyKey: null, legacyKeys: [] },
    { legacyKeys: ['duplicate', 'duplicate'] },
    { legacyKeys: null },
  ])
    assert.throws(() => createLedgerStorage(memory.adapter, options));
});
