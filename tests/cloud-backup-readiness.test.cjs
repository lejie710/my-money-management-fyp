const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const { createHookHost } = require('./helpers/hook-host.cjs'),
  { loadSource } = require('./helpers/account-hook-harness.cjs'),
  { createBackupCoordinator } = require('../src/cloud/backupCoordinator'),
  model = require('../src/core/model');
const family = {
    scope: { kind: 'test', namespace: 'backup-ready-hook' },
    actor: { kind: 'firebase-hosted', projectId: 'demo-backup-ready', uid: 'same-account' },
  },
  bindingToken = {};
const ledger = model.createEmptyLedger(
  {},
  {
    clock: { today: '2026-10-19', nowMs: Date.UTC(2026, 9, 19) },
    newIncarnationId: () => 'same-wallet',
  },
);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
function fixture(active) {
  const host = createHookHost(),
    data = new Map(),
    calls = { uploads: 0, reads: 0 },
    faults = { read: null };
  const storage = {
    async getItem(key) {
      calls.reads++;
      if (faults.read) await faults.read();
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      data.set(key, value);
    },
    async removeItem(key) {
      data.delete(key);
    },
  };
  const runtime = {
    presentation: { getSnapshot: () => ({ viewToken: 'unchanged-session' }) },
    cloud: {
      configuration: { firebase: { projectId: family.actor.projectId }, mode: 'emulator' },
      error: '',
      getSdkContext: () => ({}),
    },
    storageForFamily: () => ({ readCurrent: async () => null }),
  };
  const module = loadSource(path.join(__dirname, '../src/ui/useCloudBackup.ts'), {
    react: host.react,
    '@react-native-async-storage/async-storage': storage,
    '../accounts/appRuntime': { getAccountAppRuntime: () => runtime },
    '../cloud/backupCoordinator': { createBackupCoordinator },
    '../cloud/firebasePorts': { createFirebasePorts: () => ({}) },
    '../cloud/transport': {
      createCloudTransport: () => ({
        async backup() {
          calls.uploads++;
          return {};
        },
      }),
    },
    '../cloud/nativeFiles': { createBackupFileServices: () => ({}) },
  });
  const identity = {
    family,
    ledger,
    ownerToken: 'same-owner-token',
    bindingToken,
    identityPending: false,
    writeInFlight: false,
    uncertain: false,
  };
  const options = {
    finance: {
      ownerToken: identity.ownerToken,
      bindingToken,
      getIdentityState: () => identity,
      compareAndSave: async () => {
        throw Error('No financial save is expected');
      },
    },
    accountState: { viewToken: 'unchanged-session', busy: false, service: 'available' },
    active,
    hasOpenEditor: () => false,
  };
  const render = () => host.render(() => module.useCloudBackup(options));
  return { options, identity, render, calls, faults, data };
}
test('actual backup hook refreshes readiness-only setup after mount confirmation with unchanged owner/session/binding', () => {
  const f = fixture(false),
    first = f.render().controller;
  assert.equal(first.getSnapshot().setup.signedIn, false);
  f.options.active = true;
  const second = f.render().controller;
  assert.equal(second, first);
  assert.equal(second.getSnapshot().setup.signedIn, true);
  assert.equal(f.calls.uploads, 0);
  assert.equal(f.calls.reads, 0);
  assert.equal(second.getSnapshot(), second.getSnapshot());
});
test('synchronous readiness loss retires preview permanently before effects, including false-to-true on the same identity', async () => {
  const f = fixture(true),
    controller = f.render().controller;
  assert.equal(await controller.previewBackup(false), true);
  assert.ok(controller.getSnapshot().preview);
  f.options.active = false;
  const blocked = controller.getSnapshot();
  assert.equal(blocked.setup.signedIn, false);
  assert.equal(blocked.preview, null);
  f.options.active = true;
  const ready = controller.getSnapshot();
  assert.equal(ready.setup.signedIn, true);
  assert.equal(ready.preview, null);
  assert.equal(await controller.confirmBackup(), false);
  assert.equal(f.calls.uploads, 0);
  assert.equal(f.data.size, 0);
});
test('a delayed preview cannot publish after readiness is lost and regained with the same financial identity', async () => {
  const f = fixture(true),
    controller = f.render().controller,
    gate = deferred();
  f.faults.read = () => gate.promise;
  const pending = controller.previewBackup(false);
  try {
    f.options.active = false;
    f.render();
    f.options.active = true;
    f.render();
    gate.resolve();
    assert.equal(await pending, false);
    assert.equal(controller.getSnapshot().setup.signedIn, true);
    assert.equal(controller.getSnapshot().preview, null);
    assert.equal(f.calls.uploads, 0);
    assert.equal(f.data.size, 0);
  } finally {
    gate.resolve();
    await pending;
  }
});
