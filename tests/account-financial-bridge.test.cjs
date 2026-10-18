const test = require('node:test'),
  assert = require('node:assert/strict');
const { fixture } = require('./helpers/account-bridge-harness.cjs');
const { deferred, flush } = require('./helpers/native-adapter-vm.cjs');

test('initial restore holds the financial lease before SDK initialization and exposes only a confirmed guest', async () => {
  const f = fixture();
  assert.equal(f.visible(), false);
  assert.equal(f.bytes.size, 0);
  const result = await f.runtime.initializeView();
  assert.equal(result.ok, true);
  assert.equal(f.visible(), true);
  assert.ok(f.log.indexOf('photo-suspend') < f.log.indexOf('sdk-initialize'));
  assert.equal(f.controller.getSnapshot().ledger.wallet.name, 'Guest');
  assert.equal(f.mutations, 0);
});
test('guest A B routing preserves guest bytes and each actor gets a separate actual core storage family', async () => {
  const f = fixture();
  await f.runtime.initializeView();
  await f.saveExpense();
  const guestBytes = f.bytes.get(f.keyFor(null));
  assert.equal((await f.signIn('A')).ok, true);
  assert.equal(f.controller.getSnapshot().ledger.transactions.length, 0);
  await f.saveExpense();
  const aBytes = f.bytes.get(f.keyFor('A'));
  assert.equal((await f.runtime.coordinator.signOut()).ok, true);
  assert.equal(f.bytes.get(f.keyFor(null)), guestBytes);
  assert.equal(f.controller.getSnapshot().ledger.transactions.length, 1);
  assert.equal((await f.signIn('B')).ok, true);
  assert.equal(f.controller.getSnapshot().ledger.transactions.length, 0);
  assert.notEqual(f.keyFor('A'), f.keyFor('B'));
  assert.equal(f.bytes.get(f.keyFor('A')), aBytes);
  assert.equal(f.bytes.get(f.keyFor(null)), guestBytes);
});
test('wrong password resumes only the confirmed prior owner after cleanup and does not replay sign in', async () => {
  const f = fixture();
  await f.runtime.initializeView();
  const owner = f.controller.getSnapshot().ownerToken,
    bytes = f.bytes.get(f.keyFor(null));
  const result = await f.signIn('A', 'wrong');
  assert.equal(result.ok, false);
  assert.equal(f.visible(), true);
  assert.equal(f.controller.getSnapshot().ownerToken, owner);
  assert.equal(f.bytes.get(f.keyFor(null)), bytes);
  assert.equal(f.mutations, 1);
  assert.ok(f.log.indexOf('reminder-quiesce') < f.log.indexOf('sdk-sign-in'));
});
test('open financial editor and an in-flight save both refuse SDK mutation before its first effect', async () => {
  const f = fixture();
  await f.runtime.initializeView();
  f.setEditor(true);
  assert.equal((await f.signIn()).ok, false);
  assert.equal(f.mutations, 0);
  f.setEditor(false);
  const work = deferred();
  f.faults.set = async (key) => {
    if (key === f.keyFor(null)) await work.promise;
  };
  const saving = f.saveExpense();
  await flush();
  assert.equal((await f.signIn()).ok, false);
  assert.equal(f.mutations, 0);
  work.resolve();
  assert.equal(await saving, true);
});
test('failed old-owner cancellation retains a lease and explicit reconciliation repairs it without starting rejected login', async () => {
  const f = fixture();
  await f.runtime.initializeView();
  f.setCleanupFailure(true);
  assert.equal((await f.signIn()).pending, true);
  assert.equal(f.mutations, 0);
  assert.equal(f.visible(), false);
  assert.equal(f.controller.getIdentityState().identityPending, true);
  f.setCleanupFailure(false);
  assert.equal((await f.runtime.presentation.retry()).ok, true);
  assert.equal(f.visible(), true);
  assert.equal(f.user, null);
  assert.equal(f.mutations, 0);
});
test('financial write uncertainty requires actual active-store recovery before account retry can release access', async () => {
  const f = fixture();
  await f.runtime.initializeView();
  f.faults.set = async () => {
    throw Error('Synthetic write failure');
  };
  f.faults.get = async () => {
    throw Error('Synthetic read failure');
  };
  assert.equal(await f.saveExpense(), false);
  assert.equal(f.visible(), false);
  assert.equal((await f.signIn()).ok, false);
  assert.equal(f.mutations, 0);
  f.faults.set = null;
  f.faults.get = null;
  assert.equal((await f.runtime.presentation.retry()).ok, true);
  assert.equal(f.visible(), true);
  assert.equal(f.controller.getSnapshot().ledger.transactions.length, 0);
  assert.equal(f.mutations, 0);
});
test('corrupt confirmed target never exposes the old guest and permits separately guarded sign out', async () => {
  const f = fixture();
  await f.runtime.initializeView();
  const guest = f.bytes.get(f.keyFor(null));
  f.bytes.set(f.keyFor('A'), '{bad');
  const result = await f.signIn();
  assert.equal(result.pending, true);
  assert.equal(f.user.uid, 'A');
  assert.equal(f.visible(), false);
  assert.equal(f.runtime.coordinator.getSnapshot().phase, 'wallet-unavailable');
  assert.equal(f.runtime.coordinator.getSnapshot().capabilities.signOut, true);
  assert.equal(f.bytes.get(f.keyFor(null)), guest);
  assert.equal((await f.runtime.coordinator.signOut()).ok, true);
  assert.equal(f.visible(), true);
  assert.equal(f.user, null);
  assert.equal(f.bytes.get(f.keyFor('A')), '{bad');
});
test('unknown target creation never reseeds a missing account key during recovery', async () => {
  const f = fixture();
  await f.runtime.initializeView();
  let writes = 0;
  f.faults.set = async (key) => {
    if (key === f.keyFor('A')) {
      writes++;
      throw Error('Unconfirmed account create');
    }
  };
  f.faults.get = async (key) => {
    if (key === f.keyFor('A') && writes) throw Error('Unknown readback');
  };
  assert.equal((await f.signIn()).pending, true);
  assert.equal(f.visible(), false);
  assert.equal(f.runtime.coordinator.getSnapshot().capabilities.signOut, false);
  f.faults.set = null;
  f.faults.get = null;
  assert.equal((await f.runtime.presentation.retry()).pending, true);
  assert.equal(writes, 1);
  assert.equal(f.bytes.has(f.keyFor('A')), false);
  assert.equal(f.visible(), false);
});
test('target owner activation failure keeps financial presentation blocked until deliberate recovery', async () => {
  const f = fixture();
  await f.runtime.initializeView();
  f.setPhotoFailure('A');
  assert.equal((await f.signIn()).pending, true);
  assert.equal(f.visible(), false);
  assert.equal(f.mutations, 1);
  assert.equal(f.user.uid, 'A');
  assert.equal(f.runtime.coordinator.getSnapshot().capabilities.signOut, false);
  f.setPhotoFailure(false);
  f.refresh();
  assert.equal((await f.runtime.presentation.retry()).ok, true);
  assert.equal(f.visible(), true);
  assert.equal(f.mutations, 1);
});
test('unconfigured provider restores guest only without an SDK or account mutation', async () => {
  const f = fixture({ unconfigured: true });
  assert.equal((await f.runtime.initializeView()).ok, true);
  assert.equal(f.visible(), true);
  assert.equal(f.runtime.presentation.getSnapshot().provider, 'unconfigured');
  assert.equal(f.log.includes('sdk-initialize'), false);
  assert.equal((await f.signIn()).ok, false);
});

test('an SDK result that outlives the root view is reconciled by its successor without repeating login', async () => {
  const work = deferred(),
    f = fixture({ authWork: work.promise });
  await f.runtime.initializeView();
  const pending = f.signIn('A');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.mutations, 1);
  f.detach();
  work.resolve();
  assert.equal((await pending).pending, true);
  assert.equal(f.user.uid, 'A');
  assert.equal(f.visible(), false);
  f.attach();
  assert.equal((await f.runtime.initializeView()).ok, true);
  assert.equal(f.visible(), true);
  assert.equal(f.controller.getSnapshot().family.actor.uid, 'A');
  assert.equal(f.mutations, 1);
});

test('same-family reset stays hidden until exact replacement owner activation is observed', async () => {
  const f = fixture();
  await f.runtime.initializeView();
  const before = f.controller.getSnapshot();
  const model = require('../src/core/model'),
    replacement = model.createEmptyLedger(
      { name: 'Fresh' },
      {
        clock: { today: '2026-10-18', nowMs: Date.UTC(2026, 9, 18) },
        newIncarnationId: () => 'replacement-owner',
      },
    );
  f.controller.registerTransitionGuard(before.bindingToken, {
    async prepare() {
      return { ok: true, pending: false };
    },
    async resume() {
      return { ok: true, pending: false };
    },
  });
  assert.equal(await f.binding.ledger.save(replacement, 'Fresh'), true);
  assert.equal(f.visible(), false);
  const actual = f.controller.getIdentityState(),
    target = {
      family: actual.family,
      owner: { ...actual.family, incarnationId: actual.ledger.wallet.incarnationId },
      ownerToken: actual.ownerToken,
      ledger: actual.ledger,
      storage: actual.storage,
    };
  assert.equal(await f.runtime.bridge.confirmCommittedOwner(target, () => true), true);
  assert.equal(f.runtime.coordinator.observeCommittedWallet(actual.family, actual.ledger), true);
  assert.equal(f.visible(), true);
  assert.notEqual(actual.ownerToken, before.ownerToken);
});

test('a target reminder-store load failure is retried through initialize before owner activation can recover', async () => {
  const f = fixture();
  await f.runtime.initializeView();
  f.setReminderFailure('A');
  assert.equal((await f.signIn()).pending, true);
  assert.equal(f.visible(), false);
  assert.equal(f.user.uid, 'A');
  f.setReminderFailure(false);
  assert.equal((await f.runtime.presentation.retry()).ok, true);
  assert.equal(f.visible(), true);
  assert.ok(f.log.includes('reminder-store-recheck'));
  assert.equal(f.mutations, 1);
});

test('a synchronous transient-view cleanup exception cannot strand a lease outside coordinator recovery', async () => {
  const f = fixture();
  await f.runtime.initializeView();
  f.setCloseFailure(true);
  assert.equal((await f.signIn()).pending, true);
  assert.equal(f.controller.getIdentityState().identityPending, true);
  assert.equal(f.mutations, 0);
  f.setCloseFailure(false);
  assert.equal((await f.runtime.presentation.retry()).ok, true);
  assert.equal(f.visible(), true);
  assert.equal(f.mutations, 0);
});

test('configured but unavailable SDK binding keeps identity unknown and never seeds a guest fallback', async () => {
  const f = fixture({ enabledMissingSdk: true }),
    runtime = f.appModule.getAccountAppRuntime();
  runtime.bridge.bind(f.binding);
  assert.equal((await runtime.initializeView()).pending, true);
  assert.equal(runtime.coordinator.getSnapshot().phase, 'session-unavailable');
  assert.equal(runtime.coordinator.getSnapshot().recovery, 'restart');
  assert.equal(runtime.presentation.getSnapshot().provider, 'configured');
  assert.equal(runtime.presentation.getSnapshot().busy, false);
  assert.equal(f.bytes.size, 0);
});

test('explicit draft discard allows a refused session recheck to recover without changing saved records', async () => {
  const f = fixture();
  await f.runtime.initializeView();
  const bytes = f.bytes.get(f.keyFor(null));
  f.setEditor(true);
  assert.equal((await f.runtime.presentation.retry()).pending, true);
  assert.equal((await f.runtime.presentation.retry()).pending, true);
  assert.equal(f.visible(), false);
  assert.equal(f.controller.getIdentityState().identityPending, false);
  f.setEditor(false);
  assert.equal((await f.runtime.presentation.retry()).ok, true);
  assert.equal(f.visible(), true);
  assert.equal(f.bytes.get(f.keyFor(null)), bytes);
  assert.equal(f.mutations, 0);
});
