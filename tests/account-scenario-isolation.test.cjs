const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const {
  hostWithStores,
  loadSource,
  ledger,
  model,
  identity,
  achievements,
} = require('./helpers/account-hook-harness.cjs');
const storageCore = require('../src/core/storage'),
  runtimeCore = require('../src/ui/ledgerRuntime'),
  fixtures = require('../src/verification/fixtures');
function fixture(env) {
  const host = hostWithStores();
  host.react.useLayoutEffect = host.react.useEffect;
  const original = JSON.stringify(ledger('Preexisting canonical wallet')),
    data = new Map([[storageCore.STORAGE_KEY, original]]),
    calls = { reads: [], writes: [], removes: [] };
  const adapter = {
    async getItem(key) {
      calls.reads.push(key);
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      calls.writes.push(key);
      data.set(key, value);
    },
    async removeItem(key) {
      calls.removes.push(key);
      data.delete(key);
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
  const render = (options = { deferInitialRestore: true }) =>
    host.render(() => hook.useLedger(options));
  const account = () => {
    const bridge = loadSource(
      path.join(__dirname, '../src/accounts/financialBridge.ts'),
      {},
      { setTimeout, clearTimeout },
    );
    const presentation = loadSource(
      path.join(__dirname, '../src/accounts/accountPresentation.ts'),
      { './identity': identity, '../core/model': model },
    );
    const module = loadSource(
      path.join(__dirname, '../src/accounts/appRuntime.ts'),
      {
        '@react-native-async-storage/async-storage': adapter,
        './coordinator': require('../src/accounts/coordinator'),
        './familyStorage': require('../src/accounts/familyStorage'),
        './profileStore': require('../src/accounts/profileStore'),
        './identity': identity,
        './financialBridge': bridge,
        './accountPresentation': presentation,
        '../ui/useLedger': hook,
      },
      { process: { env } },
    );
    const runtime = module.getAccountAppRuntime(),
      view = render(runtime.ledgerOptions);
    runtime.bridge.bind({
      ledger: view,
      photos: {},
      reminders: {},
      hasOpenEditor: () => false,
      closeEditor() {
        throw Error('Invalid configuration must refuse before view side effects');
      },
      closeExports() {
        throw Error('Invalid configuration must refuse before export side effects');
      },
    });
    return runtime;
  };
  return { host, hook, data, original, calls, render, account };
}
test('scenario without namespace rejects before reading a preexisting canonical wallet or acquiring an identity lease', async () => {
  const f = fixture({ EXPO_PUBLIC_TEST_SCENARIO: 'report-reconciliation' }),
    view = f.render();
  assert.equal(view.acquireIdentityLease().ok, false);
  assert.equal(await f.render().restore(), false);
  assert.equal(f.render().loadError, true);
  assert.deepEqual(f.calls, { reads: [], writes: [], removes: [] });
  assert.equal(f.data.get(storageCore.STORAGE_KEY), f.original);
  f.host.unmount();
});
test('default account coordinator and direct target store both reject invalid fixture configuration before any storage access', async () => {
  const f = fixture({ EXPO_PUBLIC_TEST_SCENARIO: 'report-reconciliation' }),
    runtime = f.account();
  const result = await runtime.initializeView();
  assert.equal(result.ok, false);
  await assert.rejects(
    runtime
      .storageForFamily({
        scope: { kind: 'canonical' },
        actor: { kind: 'firebase', uid: 'synthetic-A' },
      })
      .load(),
    /isolated test data namespace/,
  );
  assert.deepEqual(f.calls, { reads: [], writes: [], removes: [] });
  assert.equal(f.data.get(storageCore.STORAGE_KEY), f.original);
  assert.notEqual(runtime.presentation.getSnapshot().phase, 'ready');
  f.host.unmount();
});
test('unknown scenario with a namespace rejects before reading even an isolated saved store', async () => {
  const f = fixture({
    EXPO_PUBLIC_TEST_DATA_NAMESPACE: 'scenario-isolation',
    EXPO_PUBLIC_TEST_SCENARIO: 'unknown',
  });
  f.data.set(
    '@mymoney/test/scenario-isolation/v5',
    JSON.stringify(ledger('Saved isolated wallet')),
  );
  assert.equal(await f.render().restore(), false);
  assert.equal(f.render().loadError, true);
  assert.deepEqual(f.calls, { reads: [], writes: [], removes: [] });
  f.host.unmount();
});
test('valid isolated configuration and ordinary guest restoration retain their intended storage paths', async () => {
  const isolated = fixture({
    EXPO_PUBLIC_TEST_DATA_NAMESPACE: 'scenario-isolation',
    EXPO_PUBLIC_TEST_SCENARIO: 'report-reconciliation',
  });
  assert.equal(await isolated.render().restore(), true);
  assert.equal(isolated.render().ledger.transactions.length, 10);
  assert.ok(isolated.calls.reads.length > 0);
  assert.ok(
    isolated.calls.reads.every((key) => key.startsWith('@mymoney/test/scenario-isolation/')),
  );
  assert.ok(
    isolated.calls.writes.every((key) => key.startsWith('@mymoney/test/scenario-isolation/')),
  );
  assert.equal(isolated.data.get(storageCore.STORAGE_KEY), isolated.original);
  isolated.host.unmount();
  const ordinary = fixture({});
  assert.equal(await ordinary.render().restore(), true);
  assert.equal(ordinary.render().ledger.wallet.name, 'Preexisting canonical wallet');
  assert.deepEqual(ordinary.calls.reads, [storageCore.STORAGE_KEY]);
  ordinary.host.unmount();
});
