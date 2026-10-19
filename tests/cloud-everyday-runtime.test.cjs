const test = require('node:test'),
  assert = require('node:assert/strict');
const { fixture } = require('./helpers/account-bridge-harness.cjs');
const { decodeRecord } = require('../src/cloud/everydayFormat');
const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));
const configuration = {
  mode: 'emulator',
  firebase: {
    projectId: 'demo-runtime-wallet',
    apiKey: 'demo-only-key',
    authDomain: 'demo-runtime-wallet.firebaseapp.com',
    appId: 'demo-app',
    storageBucket: 'demo-runtime-wallet.appspot.com',
  },
  emulators: { auth: 19099, firestore: 18080, storage: 19199 },
};
function cloud() {
  const accounts = new Map();
  const faults = { online: true, unknown: false },
    calls = { commits: 0 };
  const createCloudPorts = (getContext, owner) => {
    let state = accounts.get(owner.uid);
    if (!state) {
      state = { record: null, receipts: new Map() };
      accounts.set(owner.uid, state);
    }
    const current = () => {
      assert.equal(getContext().uid, owner.uid);
      if (!faults.online) throw Error('offline');
    };
    return {
      async readWallet() {
        current();
        return clone(state.record);
      },
      async readOperation(_, id) {
        current();
        return clone(state.receipts.get(id) ?? null);
      },
      async commitWallet(_, plan) {
        current();
        calls.commits++;
        if (faults.unknown) throw Error('unknown submitted');
        assert.equal(plan.baseRevision, state.record?.revision ?? 0);
        assert.equal(plan.baseHash, state.record?.payloadHash ?? null);
        state.record = clone(plan.record);
        state.receipts.set(plan.record.operationId, {
          version: 1,
          ownerUid: owner.uid,
          operationId: plan.record.operationId,
          revision: plan.record.revision,
          payloadHash: plan.record.payloadHash,
        });
        return clone(state.record);
      },
    };
  };
  return {
    accounts,
    faults,
    calls,
    options: { cloudConfiguration: configuration, createCloudPorts },
  };
}
test('actual app runtime routes configured account saves to cloud while preserving guest and old local account bytes', async () => {
  const c = cloud(),
    f = fixture(c.options);
  assert.equal((await f.runtime.initializeView()).ok, true);
  await f.saveExpense();
  const guest = f.bytes.get(f.keyFor(null));
  const oldFamily = f.ownerFor('A');
  const oldStore = f.runtime.localStorageForFamily(oldFamily);
  const oldLedger = require('./helpers/account-hook-harness.cjs').ledger(
    'Previous device wallet',
    'previous-local',
  );
  await oldStore.save(oldLedger);
  const oldBytes = f.bytes.get(oldStore.key);
  assert.equal((await f.signIn('A')).ok, true);
  assert.equal(f.visible(), true);
  assert.equal(f.controller.getIdentityState().storage.kind, 'firebase-live');
  assert.equal(f.controller.getSnapshot().ledger.transactions.length, 0);
  assert.equal(f.bytes.get(oldStore.key), oldBytes);
  assert.equal(await f.saveExpense(), true);
  assert.equal(
    decodeRecord(c.accounts.get('A').record, {
      projectId: configuration.firebase.projectId,
      uid: 'A',
    }).ledger.transactions.length,
    1,
  );
  const binding = f.runtime.getAuthenticatedServiceBinding();
  assert.equal(binding.isCurrent(), true);
  assert.equal(await binding.getIdToken(), 'synthetic-token');
  assert.equal(typeof binding.viewToken, 'string');
  assert.equal((await f.runtime.coordinator.signOut()).ok, true);
  assert.equal(binding.isCurrent(), false);
  assert.equal(f.bytes.get(f.keyFor(null)), guest);
  assert.equal(f.bytes.get(oldStore.key), oldBytes);
  assert.equal(f.controller.getIdentityState().storage.kind, undefined);
});
test('fresh app runtime with confirmed cached identity opens only the last confirmed account wallet offline', async () => {
  const c = cloud(),
    first = fixture(c.options);
  await first.runtime.initializeView();
  assert.equal((await first.signIn('A')).ok, true);
  await first.saveExpense();
  const confirmed = clone(first.controller.getSnapshot().ledger),
    commits = c.calls.commits;
  first.detach();
  c.faults.online = false;
  const second = fixture({
    ...c.options,
    bytes: first.bytes,
    initialUser: { uid: 'A', email: 'A@example.test', displayName: null },
  });
  assert.equal((await second.runtime.initializeView()).ok, true);
  assert.equal(second.visible(), true);
  assert.deepEqual(second.controller.getSnapshot().ledger, confirmed);
  assert.equal(second.controller.getIdentityState().storage.getSnapshot().status, 'offline');
  assert.equal(c.calls.commits, commits);
  assert.equal(second.controller.getIdentityState().storage.isReadOnly(), true);
});
test('initial cloud creation with unconfirmed dispatch remains gated and explicit same-operation recovery activates it', async () => {
  const c = cloud(),
    f = fixture(c.options);
  await f.runtime.initializeView();
  const guest = f.bytes.get(f.keyFor(null));
  c.faults.unknown = true;
  assert.equal((await f.signIn('A')).ok, false);
  assert.equal(f.visible(), false);
  assert.equal(f.runtime.coordinator.getSnapshot().phase, 'wallet-unavailable');
  const store = f.runtime.everydayStorageForFamily(f.ownerFor('A')),
    draft = await store.readDraft();
  assert.equal(draft.phase, 'submitted');
  c.faults.unknown = false;
  assert.equal((await f.runtime.coordinator.retryCloudDraft(draft.operationId)).ok, true);
  assert.equal(f.visible(), true);
  assert.equal(f.controller.getIdentityState().family.actor.uid, 'A');
  assert.equal(await store.readDraft(), null);
  assert.equal(f.bytes.get(f.keyFor(null)), guest);
});
test('active unconfirmed cloud save blocks identity changes until runtime retry confirms the same operation', async () => {
  const c = cloud(),
    f = fixture(c.options);
  await f.runtime.initializeView();
  await f.signIn('A');
  c.faults.unknown = true;
  assert.equal(await f.saveExpense(), false);
  assert.equal(f.controller.getIdentityState().uncertain, true);
  const store = f.runtime.everydayStorageForFamily(f.ownerFor('A')),
    draft = await store.readDraft();
  assert.equal((await f.runtime.coordinator.signOut()).ok, false);
  assert.equal(f.user.uid, 'A');
  c.faults.unknown = false;
  assert.equal(await f.controller.retryCloudDraft(draft.operationId), true);
  assert.equal(f.controller.getIdentityState().uncertain, false);
  assert.equal(f.controller.getSnapshot().ledger.transactions.length, 1);
  assert.equal(await store.readDraft(), null);
});

function backupFor(f, source, delayStage) {
  const { createBackupCoordinator } = require('../src/cloud/backupCoordinator'),
    { makeSnapshot } = require('../src/cloud/backupFormat');
  const calls = { stages: 0, closed: 0, saves: 0 };
  let serial = 0;
  const owner = { projectId: configuration.firebase.projectId, uid: 'A' };
  const snapshot = makeSnapshot({
    ledger: source,
    owner,
    id: 'backup-everyday-restore-0123456789',
    createdAtMs: 1000,
  });
  const controller = createBackupCoordinator({
    getBinding() {
      const live = f.controller.getIdentityState();
      return {
        ...live,
        allowed: !live.identityPending && !live.writeInFlight && !live.uncertain,
        compareAndSave(...args) {
          calls.saves++;
          return f.controller.compareAndSave(...args);
        },
      };
    },
    getSetup: () => ({
      configured: true,
      signedIn: true,
      projectId: owner.projectId,
      mode: 'emulator',
      error: '',
      sessionToken: f.runtime.presentation.getSnapshot().viewToken,
    }),
    readGuest: async () => ({ family: f.ownerFor(null), ledger: source }),
    storage: f.storage,
    transportFor: () => ({
      async download() {
        return snapshot;
      },
    }),
    now: () => 1000,
    newId: (kind) => kind + '-restore-test-' + ++serial,
    files: {
      async stage() {
        calls.stages++;
        if (delayStage) await delayStage();
        return {
          refs: {},
          async close() {
            calls.closed++;
            return { pending: false };
          },
        };
      },
    },
  });
  controller.ownerChanged();
  return { controller, calls };
}
test('manual backup restore still confirms an empty live cloud target and the old guest-copy API cannot upload', async () => {
  const c = cloud(),
    f = fixture(c.options);
  await f.runtime.initializeView();
  await f.saveExpense();
  const guestBytes = f.bytes.get(f.keyFor(null)),
    source = clone(f.controller.getSnapshot().ledger);
  await f.signIn('A');
  const live = f.controller.getSnapshot();
  f.controller.registerTransitionGuard(live.bindingToken, {
    async prepare() {
      return { ok: true, pending: false };
    },
    async resume() {
      return { ok: true, pending: false };
    },
  });
  const backup = backupFor(f, source);
  assert.equal(await backup.controller.previewGuestCopy(false), false);
  assert.equal(backup.calls.saves, 0);
  assert.equal(c.calls.commits, 1);
  assert.equal(await backup.controller.previewRestore({}), true);
  assert.equal(c.calls.commits, 1);
  assert.equal(await backup.controller.confirmRestore(), true);
  assert.equal(c.calls.commits, 2);
  assert.equal(f.controller.getSnapshot().ledger.transactions.length, 1);
  assert.notEqual(
    f.controller.getSnapshot().ledger.wallet.incarnationId,
    source.wallet.incarnationId,
  );
  assert.equal(f.bytes.get(f.keyFor(null)), guestBytes);
  assert.equal(
    decodeRecord(c.accounts.get('A').record, {
      projectId: configuration.firebase.projectId,
      uid: 'A',
    }).ledger.transactions.length,
    1,
  );
  assert.equal(backup.calls.closed, 1);
  assert.equal(await backup.controller.previewRestore({}), false);
  assert.equal(c.calls.commits, 2);
});
test('manual restore delayed photo preparation cannot outlive a real same-owner financial restoration', async () => {
  const c = cloud(),
    f = fixture(c.options);
  await f.runtime.initializeView();
  await f.saveExpense();
  const source = clone(f.controller.getSnapshot().ledger);
  await f.signIn('A');
  const before = f.controller.getSnapshot();
  f.controller.registerTransitionGuard(before.bindingToken, {
    async prepare() {
      return { ok: true, pending: false };
    },
    async resume() {
      return { ok: true, pending: false };
    },
  });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const backup = backupFor(f, source, () => gate);
  assert.equal(await backup.controller.previewRestore({}), true);
  const pending = backup.controller.confirmRestore();
  assert.equal(await f.controller.restore(before.bindingToken, before.ownerToken), true);
  assert.notEqual(f.controller.getSnapshot().bindingToken, before.bindingToken);
  backup.controller.ownerChanged();
  release();
  assert.equal(await pending, false);
  assert.equal(backup.calls.saves, 0);
  assert.equal(backup.calls.closed, 1);
  assert.equal(f.controller.getSnapshot().ledger.transactions.length, 0);
  assert.equal(c.calls.commits, 1);
  assert.equal(backup.controller.getSnapshot().preview, null);
});
