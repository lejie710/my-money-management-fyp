const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const {
  hostWithStores,
  loadSource,
  model,
  identity,
  achievements,
  clock,
} = require('./helpers/account-hook-harness.cjs');
const storageCore = require('../src/core/storage'),
  runtimeCore = require('../src/ui/ledgerRuntime'),
  fixtures = require('../src/verification/fixtures');

function firstLaunch({ env = {}, data = new Map(), failRead = false } = {}) {
  const host = hostWithStores(),
    calls = { reads: [], writes: [] };
  const adapter = {
    async getItem(key) {
      calls.reads.push(key);
      if (failRead) throw Error('Device storage is unavailable');
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      calls.writes.push(key);
      data.set(key, value);
    },
  };
  const hook = loadSource(
    path.join(__dirname, '../src/ui/useLedger.ts'),
    {
      react: host.react,
      '@react-native-async-storage/async-storage': adapter,
      '../core/model': model,
      '../core/storage': storageCore,
      '../core/achievements': achievements,
      '../verification/fixtures': fixtures,
      '../accounts/identity': identity,
      './ledgerRuntime': runtimeCore,
    },
    { process: { env }, console: { info() {} } },
  );
  const options = { deferInitialRestore: true, getClock: clock };
  return {
    host,
    calls,
    data,
    render: () => host.render(() => hook.useLedger(options)),
  };
}

test('ordinary first launch creates one empty local wallet and restores it unchanged on restart', async () => {
  const f = firstLaunch();
  assert.equal(await f.render().restore(), true);
  const { ledger, status } = f.render();
  assert.equal(ledger.mode, 'local');
  assert.equal(ledger.wallet.name, 'My personal wallet');
  assert.equal(ledger.wallet.currency, 'MYR');
  assert.equal(ledger.wallet.hasTransactionHistory, false);
  assert.deepEqual(ledger.transactions, []);
  assert.deepEqual(ledger.budgets, []);
  assert.equal(ledger.goal, null);
  assert.deepEqual(model.totals(ledger), { income: 0, expense: 0, debt: 0, balance: 0 });
  assert.equal(status, 'Your wallet is ready.');
  assert.deepEqual(f.calls.writes, [storageCore.STORAGE_KEY]);
  const saved = f.data.get(storageCore.STORAGE_KEY);
  f.host.unmount();
  const restarted = firstLaunch({ data: f.data });
  assert.equal(await restarted.render().restore(), true);
  assert.equal(JSON.stringify(restarted.render().ledger), saved);
  assert.deepEqual(restarted.calls.writes, []);
  restarted.host.unmount();
});

test('first launch preserves existing local and sample wallets byte for byte', async () => {
  for (const mode of ['local', 'sample']) {
    const existing = achievements.reconcileAchievements(
      { ...model.createDemoLedger(new Date(2026, 9, 18)), mode },
      clock(),
    ).ledger;
    const raw = JSON.stringify(existing, null, 2),
      data = new Map([[storageCore.STORAGE_KEY, raw]]),
      f = firstLaunch({ data });
    assert.equal(await f.render().restore(), true);
    assert.deepEqual(f.render().ledger, existing);
    assert.equal(data.get(storageCore.STORAGE_KEY), raw);
    assert.deepEqual(f.calls.writes, []);
    f.host.unmount();
  }
});

test('a retained v4 sample wallet migrates with its records instead of receiving the new empty default', async () => {
  const previous = { ...model.createDemoLedger(new Date(2026, 9, 18)), version: 4 },
    raw = JSON.stringify(previous, null, 2),
    data = new Map([[storageCore.PREVIOUS_STORAGE_KEY, raw]]),
    f = firstLaunch({ data });
  assert.equal(await f.render().restore(), true);
  assert.equal(f.render().ledger.version, 5);
  assert.equal(f.render().ledger.mode, 'sample');
  assert.deepEqual(f.render().ledger.transactions, previous.transactions);
  assert.deepEqual(f.render().ledger.wallet, previous.wallet);
  assert.equal(data.get(storageCore.PREVIOUS_STORAGE_KEY), raw);
  assert.deepEqual(f.calls.writes, [storageCore.STORAGE_KEY]);
  f.host.unmount();
});

test('corrupt or unreadable saved stores never turn into a fresh empty wallet', async () => {
  for (const options of [
    { data: new Map([[storageCore.STORAGE_KEY, 'invalid saved JSON']]) },
    { data: new Map([[storageCore.PREVIOUS_STORAGE_KEY, 'invalid legacy JSON']]) },
    { failRead: true },
  ]) {
    const f = firstLaunch(options),
      original = [...f.data];
    assert.equal(await f.render().restore(), false);
    assert.equal(f.render().loadError, true);
    assert.equal(f.render().ledger, null);
    assert.deepEqual([...f.data], original);
    assert.deepEqual(f.calls.writes, []);
    f.host.unmount();
  }
});

test('a missing store after confirmed startup blocks recovery without silently reseeding', async () => {
  const f = firstLaunch();
  assert.equal(await f.render().restore(), true);
  const incarnation = f.render().ledger.wallet.incarnationId;
  f.data.delete(storageCore.STORAGE_KEY);
  assert.equal(await f.render().restore(), false);
  assert.equal(f.render().loadError, true);
  assert.equal(f.render().ledger.wallet.incarnationId, incarnation);
  assert.equal(f.data.has(storageCore.STORAGE_KEY), false);
  assert.deepEqual(f.calls.writes, [storageCore.STORAGE_KEY]);
  f.host.unmount();
});

test('explicit verification scenarios retain their records and remain isolated from the ordinary wallet', async () => {
  const raw = JSON.stringify(model.createEmptyLedger()),
    data = new Map([[storageCore.STORAGE_KEY, raw]]),
    f = firstLaunch({
      data,
      env: {
        EXPO_PUBLIC_TEST_DATA_NAMESPACE: 'first-launch-fixture',
        EXPO_PUBLIC_TEST_SCENARIO: 'health-goal',
      },
    });
  assert.equal(await f.render().restore(), true);
  assert.equal(f.render().ledger.mode, 'sample');
  assert.equal(f.render().ledger.transactions.length, 10);
  assert.equal(f.render().ledger.goal.targetMinor, 400000);
  assert.equal(data.get(storageCore.STORAGE_KEY), raw);
  assert.deepEqual(f.calls.writes, ['@mymoney/test/first-launch-fixture/v5']);
  assert.ok(f.calls.reads.every((key) => key.startsWith('@mymoney/test/first-launch-fixture/')));
  f.host.unmount();
});
