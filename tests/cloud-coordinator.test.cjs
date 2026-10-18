const test = require('node:test'),
  assert = require('node:assert/strict');
const model = require('../src/core/model'),
  { createBackupCoordinator } = require('../src/cloud/backupCoordinator'),
  { makeSnapshot } = require('../src/cloud/backupFormat'),
  { encodeReminderOwner } = require('../src/reminders/store');
const clone = (v) => JSON.parse(JSON.stringify(v));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
function money() {
  let value = model.createEmptyLedger({ name: 'Guest source' });
  return model.saveTransaction(
    value,
    model.transactionFromDraft(
      {
        type: 'expense',
        title: 'Food',
        amount: '12.50',
        date: '2026-10-18',
        categoryId: 'expense-food',
      },
      'food-one',
      value,
    ),
  );
}
function fixture() {
  const scope = { kind: 'test', namespace: 'cloud-coordinator' },
    family = {
      scope,
      actor: { kind: 'firebase-hosted', projectId: 'demo-money-backup', uid: 'account-a' },
    },
    guest = { family: { scope, actor: { kind: 'local' } }, ledger: money() },
    data = new Map(),
    calls = { backups: 0, reads: 0, stages: 0, closed: 0, saves: 0 },
    faults = {
      journal: false,
      backup: false,
      beforeStage: null,
      beforeBackup: null,
      beforeSave: null,
    };
  let serial = 0;
  const b = {
    family,
    ledger: model.createEmptyLedger(),
    allowed: true,
    storage: {},
    ownerToken: null,
  };
  const updateOwner = () =>
    (b.ownerToken = encodeReminderOwner({
      ...b.family,
      incarnationId: b.ledger.wallet.incarnationId,
    }));
  updateOwner();
  b.compareAndSave = async (expected, raw, next) => {
    calls.saves++;
    if (faults.beforeSave) await faults.beforeSave();
    if (b.ownerToken !== expected || JSON.stringify(b.ledger) !== raw) return false;
    b.ledger = next;
    updateOwner();
    return true;
  };
  const cloudSnapshot = () =>
    makeSnapshot({
      ledger: money(),
      owner: { projectId: family.actor.projectId, uid: family.actor.uid },
      id: 'backup-reference-0123456789abcdef',
      createdAtMs: 1000,
    });
  const transport = {
    async backup(snapshot) {
      calls.backups++;
      if (faults.beforeBackup) await faults.beforeBackup();
      if (faults.backup) throw Error('Synthetic network failure');
      return { backupId: snapshot.backupId };
    },
    async list() {
      calls.reads++;
      return [];
    },
    async download() {
      calls.reads++;
      return cloudSnapshot();
    },
    async photo() {
      throw Error('No photos expected');
    },
  };
  const storage = {
    async getItem(key) {
      return data.get(key) || null;
    },
    async setItem(key, value) {
      if (faults.journal) throw Error('Synthetic storage failure');
      data.set(key, value);
    },
    async removeItem(key) {
      data.delete(key);
    },
  };
  const files = {
    async read() {
      throw Error('No photos expected');
    },
    async stage() {
      calls.stages++;
      if (faults.beforeStage) await faults.beforeStage();
      return {
        refs: {},
        async close() {
          calls.closed++;
        },
      };
    },
  };
  const options = {
    getBinding: () => b,
    getSetup: () => ({
      configured: true,
      signedIn: true,
      projectId: family.actor.projectId,
      mode: 'emulator',
      error: '',
    }),
    readGuest: async () => clone(guest),
    files,
    storage,
    transportFor: () => transport,
    now: () => 1000,
    newId: (kind) => `${kind}-synthetic-0123456789-${++serial}`,
  };
  const controller = createBackupCoordinator(options);
  controller.ownerChanged();
  return { b, guest, data, calls, faults, options, controller, updateOwner };
}
test('construction and opening pending local state cause no network or financial writes', async () => {
  const f = fixture();
  assert.equal(f.controller.getSnapshot(), f.controller.getSnapshot());
  await f.controller.open();
  assert.deepEqual(f.calls, { backups: 0, reads: 0, stages: 0, closed: 0, saves: 0 });
});
test('backup preview is read-only and explicit confirmation records intent before one upload', async () => {
  const f = fixture();
  f.b.ledger = money();
  f.updateOwner();
  f.controller.ownerChanged();
  const before = JSON.stringify(f.b.ledger);
  assert.equal(await f.controller.previewBackup(false), true);
  assert.equal(f.calls.backups, 0);
  assert.equal(f.data.size, 0);
  assert.equal(await f.controller.confirmBackup(), true);
  assert.equal(f.calls.backups, 1);
  assert.equal(f.data.size, 0);
  assert.equal(JSON.stringify(f.b.ledger), before);
});
test('failure retains the same pending backup across coordinator recreation and deliberate resume', async () => {
  const f = fixture();
  await f.controller.previewBackup(false);
  f.faults.backup = true;
  assert.equal(await f.controller.confirmBackup(), false);
  const raw = [...f.data.values()][0],
    id = JSON.parse(raw).snapshot.backupId;
  const restarted = createBackupCoordinator(f.options);
  restarted.ownerChanged();
  await restarted.open();
  assert.equal(restarted.getSnapshot().pending.backupId, id);
  f.faults.backup = false;
  assert.equal(await restarted.resumeBackup(), true);
  assert.equal(f.calls.backups, 2);
  assert.equal(f.data.size, 0);
});
test('failed intent persistence cannot begin a provider upload and remains visible for recheck', async () => {
  const f = fixture();
  await f.controller.previewBackup(false);
  f.faults.journal = true;
  assert.equal(await f.controller.confirmBackup(), false);
  assert.equal(f.calls.backups, 0);
  assert.equal(f.controller.getSnapshot().journalBlocked, true);
});
test('changed wallet invalidates backup preview rather than uploading a stale unconfirmed selection', async () => {
  const f = fixture();
  await f.controller.previewBackup(false);
  f.b.ledger = { ...f.b.ledger, wallet: { ...f.b.ledger.wallet, name: 'Changed' } };
  assert.equal(await f.controller.confirmBackup(), false);
  assert.equal(f.calls.backups, 0);
});
test('guest copy requires confirmation, preserves source bytes and transfers into an empty account only', async () => {
  const f = fixture(),
    before = JSON.stringify(f.guest.ledger);
  assert.equal(await f.controller.previewGuestCopy(false), true);
  assert.equal(f.calls.saves, 0);
  assert.equal(f.calls.backups, 0);
  assert.equal(await f.controller.confirmGuestCopy(), true);
  assert.equal(model.totals(f.b.ledger).balance, -1250);
  assert.equal(JSON.stringify(f.guest.ledger), before);
  assert.notEqual(f.b.ledger.wallet.incarnationId, f.guest.ledger.wallet.incarnationId);
  assert.equal(f.b.ledger.achievements.ownerIncarnationId, f.b.ledger.wallet.incarnationId);
  assert.equal(f.calls.closed, 1);
  assert.equal(await f.controller.previewGuestCopy(false), false);
});
test('restoration cannot replace transaction history, planning records or custom categories', async () => {
  for (const change of [
    (b) => (b.ledger = money()),
    (b) =>
      (b.ledger = model.createCategory(b.ledger, {
        type: 'expense',
        name: 'Custom',
        id: 'custom',
      })),
    (b) =>
      (b.ledger = { ...b.ledger, wallet: { ...b.ledger.wallet, hasTransactionHistory: true } }),
  ]) {
    const f = fixture();
    change(f.b);
    f.updateOwner();
    assert.equal(await f.controller.previewRestore({}), false);
    assert.equal(f.calls.reads, 0);
    assert.equal(f.calls.saves, 0);
  }
});
test('restore preview downloads without saving and target edits before confirmation block overwrite', async () => {
  const f = fixture();
  assert.equal(await f.controller.previewRestore({}), true);
  assert.equal(f.calls.saves, 0);
  f.b.ledger = { ...f.b.ledger, wallet: { ...f.b.ledger.wallet, name: 'Edited after preview' } };
  assert.equal(await f.controller.confirmRestore(), false);
  assert.equal(f.calls.saves, 0);
});
test('target or guest changes during photo preparation cannot commit and staged files are closed', async () => {
  for (const kind of ['target', 'guest']) {
    const f = fixture();
    await f.controller.previewGuestCopy(false);
    f.faults.beforeStage = async () => {
      if (kind === 'target')
        f.b.ledger = { ...f.b.ledger, wallet: { ...f.b.ledger.wallet, name: 'Concurrent edit' } };
      else
        f.guest.ledger = {
          ...f.guest.ledger,
          wallet: { ...f.guest.ledger.wallet, name: 'Concurrent source edit' },
        };
    };
    assert.equal(await f.controller.confirmGuestCopy(), false);
    assert.equal(f.calls.closed, 1);
    assert.equal(f.b.ledger.transactions.length, 0);
  }
});
test('account changes while preview work is pending retire the old result and cannot affect new owner', async () => {
  const f = fixture(),
    gate = deferred();
  await f.controller.previewGuestCopy(false);
  f.faults.beforeStage = () => gate.promise;
  const pending = f.controller.confirmGuestCopy();
  await Promise.resolve();
  f.b.family = { ...f.b.family, actor: { ...f.b.family.actor, uid: 'account-b' } };
  f.updateOwner();
  f.controller.ownerChanged();
  gate.resolve();
  assert.equal(await pending, false);
  assert.equal(f.calls.saves, 0);
  assert.equal(f.calls.closed, 1);
  assert.equal(f.controller.getSnapshot().preview, null);
});
test('cancel does not permit a second operation until the old preparation settles', async () => {
  const f = fixture(),
    gate = deferred();
  await f.controller.previewGuestCopy(false);
  f.faults.beforeStage = () => gate.promise;
  const pending = f.controller.confirmGuestCopy();
  await Promise.resolve();
  f.controller.cancel();
  assert.equal(f.controller.getSnapshot().busy, true);
  assert.equal(await f.controller.previewBackup(false), false);
  gate.resolve();
  assert.equal(await pending, false);
  assert.equal(f.controller.getSnapshot().busy, false);
  assert.equal(f.calls.saves, 0);
});
test('restore confirmation uses exact compare-and-save and does not pretend an unconfirmed save succeeded', async () => {
  const f = fixture();
  await f.controller.previewRestore({});
  f.faults.beforeSave = async () => {
    f.b.ledger = { ...f.b.ledger, wallet: { ...f.b.ledger.wallet, name: 'Late edit' } };
  };
  assert.equal(await f.controller.confirmRestore(), false);
  assert.equal(f.b.ledger.transactions.length, 0);
  assert.equal(f.calls.closed, 1);
  assert.match(f.controller.getSnapshot().error, /not confirmed/);
});

test('live-owner reads hide the previous account before React effects retire its view', async () => {
  const f = fixture();
  await f.controller.previewRestore({});
  assert.ok(f.controller.getSnapshot().preview);
  f.b.family = { ...f.b.family, actor: { ...f.b.family.actor, uid: 'account-b' } };
  f.updateOwner();
  const first = f.controller.getSnapshot();
  assert.equal(first.preview, null);
  assert.equal(first.pending, null);
  assert.deepEqual(first.backups, []);
  assert.equal(first.message, '');
  assert.equal(f.controller.getSnapshot(), first);
});
test('an owner change during the commit wait retires old summaries without aborting the save operation', async () => {
  const f = fixture();
  await f.controller.previewRestore({});
  f.faults.beforeSave = async () => {
    f.b.family = { ...f.b.family, actor: { ...f.b.family.actor, uid: 'account-b' } };
    f.updateOwner();
    f.controller.ownerChanged();
  };
  assert.equal(await f.controller.confirmRestore(), false);
  assert.equal(f.b.family.actor.uid, 'account-b');
  assert.equal(f.controller.getSnapshot().preview, null);
  assert.equal(f.controller.getSnapshot().pending, null);
  assert.deepEqual(f.controller.getSnapshot().backups, []);
  assert.equal(f.b.ledger.transactions.length, 0);
});
test('confirmed import retains success while pending photo cleanup is visible and retryable', async () => {
  const f = fixture();
  f.options.files.stage = async () => ({
    refs: {},
    async close() {
      return { pending: true, message: 'Synthetic cleanup pending' };
    },
  });
  f.options.files.retryCleanup = async () => ({ pending: false, message: '' });
  await f.controller.previewRestore({});
  assert.equal(await f.controller.confirmRestore(), true);
  assert.equal(f.controller.getSnapshot().cleanupPending, true);
  f.controller.ownerChanged();
  assert.equal(f.controller.getSnapshot().cleanupPending, true);
  assert.equal(f.b.ledger.transactions.length, 1);
  await f.controller.retryCleanup();
  assert.equal(f.controller.getSnapshot().cleanupPending, false);
});

test('failed photo preparation surfaces pending cleanup even when no stage handle was returned', async () => {
  const f = fixture();
  f.options.files.stage = async () => {
    throw Object.assign(new Error('Preparation failed'), {
      cleanupPending: true,
      cleanupMessage: 'Retry owned photo cleanup',
    });
  };
  await f.controller.previewRestore({});
  assert.equal(await f.controller.confirmRestore(), false);
  assert.equal(f.calls.saves, 0);
  assert.equal(f.controller.getSnapshot().cleanupPending, true);
  assert.match(f.controller.getSnapshot().cleanupMessage, /Retry owned/);
});

test('a remount with unreadable pending state cannot invent a second backup or clear the old operation', async () => {
  const f = fixture();
  await f.controller.previewBackup(false);
  f.faults.backup = true;
  await f.controller.confirmBackup();
  const original = [...f.data.values()][0],
    id = JSON.parse(original).snapshot.backupId;
  const read = f.options.storage.getItem;
  let fail = true;
  f.options.storage.getItem = async (key) => {
    if (fail) {
      fail = false;
      throw Error('Synthetic unavailable read');
    }
    return read(key);
  };
  const next = createBackupCoordinator(f.options);
  next.ownerChanged();
  assert.equal(await next.open(), false);
  assert.equal(next.getSnapshot().journalBlocked, true);
  assert.equal(await next.previewBackup(false), false);
  assert.equal(next.getSnapshot().pending.backupId, id);
  assert.equal([...f.data.values()][0], original);
  assert.equal(f.calls.backups, 1);
});
test('malformed pending bytes are retained and never appear inside the UI error', async () => {
  const f = fixture();
  await f.controller.previewBackup(false);
  f.faults.backup = true;
  await f.controller.confirmBackup();
  const key = [...f.data.keys()][0],
    raw = 'synthetic-private-unparseable-content';
  f.data.set(key, raw);
  const next = createBackupCoordinator(f.options);
  next.ownerChanged();
  assert.equal(await next.open(), false);
  assert.equal(await next.previewBackup(false), false);
  assert.equal(await next.resumeBackup(), false);
  assert.equal(next.getSnapshot().error.includes(raw), false);
  assert.equal(f.data.get(key), raw);
  assert.equal(f.calls.backups, 1);
  assert.equal(await next.discardPending(), true);
  assert.equal(f.data.size, 0);
});
test('a second confirmation rechecks durable absence atomically instead of overwriting another preview intent', async () => {
  const f = fixture(),
    other = createBackupCoordinator(f.options);
  other.ownerChanged();
  await f.controller.previewBackup(false);
  await other.previewBackup(false);
  f.faults.backup = true;
  await f.controller.confirmBackup();
  const original = [...f.data.values()][0];
  assert.equal(await other.confirmBackup(), false);
  assert.equal([...f.data.values()][0], original);
  assert.equal(f.calls.backups, 1);
});
test('retired in-flight journal writes settle before a remount reads and cannot dispatch an upload', async () => {
  const f = fixture(),
    gate = deferred();
  await f.controller.previewBackup(false);
  const set = f.options.storage.setItem;
  let writing = false;
  f.options.storage.setItem = async (key, value) => {
    writing = true;
    await gate.promise;
    return set(key, value);
  };
  const previous = f.controller.confirmBackup();
  while (!writing) await new Promise((done) => setImmediate(done));
  f.controller.cancel();
  const next = createBackupCoordinator(f.options);
  next.ownerChanged();
  const opening = next.open();
  gate.resolve();
  assert.equal(await previous, false);
  assert.equal(await opening, true);
  assert.ok(next.getSnapshot().pending);
  assert.equal(await next.previewBackup(false), false);
  assert.equal(f.calls.backups, 0);
  assert.equal(f.data.size, 1);
});

test('discard acknowledgement for one pending ID cannot clear a replacement operation', async () => {
  const f = fixture();
  await f.controller.previewBackup(false);
  f.faults.backup = true;
  await f.controller.confirmBackup();
  const id = f.controller.getSnapshot().pending.backupId,
    key = [...f.data.keys()][0],
    changed = JSON.parse(f.data.get(key));
  changed.snapshot.backupId = 'backup-different-0123456789abcdef';
  const raw = JSON.stringify(changed);
  f.data.set(key, raw);
  assert.equal(await f.controller.discardPending(id), false);
  assert.equal(f.data.get(key), raw);
});
test('discarding unknown state reopens a now-readable valid operation for fresh acknowledgement', async () => {
  const f = fixture();
  await f.controller.previewBackup(false);
  f.faults.backup = true;
  await f.controller.confirmBackup();
  const original = [...f.data.values()][0];
  assert.equal(await f.controller.discardPending(null), false);
  assert.ok(f.controller.getSnapshot().pending);
  assert.equal([...f.data.values()][0], original);
});
