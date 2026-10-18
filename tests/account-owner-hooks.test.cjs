const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const {
  hostWithStores,
  loadSource,
  ledger,
  store,
  clock,
  identity,
  owner,
} = require('./helpers/account-hook-harness.cjs');
const { deferred, flush } = require('./helpers/native-adapter-vm.cjs');
const context = require('../src/core/transactionContext');
const realPhotos = require('../src/attachments/photoManager');
const familyA = {
  scope: { kind: 'test', namespace: 'owner-hooks' },
  actor: { kind: 'firebase', uid: 'A' },
};
const familyB = { scope: familyA.scope, actor: { kind: 'firebase', uid: 'B' } };
function photoFixture() {
  const host = hostWithStores(),
    managers = [];
  let data = ledger('A'),
    active = true,
    family = familyA,
    storage = store(data);
  const localFamily = { scope: familyA.scope, actor: { kind: 'local' } },
    journal = { getItem: async () => null, setItem: async () => {} };
  const module = loadSource(path.join(__dirname, '../src/ui/useWalletPhotos.ts'), {
    react: host.react,
    '@react-native-async-storage/async-storage': journal,
    '../core/transactionContext': context,
    '../attachments/photoManager': {
      photoFamilyToken: realPhotos.photoFamilyToken,
      createPhotoManager(options) {
        const drain = deferred(),
          manager = {
            options,
            drainWork: drain,
            disposed: 0,
            cleanup: [],
            retries: 0,
            async initialize() {
              return { pending: false, message: '', deleted: 0, retained: 0 };
            },
            async queueCleanup(photos) {
              manager.cleanup.push(photos);
              return { pending: false, message: '', deleted: 0, retained: 0 };
            },
            async retryCleanup() {
              manager.retries++;
              return { pending: false, message: '', deleted: 0, retained: 0 };
            },
            dispose() {
              manager.disposed++;
            },
            drain() {
              return drain.promise;
            },
          };
        managers.push(manager);
        return manager;
      },
    },
    '../attachments/photoFiles': { createPhotoFileAdapter: () => ({}) },
    '../attachments/services': { createContextServices: () => ({}) },
    '../reminders/store': owner,
    './useLedger': { localLedgerFamily: localFamily, localLedgerStorage: store() },
  });
  return {
    host,
    managers,
    render: () =>
      host.render(() =>
        module.useWalletPhotos(data, active, {
          family,
          ledgerStorage: storage,
          journalStorage: journal,
        }),
      ),
    setData(value) {
      data = value;
    },
    setFamily(value, next) {
      family = value;
      storage = next;
    },
    setActive(value) {
      active = value;
    },
    get data() {
      return data;
    },
    get family() {
      return family;
    },
  };
}

test('photo families with identical incarnations never compare retired references or reuse another UID binding', async () => {
  const f = photoFixture();
  const photo = {
    id: 'photo-one',
    fileName: 'photo-one.png',
    ownerIncarnationId: f.data.wallet.incarnationId,
    mimeType: 'image/png',
    width: 1,
    height: 1,
    byteSize: 80,
  };
  f.setData({
    ...f.data,
    transactions: [{ context: { notes: '', photo, withPerson: null, location: null } }],
  });
  const old = f.render();
  await flush();
  f.render();
  const next = ledger('B');
  f.setFamily(familyB, store(next));
  f.setData(next);
  const current = f.render();
  await flush();
  assert.equal(f.managers.length, 2);
  assert.notEqual(current.photos, old.photos);
  assert.equal(f.managers[0].disposed, 1);
  assert.equal(f.managers[1].cleanup.length, 0);
  old.onCleanupMessage('shared-incarnation', 'A cleanup failed');
  await old.retry();
  assert.equal(f.render().pending, false);
  assert.equal(f.render().message, '');
  assert.equal(f.managers[0].retries, 0);
  assert.equal(f.managers[1].options.family.actor.uid, 'B');
});

test('photo identity suspension invalidates synchronously, drains once and refuses early/wrong-family resume', async () => {
  const f = photoFixture();
  const view = f.render();
  await flush();
  const token = owner.encodeReminderOwner({
    ...familyA,
    incarnationId: f.data.wallet.incarnationId,
  });
  const pending = view.suspendForIdentity(token),
    again = view.suspendForIdentity(token);
  assert.equal(pending, again);
  assert.equal(f.managers[0].disposed, 1);
  assert.equal(f.render().photos, undefined);
  assert.equal(view.resumeAfterIdentity(familyA), false);
  f.managers[0].drainWork.resolve();
  assert.equal((await pending).pending, false);
  assert.equal(view.resumeAfterIdentity(familyB), false);
  assert.equal(view.resumeAfterIdentity(familyA), true);
  f.render();
  assert.equal(f.managers.length, 2);
});

test('ordinary same-family ledger edits preserve the photo manager and identify only actual removed references', async () => {
  const f = photoFixture();
  const photo = {
    id: 'photo-one',
    fileName: 'photo-one.png',
    ownerIncarnationId: f.data.wallet.incarnationId,
    mimeType: 'image/png',
    width: 1,
    height: 1,
    byteSize: 80,
  };
  f.setData({
    ...f.data,
    transactions: [{ context: { notes: '', photo, withPerson: null, location: null } }],
  });
  f.render();
  await flush();
  f.setData({ ...f.data, transactions: [] });
  f.render();
  await flush();
  assert.equal(f.managers.length, 1);
  assert.equal(f.managers[0].cleanup.length, 1);
  assert.equal(f.managers[0].cleanup[0][0].id, 'photo-one');
});

function reminderFixture() {
  const host = hostWithStores(),
    coordinators = new Map(),
    subscriptions = new Map(),
    presentation = [],
    events = [];
  let family = familyA,
    data = ledger('A'),
    active = true,
    present = true,
    current = true;
  const getClock = clock,
    registerTransitionGuard = () => () => {},
    registerCommitObserver = (observer) => {
      events.push(observer);
      return () => {};
    };
  const module = loadSource(path.join(__dirname, '../src/ui/useWalletReminders.ts'), {
    react: host.react,
    '@react-native-async-storage/async-storage': {},
    '../core/achievements': {
      currentFinancialMilestoneKeys: () => ['baseline'],
      financialMilestoneEvents: () => [{ key: 'synthetic-event' }],
    },
    '../reminders/coordinator': {
      retireInactiveNotifications: async () => ({ ok: true, pending: false, message: '' }),
    },
    '../reminders/expoAdapter': {
      expoNotificationAdapter: {},
      installReminderPresentationHandler() {},
      setActiveReminderOwner(token) {
        presentation.push(token);
      },
      subscribeToReminderNotifications(options) {
        subscriptions.set(options.ownerToken, options);
        return () => {};
      },
    },
    '../accounts/identity': identity,
    './useLedger': { localLedgerFamily: { scope: familyA.scope, actor: { kind: 'local' } } },
    './useReminders': {
      useReminders({ owner: who }) {
        if (!who) return { coordinator: null, state: null };
        const token = owner.encodeReminderOwner(who);
        if (!coordinators.has(token)) {
          const state = { loading: false, loadError: null, ownerPaused: false, reminders: [] };
          const coor = {
            ownerToken: token,
            cancelled: 0,
            resumed: 0,
            observed: 0,
            state,
            getSnapshot: () => state,
            async quiesceAndCancelOwner() {
              coor.cancelled++;
              state.ownerPaused = true;
              return { ok: true, pending: false, message: '' };
            },
            async resumeOwner() {
              coor.resumed++;
              state.ownerPaused = false;
              return { ok: true, pending: false, message: '' };
            },
            async observeFinancialEvents() {
              coor.observed++;
            },
            async reconcile() {},
          };
          coordinators.set(token, coor);
        }
        const coor = coordinators.get(token);
        return { coordinator: coor, state: coor.state };
      },
    },
  });
  const opened = [];
  return {
    host,
    coordinators,
    subscriptions,
    presentation,
    events,
    opened,
    render: () =>
      host.render(() =>
        module.useWalletReminders({
          ledger: data,
          active,
          family,
          presentationActive: present,
          isOwnerCurrent: () => current,
          getClock,
          registerTransitionGuard,
          registerCommitObserver,
          onOpen: (item) => opened.push(item),
        }),
      ),
    setFamily(value) {
      family = value;
      data = ledger(value.actor.uid ?? 'Guest');
    },
    setPresent(value) {
      present = value;
    },
    setCurrent(value) {
      current = value;
    },
    setActive(value) {
      active = value;
    },
  };
}

test('reminder quiesce/resume use the full owner and stale equal-incarnation callbacks cannot affect another UID', async () => {
  const f = reminderFixture();
  const old = f.render();
  await flush();
  f.render();
  const oldToken = old.coordinator.ownerToken;
  const wrong = owner.encodeReminderOwner({ ...familyB, incarnationId: 'shared-incarnation' });
  assert.equal((await old.quiesceForIdentity(wrong)).ok, false);
  assert.equal(old.coordinator.cancelled, 0);
  assert.equal((await old.quiesceForIdentity(oldToken)).ok, true);
  assert.equal((await old.resumeActiveOwner()).ok, false);
  assert.equal((await old.resumeForIdentity(oldToken)).ok, true);
  f.setFamily(familyB);
  f.render();
  await flush();
  const current = f.render();
  assert.notEqual(current.coordinator.ownerToken, oldToken);
  assert.equal((await old.quiesceForIdentity(oldToken)).ok, false);
  assert.equal((await old.resumeForIdentity(oldToken)).ok, false);
  f.subscriptions.get(oldToken).onOpen({ kind: 'goal' });
  assert.equal(f.opened.length, 0);
  await f.events[0](ledger(), ledger(), clock());
  assert.equal(old.coordinator.observed, 0);
});

test('target reminder preparation can keep presentation disabled until confirmed account activation', async () => {
  const f = reminderFixture();
  f.setPresent(false);
  let view = f.render();
  await flush();
  view = f.render();
  assert.equal(f.presentation.at(-1), null);
  const notifications = f.subscriptions.get(view.coordinator.ownerToken);
  notifications.onOpen({ kind: 'goal' });
  notifications.onReceived();
  assert.equal(f.opened.length, 0);
  assert.equal(f.render().receivedMessage, '');
  f.setPresent(true);
  view = f.render();
  notifications.onOpen({ kind: 'goal' });
  assert.equal(f.opened.length, 1);
  f.setCurrent(false);
  assert.equal((await view.readyForIdentity(view.coordinator.ownerToken, () => true)).ok, false);
});
