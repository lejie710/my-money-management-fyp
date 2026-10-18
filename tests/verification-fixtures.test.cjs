const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmptyLedger, totals, periodTotals, goalProgress } = require('../src/core/model');
const { createLedgerStorage, loadOrCreateLedger, STORAGE_KEY } = require('../src/core/storage');
const { validateTestScenario, createVerificationLedger } = require('../src/verification/fixtures');
const { verificationClock } = require('../src/verification/fixtures');
const {
  reconcileAchievements,
  recordCompletedDay,
  completeWeeklyReview,
} = require('../src/core/achievements');

const scenario = 'report-reconciliation';
const fixture = () => createVerificationLedger('fixture-test', scenario);

test('isolated export fixture exercises multipage rows, whole yen, Unicode and both QR bounds', () => {
  const {
    createReportExportSnapshot,
    createTransactionExportSnapshot,
    buildTransactionQr,
  } = require('../src/core/exports');
  const ledger = createVerificationLedger('export-fixture-test', 'export-verification');
  const report = createReportExportSnapshot(ledger, '2026-10-01', '2026-10-31', 1792281600000);
  assert.equal(ledger.wallet.currency, 'JPY');
  assert.equal(ledger.mode, 'sample');
  assert.equal(report.transactionCount, 67);
  assert.equal(report.categoryBreakdown.length, 65);
  assert.equal(report.expenseMinor, 2080 + 1234 + 5678 + 999);
  const boundary = buildTransactionQr(
    createTransactionExportSnapshot(ledger, 'export-boundary', { notes: true }),
    { notes: true },
  );
  assert.equal(boundary.ok, true);
  assert.equal(boundary.byteLength, 1024);
  const overflow = buildTransactionQr(
    createTransactionExportSnapshot(ledger, 'export-overflow', { notes: true }),
    { notes: true },
  );
  assert.equal(overflow.ok, false);
  const unicode = buildTransactionQr(
    createTransactionExportSnapshot(ledger, 'export-unicode', { notes: true }),
    { notes: true },
  );
  assert.equal(JSON.parse(unicode.payload).title, 'Lunch 午餐 日本語 café');
  assert.equal(JSON.parse(unicode.payload).amountMinor, 1234);
  assert.throws(() => createVerificationLedger('', 'export-verification'), /isolated/);
});
function memory(initial = []) {
  const values = new Map(initial);
  const writes = [];
  return {
    values,
    writes,
    adapter: {
      async getItem(key) {
        return values.get(key) ?? null;
      },
      async setItem(key, value) {
        writes.push(key);
        values.set(key, value);
      },
    },
  };
}

test('verification selection is explicit and cannot use a canonical or blank namespace', () => {
  assert.equal(validateTestScenario(undefined, undefined), null);
  assert.equal(validateTestScenario('isolated', ''), null);
  for (const namespace of [undefined, '', '   ']) {
    assert.throws(() => validateTestScenario(namespace, scenario), /isolated/);
    assert.throws(() => createVerificationLedger(namespace, scenario), /isolated/);
  }
  assert.throws(() => validateTestScenario('isolated', 'typo'), /Unknown/);
  assert.throws(() => createVerificationLedger('isolated', ''), /explicit/);
});

test('report fixture has deterministic dates, independently reconciled totals and fresh instances', () => {
  const ledger = fixture();
  assert.equal(ledger.mode, 'sample');
  assert.equal(ledger.transactions.length, 10);
  assert.deepEqual(periodTotals(ledger, '2026-09-01', '2026-09-30'), {
    income: 100000,
    expense: 20000,
    debt: 5000,
    balance: 75000,
  });
  assert.deepEqual(periodTotals(ledger, '2026-10-01', '2026-10-31'), {
    income: 200000,
    expense: 25000,
    debt: 30000,
    balance: 145000,
  });
  assert.equal(totals(ledger).balance, 268000);
  ledger.transactions[0].title = 'Changed test instance';
  ledger.categories[0].name = 'Changed category';
  assert.equal(fixture().transactions[0].title, 'September salary');
  assert.equal(fixture().categories[0].name, 'Salary');
});

test('health fixture adds a separate goal while preserving the same reconciled financial history', () => {
  const ledger = createVerificationLedger('health-native-test', 'health-goal');
  assert.equal(ledger.wallet.name, 'Health example wallet');
  assert.equal(ledger.mode, 'sample');
  assert.equal(ledger.goal.targetMinor, 400000);
  assert.equal(totals(ledger).balance, 268000);
  assert.equal(goalProgress(ledger).percent, 67);
  assert.deepEqual(ledger.transactions, fixture().transactions);
  ledger.goal.targetMinor = 100;
  assert.equal(
    createVerificationLedger('health-native-test', 'health-goal').goal.targetMinor,
    400000,
  );
});

test('absent isolated store is persisted before seeded data is returned, without touching canonical bytes', async () => {
  const bytes = JSON.stringify(createEmptyLedger({ name: 'Canonical wallet' }));
  const data = memory([[STORAGE_KEY, bytes]]);
  const storage = createLedgerStorage(data.adapter, { key: '@mymoney/test/fixture-test/v3' });
  const result = await loadOrCreateLedger(storage, fixture);
  assert.equal(result.created, true);
  assert.equal(data.values.get(STORAGE_KEY), bytes);
  assert.deepEqual(data.writes, ['@mymoney/test/fixture-test/v3']);
  assert.deepEqual(JSON.parse(data.values.get(storage.key)), result.ledger);
});

test('existing saved ledger wins over seeding even after Start fresh emptied it', async () => {
  const saved = createEmptyLedger({ name: 'Keep this empty wallet' });
  const bytes = JSON.stringify(saved);
  const data = memory([['isolated', bytes]]);
  const storage = createLedgerStorage(data.adapter, { key: 'isolated' });
  let calls = 0;
  const result = await loadOrCreateLedger(storage, () => {
    calls += 1;
    return fixture();
  });
  assert.equal(result.created, false);
  assert.deepEqual(result.ledger, saved);
  assert.equal(calls, 0);
  assert.equal(data.values.get('isolated'), bytes);
  assert.equal(data.writes.length, 0);
});

test('failed, corrupt or unsupported saved reads cannot trigger a replacement fixture', async () => {
  for (const bytes of ['broken-json', JSON.stringify({ version: 999 })]) {
    const data = memory([['isolated', bytes]]);
    let calls = 0;
    await assert.rejects(
      loadOrCreateLedger(createLedgerStorage(data.adapter, { key: 'isolated' }), () => {
        calls += 1;
        return fixture();
      }),
    );
    assert.equal(calls, 0);
    assert.equal(data.values.get('isolated'), bytes);
    assert.equal(data.writes.length, 0);
  }
  let calls = 0;
  await assert.rejects(
    loadOrCreateLedger(
      {
        async load() {
          throw new Error('Read failure');
        },
        async save() {
          throw new Error('Must not save');
        },
      },
      () => {
        calls += 1;
        return fixture();
      },
    ),
    /Read failure/,
  );
  assert.equal(calls, 0);
});

test('failed seed persistence and invalid seed data never report successful initialization', async () => {
  let saves = 0;
  const storage = {
    async load() {
      return null;
    },
    async save() {
      saves += 1;
      throw new Error('Storage full');
    },
  };
  await assert.rejects(loadOrCreateLedger(storage, fixture), /Storage full/);
  assert.equal(saves, 1);
  await assert.rejects(
    loadOrCreateLedger(storage, () => ({ version: 999 })),
    /invalid/,
  );
  assert.equal(saves, 1);
});

test('achievement fixture has eight qualifying rules and two explicit pending actions in an isolated clock', () => {
  const scenario = 'achievements-completion';
  assert.throws(() => verificationClock(undefined, scenario), /isolated/);
  assert.equal(verificationClock('isolated', 'report-reconciliation'), null);
  const clock = verificationClock('isolated', scenario);
  const fixture = createVerificationLedger('isolated', scenario);
  assert.equal(fixture.wallet.trackingStartedOn, '2026-10-01');
  assert.equal(fixture.transactions.length, 18);
  assert.equal(totals(fixture).balance, 62600);
  assert.equal(fixture.achievements.awards.length, 0);
  assert.equal(fixture.achievements.completedDays.length, 0);
  assert.equal(fixture.achievements.weeklyReviews.length, 3);
  const initial = reconcileAchievements(fixture, clock);
  assert.equal(initial.newAwards.length, 8);
  let candidate = recordCompletedDay(initial.ledger, '2026-10-31', clock);
  candidate = completeWeeklyReview(candidate, clock);
  const final = reconcileAchievements(candidate, clock);
  assert.equal(final.ledger.achievements.awards.length, 10);
  assert.equal(totals(final.ledger).balance, 62600);
  clock.today = '1900-01-01';
  assert.equal(verificationClock('isolated', scenario).today, '2026-11-02');
});
