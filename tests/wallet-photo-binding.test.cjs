const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHookHost, loadTsSource } = require('./helpers/hook-host.cjs');
const { deferred, flush } = require('./helpers/native-adapter-vm.cjs');
const context = require('../src/core/transactionContext');
const success = { pending: false, message: '' };
const failed = { pending: true, message: 'Retired binding result' };

function fixture() {
  const host = createHookHost(),
    managers = [];
  host.react.useMemo = (factory, deps) => {
    const ref = host.react.useRef(null);
    if (!ref.current || deps.some((value, index) => !Object.is(value, ref.current.deps[index])))
      ref.current = { deps, value: factory() };
    return ref.current.value;
  };
  let ledger = { wallet: { incarnationId: 'wallet-test' }, transactions: [] },
    active = true;
  const module = loadTsSource(path.join(__dirname, '../src/ui/useWalletPhotos.ts'), {
    react: host.react,
    '@react-native-async-storage/async-storage': {},
    '../core/transactionContext': context,
    '../reminders/store': require('../src/reminders/store'),
    '../attachments/photoManager': {
      photoFamilyToken: () => 'test/local/photo-family',
      createPhotoManager() {
        const init = deferred(),
          retry = deferred(),
          cleanup = deferred();
        const manager = {
          init,
          retry,
          cleanup,
          disposed: 0,
          retries: 0,
          initialize: () => init.promise,
          retryCleanup() {
            manager.retries++;
            return retry.promise;
          },
          queueCleanup: () => cleanup.promise,
          dispose() {
            manager.disposed++;
          },
        };
        managers.push(manager);
        return manager;
      },
    },
    '../attachments/photoFiles': { createPhotoFileAdapter: () => ({}) },
    '../attachments/services': { createContextServices: () => ({}) },
    './useLedger': {
      localLedgerScope: { kind: 'test', namespace: 'photo-binding' },
      localLedgerFamily: {
        scope: { kind: 'test', namespace: 'photo-binding' },
        actor: { kind: 'local' },
      },
      localLedgerStorage: {},
    },
  });
  return {
    host,
    managers,
    render: () => host.render(() => module.useWalletPhotos(ledger, active)),
    setActive(value) {
      active = value;
    },
    setLedger(value) {
      ledger = value;
    },
  };
}

test('old retry success or rejection cannot publish after same-owner disable/re-enable', async () => {
  for (const reject of [false, true]) {
    const f = fixture();
    f.render();
    f.managers[0].init.resolve(success);
    await flush();
    const old = f.render();
    const retry = old.retry();
    f.setActive(false);
    f.render();
    f.setActive(true);
    f.render();
    f.managers[1].init.resolve(success);
    await flush();
    assert.equal(f.render().pending, false);
    if (reject) f.managers[0].retry.reject(Error('Old retry failed'));
    else f.managers[0].retry.resolve(failed);
    await retry;
    const current = f.render();
    assert.equal(current.pending, false);
    assert.equal(current.message, '');
    assert.equal(f.managers[0].disposed, 1);
    assert.equal(f.managers[1].disposed, 0);
  }
});

test('old editor cleanup callback and old retry function are inert after a new same-owner binding', async () => {
  const f = fixture();
  f.render();
  f.managers[0].init.resolve(success);
  await flush();
  const old = f.render();
  f.setActive(false);
  f.render();
  old.onCleanupMessage('wallet-test', 'Inactive editor cleanup');
  assert.equal(f.render().pending, false);
  f.setActive(true);
  f.render();
  f.managers[1].init.resolve(success);
  await flush();
  old.onCleanupMessage('wallet-test', 'Retired editor cleanup');
  await old.retry();
  let current = f.render();
  assert.equal(current.pending, false);
  assert.equal(f.managers[0].retries, 0);
  current.onCleanupMessage('wallet-test', 'Current editor cleanup');
  current = f.render();
  assert.equal(current.pending, true);
  assert.equal(current.message, 'Current editor cleanup');
});

test('old initialization and Strict Mode replay do not overwrite the current binding', async () => {
  const f = fixture();
  f.render();
  f.host.replayEffects();
  f.render();
  assert.equal(f.managers.length, 2);
  f.managers[1].init.resolve(success);
  await flush();
  f.managers[0].init.resolve(failed);
  await flush();
  assert.equal(f.render().pending, false);
  assert.equal(f.render().message, '');
  assert.equal(f.managers[0].disposed, 1);
});

test('ordinary saves keep the manager binding stable and old cleanup cannot publish after a remount', async () => {
  const f = fixture();
  const photo = {
    id: 'photo-one',
    fileName: 'photo-one.png',
    ownerIncarnationId: 'wallet-test',
    mimeType: 'image/png',
    width: 1,
    height: 1,
    byteSize: 80,
  };
  f.setLedger({
    wallet: { incarnationId: 'wallet-test' },
    transactions: [{ context: { notes: '', photo, withPerson: null, location: null } }],
  });
  f.render();
  f.managers[0].init.resolve(success);
  await flush();
  f.setLedger({ wallet: { incarnationId: 'wallet-test' }, transactions: [] });
  f.render();
  assert.equal(f.managers.length, 1);
  f.setActive(false);
  f.render();
  f.setActive(true);
  f.render();
  f.managers[1].init.resolve(success);
  await flush();
  f.managers[0].cleanup.resolve(failed);
  await flush();
  assert.equal(f.render().pending, false);
});
