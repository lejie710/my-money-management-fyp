'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { retireInactiveNotifications } = require('../src/reminders/coordinator');
const { encodeReminderOwner } = require('../src/reminders/store');
const {
  NOW,
  copy,
  owner,
  draft,
  deferred,
  memory,
  native,
  setup,
} = require('./reminder-fixtures.cjs');

const schedules = (s) => s.notifications.calls.filter((item) => item.method === 'schedule');
async function ready(options = {}) {
  const s = setup(options);
  assert.equal((await s.coordinator.initialize([])).ok, true);
  return s;
}

test('construction has zero effects; snapshot identity is stable and nested state is readonly', async () => {
  const s = setup();
  assert.equal(s.storage.reads.length, 0);
  assert.equal(s.notifications.calls.length, 0);
  const initial = s.coordinator.getSnapshot();
  assert.equal(s.coordinator.getSnapshot(), initial);
  let changes = 0;
  const unsubscribe = s.coordinator.subscribe(() => changes++);
  await s.coordinator.initialize([]);
  const saved = await s.coordinator.create(draft());
  assert.equal(saved.ok, true);
  const current = s.coordinator.getSnapshot();
  assert.equal(s.coordinator.getSnapshot(), current);
  assert.throws(() => {
    current.reminders[0].title = 'Changed';
  }, TypeError);
  assert.throws(() => {
    current.automatic.budgets = true;
  }, TypeError);
  assert.equal((await s.store.load()).reminders[0].title, draft().title);
  assert.ok(changes > 0);
  unsubscribe();
  s.coordinator.dispose();
});

test('failed intent persistence causes zero scheduling effects and retains form-retry context', async () => {
  const s = await ready();
  s.storage.hooks.beforeWrite = (value) => {
    if (value.operations.length) throw new Error('No storage');
  };
  const outcome = await s.coordinator.create(draft());
  assert.equal(outcome.ok, false);
  assert.equal(schedules(s).length, 0);
  assert.equal((await s.store.load()).reminders.length, 0);
  s.coordinator.dispose();
});

test('write-then-throw is read back before effects and does not duplicate a create', async () => {
  const s = await ready();
  let failed = false;
  s.storage.hooks.afterWrite = (value) => {
    if (!failed && value.operations.length) {
      failed = true;
      throw new Error('Reply lost after commit');
    }
  };
  const outcome = await s.coordinator.create(draft());
  assert.equal(outcome.ok, true);
  assert.equal(schedules(s).length, 1);
  assert.equal(s.notifications.pending.size, 1);
  assert.equal((await s.store.load()).operations.length, 0);
  s.coordinator.dispose();
});

test('a missing initialized envelope after a rejected write blocks cached writes and native effects', async () => {
  const s = await ready();
  const previousBytes = s.storage.values.get(s.store.key);
  s.storage.hooks.beforeWrite = () => {
    s.storage.values.delete(s.store.key);
    throw new Error('Storage state was lost');
  };
  const outcome = await s.coordinator.create(draft());
  assert.equal(outcome.ok, false);
  assert.equal(outcome.pending, true);
  assert.match(s.coordinator.getSnapshot().loadError, /disappeared|confirmed/);
  const writes = s.storage.writes.length;
  assert.equal((await s.coordinator.create(draft('Another'))).ok, false);
  assert.equal(s.storage.writes.length, writes);
  assert.equal(schedules(s).length, 0);
  assert.equal((await s.coordinator.reconcile()).ok, false);
  assert.equal((await s.coordinator.initialize([])).ok, false);
  assert.equal(s.storage.writes.length, writes);
  s.storage.hooks.beforeWrite = null;
  s.storage.values.set(s.store.key, previousBytes);
  assert.equal((await s.coordinator.initialize([])).ok, true);
  assert.equal((await s.coordinator.create(draft('Recovered'))).ok, true);
  s.coordinator.dispose();
});

test('failed first initialization with no saved envelope remains retryable without native effects', async () => {
  const s = setup();
  s.storage.hooks.beforeWrite = () => {
    throw new Error('Initial write unavailable');
  };
  assert.equal((await s.coordinator.initialize([])).ok, false);
  assert.equal(s.storage.values.has(s.store.key), false);
  assert.equal(schedules(s).length, 0);
  s.storage.hooks.beforeWrite = null;
  assert.equal((await s.coordinator.initialize([])).ok, true);
  assert.equal((await s.coordinator.create(draft())).ok, true);
  s.coordinator.dispose();
});

test('a committed intent with an unconfirmable write reply is recovered without assuming it failed or duplicating it', async () => {
  const s = await ready();
  let denyRead = false;
  s.storage.hooks.afterWrite = (value) => {
    if (value.operations.length) {
      denyRead = true;
      throw new Error('Reply lost after intent commit');
    }
  };
  s.storage.hooks.beforeRead = () => {
    if (denyRead) throw new Error('Readback unavailable');
  };
  const failed = await s.coordinator.create(draft());
  assert.equal(failed.pending, true);
  assert.equal(schedules(s).length, 0);
  assert.ok(s.coordinator.getSnapshot().loadError);
  s.coordinator.dispose();
  s.storage.hooks.afterWrite = null;
  s.storage.hooks.beforeRead = null;
  const next = await ready({
    storage: s.storage,
    notifications: s.notifications,
    owner: s.owner,
    idPrefix: 'recovered',
  });
  assert.equal(next.coordinator.getSnapshot().reminders[0].id, failed.reminderId);
  assert.equal(schedules(s).length, 0);
  assert.equal((await next.coordinator.retry(failed.reminderId)).ok, true);
  assert.equal(schedules(s).length, 1);
  next.coordinator.dispose();
});

test('schedule-then-throw is adopted by owned identity enumeration without a duplicate', async () => {
  const s = await ready();
  s.notifications.hooks.afterSchedule = () => {
    throw new Error('Native reply lost');
  };
  const outcome = await s.coordinator.create(draft());
  assert.equal(outcome.ok, true);
  assert.equal(schedules(s).length, 1);
  assert.equal(s.notifications.pending.size, 1);
  s.coordinator.dispose();
});

test('definite schedule failure retains one pending create; Retry keeps its absolute due time', async () => {
  const s = await ready();
  s.notifications.hooks.beforeSchedule = () => {
    throw new Error('Scheduler unavailable');
  };
  const original = draft();
  const failed = await s.coordinator.create(original);
  assert.equal(failed.ok, false);
  assert.equal(failed.pending, true);
  const repeated = await s.coordinator.create({
    ...original,
    scheduledAtMs: original.scheduledAtMs + 10000,
  });
  assert.equal(repeated.reminderId, failed.reminderId);
  assert.equal((await s.store.load()).operations.length, 1);
  s.clock.now += 30000;
  s.notifications.hooks.beforeSchedule = null;
  assert.equal((await s.coordinator.retry(failed.reminderId)).ok, true);
  assert.equal([...s.notifications.pending.values()][0].scheduledAtMs, original.scheduledAtMs);
  s.coordinator.dispose();
});

test('denied permission never prompts implicitly; explicit enable allows the pending retry', async () => {
  const s = await ready();
  s.notifications.control.permission = {
    status: 'denied',
    canAskAgain: true,
    channelEnabled: true,
  };
  const failed = await s.coordinator.create(draft());
  assert.equal(failed.ok, false);
  assert.equal(schedules(s).length, 0);
  assert.equal(
    s.notifications.calls.filter((item) => item.method === 'request-permission').length,
    0,
  );
  assert.equal((await s.coordinator.requestPermission()).ok, true);
  assert.equal((await s.coordinator.retry(failed.reminderId)).ok, true);
  s.coordinator.dispose();
});

test('an expired pending reminder is not replayed during initialization or Retry', async () => {
  const s = await ready();
  s.notifications.hooks.beforeSchedule = () => {
    throw new Error('Offline');
  };
  const failed = await s.coordinator.create(draft('Soon', 1));
  s.clock.now += 2000;
  s.notifications.hooks.beforeSchedule = null;
  const before = schedules(s).length;
  assert.equal((await s.coordinator.reconcile()).ok, true);
  assert.equal((await s.coordinator.retry(failed.reminderId)).ok, false);
  assert.equal(schedules(s).length, before);
  s.coordinator.dispose();
});

test('a successful edit replaces the old schedule and commits only the new revision', async () => {
  const s = await ready();
  const created = await s.coordinator.create(draft());
  const oldId = [...s.notifications.pending.keys()][0];
  const changed = draft('Updated review', 1200);
  assert.equal((await s.coordinator.edit(created.reminderId, changed)).ok, true);
  assert.equal(s.notifications.pending.size, 1);
  assert.equal(s.notifications.pending.has(oldId), false);
  assert.equal(s.coordinator.getSnapshot().reminders[0].title, changed.title);
  assert.equal(s.coordinator.getSnapshot().reminders[0].revision, 2);
  s.coordinator.dispose();
});

test('replacement scheduling failure preserves the previous reminder and native request', async () => {
  const s = await ready();
  const created = await s.coordinator.create(draft());
  const bytes = [...s.notifications.pending.values()].map(copy);
  s.notifications.hooks.beforeSchedule = () => {
    throw new Error('Unavailable');
  };
  const outcome = await s.coordinator.edit(created.reminderId, draft('Changed'));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.pending, false);
  assert.deepEqual([...s.notifications.pending.values()], bytes);
  assert.equal(s.coordinator.getSnapshot().reminders[0].title, draft().title);
  s.coordinator.dispose();
});

test('old cancellation failure compensates by canceling the replacement, preserving the old reminder', async () => {
  const s = await ready();
  const created = await s.coordinator.create(draft());
  const oldId = [...s.notifications.pending.keys()][0];
  s.notifications.hooks.beforeCancel = (id) => {
    if (id === oldId) throw new Error('Old cancel unavailable');
  };
  const outcome = await s.coordinator.edit(created.reminderId, draft('Replacement'));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.pending, false);
  assert.deepEqual([...s.notifications.pending.keys()], [oldId]);
  assert.equal((await s.store.load()).operations.length, 0);
  s.coordinator.dispose();
});

test('failed compensation is journaled; restart cancels the candidate and retains the old schedule', async () => {
  const s = await ready();
  const created = await s.coordinator.create(draft());
  const oldId = [...s.notifications.pending.keys()][0];
  s.notifications.hooks.beforeCancel = () => {
    throw new Error('All cancellation temporarily unavailable');
  };
  const outcome = await s.coordinator.edit(created.reminderId, draft('Replacement'));
  assert.equal(outcome.pending, true);
  assert.equal(s.notifications.pending.size, 2);
  assert.equal((await s.store.load()).operations[0].stage, 'rollback');
  s.coordinator.dispose();
  s.notifications.hooks.beforeCancel = null;
  const reopened = await ready({
    storage: s.storage,
    notifications: s.notifications,
    owner: s.owner,
    idPrefix: 'reopened',
  });
  assert.deepEqual([...s.notifications.pending.keys()], [oldId]);
  assert.equal(reopened.coordinator.getSnapshot().reminders[0].title, draft().title);
  reopened.coordinator.dispose();
});

test('final edit metadata failure keeps the already switched replacement for reconciliation', async () => {
  const s = await ready();
  const created = await s.coordinator.create(draft());
  const oldId = [...s.notifications.pending.keys()][0];
  let fail = true;
  s.storage.hooks.beforeWrite = (value) => {
    if (fail && value.operations.length === 0 && value.reminders[0]?.title === 'Replacement') {
      fail = false;
      throw new Error('Final metadata unavailable');
    }
  };
  const outcome = await s.coordinator.edit(created.reminderId, draft('Replacement'));
  assert.equal(outcome.pending, true);
  assert.equal(s.notifications.pending.size, 1);
  assert.equal(s.notifications.pending.has(oldId), false);
  assert.equal((await s.coordinator.retry(created.reminderId)).ok, true);
  assert.equal(schedules(s).length, 2);
  assert.equal(s.coordinator.getSnapshot().reminders[0].title, 'Replacement');
  s.coordinator.dispose();
});

test('delete cancellation failure is retryable and never schedules a replacement', async () => {
  const s = await ready();
  const created = await s.coordinator.create(draft());
  s.notifications.hooks.beforeCancel = () => {
    throw new Error('Cancel unavailable');
  };
  assert.equal((await s.coordinator.remove(created.reminderId)).pending, true);
  assert.equal((await s.store.load()).operations[0].stage, 'deleting');
  s.notifications.hooks.beforeCancel = null;
  assert.equal((await s.coordinator.retry(created.reminderId)).ok, true);
  assert.equal(s.notifications.pending.size, 0);
  assert.equal(schedules(s).length, 1);
  s.coordinator.dispose();
});

test('an elapsed confirmed replacement does not resurrect the superseded old schedule during recovery', async () => {
  const s = await ready();
  const created = await s.coordinator.create(draft('Later old reminder', 600));
  let fail = true;
  s.storage.hooks.beforeWrite = (value) => {
    if (
      fail &&
      value.operations.length === 0 &&
      value.reminders[0]?.title === 'Earlier replacement'
    ) {
      fail = false;
      throw new Error('Final confirmation failed');
    }
  };
  assert.equal(
    (await s.coordinator.edit(created.reminderId, draft('Earlier replacement', 1))).pending,
    true,
  );
  s.clock.now += 2000;
  // A past request may have been delivered or removed by the OS; neither is assumed.
  s.notifications.pending.clear();
  assert.equal((await s.coordinator.reconcile()).ok, true);
  assert.equal(schedules(s).length, 2);
  assert.equal(s.notifications.pending.size, 0);
  const row = s.coordinator.getSnapshot().reminders[0];
  assert.equal(row.title, 'Earlier replacement');
  assert.equal(row.status, 'elapsed');
  assert.equal(row.pendingAction, null);
  s.coordinator.dispose();
});

test('final delete storage failure remains cancel-only after restart', async () => {
  const s = await ready();
  const created = await s.coordinator.create(draft());
  let fail = true;
  s.storage.hooks.beforeWrite = (value) => {
    if (fail && value.reminders.length === 0 && value.operations.length === 0) {
      fail = false;
      throw new Error('Delete metadata failed');
    }
  };
  assert.equal((await s.coordinator.remove(created.reminderId)).pending, true);
  assert.equal(s.notifications.pending.size, 0);
  s.coordinator.dispose();
  const reopened = await ready({
    storage: s.storage,
    notifications: s.notifications,
    owner: s.owner,
  });
  assert.equal(reopened.coordinator.getSnapshot().reminders.length, 0);
  assert.equal(schedules(s).length, 1);
  reopened.coordinator.dispose();
});

test('cancel-then-throw is confirmed by enumeration and does not report false pending deletion', async () => {
  const s = await ready();
  const created = await s.coordinator.create(draft());
  s.notifications.hooks.afterCancel = () => {
    throw new Error('Cancel response lost');
  };
  assert.equal((await s.coordinator.remove(created.reminderId)).ok, true);
  assert.equal(s.notifications.pending.size, 0);
  s.coordinator.dispose();
});

test('a same-owner remount waits for the disposed instance pending schedule and journal completion', async () => {
  const s = await ready();
  const entered = deferred();
  const release = deferred();
  s.notifications.hooks.beforeSchedule = async () => {
    entered.resolve();
    await release.promise;
  };
  const creating = s.coordinator.create(draft());
  await entered.promise;
  s.coordinator.dispose();
  const successor = setup({
    storage: s.storage,
    notifications: s.notifications,
    owner: s.owner,
    idPrefix: 'next',
  });
  let initialized = false;
  const initializing = successor.coordinator.initialize([]).then((value) => {
    initialized = true;
    return value;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(initialized, false);
  assert.equal(successor.coordinator.getSnapshot().loading, true);
  release.resolve();
  assert.equal((await creating).ok, true);
  assert.equal((await initializing).ok, true);
  assert.equal(successor.coordinator.getSnapshot().reminders.length, 1);
  assert.equal(schedules(s).length, 1);
  assert.equal(s.notifications.pending.size, 1);
  successor.coordinator.dispose();
});

test('a financial save during scheduling survives unchanged because no ledger setter is used', async () => {
  const s = await ready();
  const entered = deferred();
  const release = deferred();
  s.notifications.hooks.beforeSchedule = async () => {
    entered.resolve();
    await release.promise;
  };
  const key = '@mymoney/core/v4';
  s.storage.values.set(key, '{"transactions":[1]}');
  const pending = s.coordinator.create(draft());
  await entered.promise;
  s.storage.values.set(key, '{"transactions":[1,2]}');
  release.resolve();
  assert.equal((await pending).ok, true);
  assert.equal(s.storage.values.get(key), '{"transactions":[1,2]}');
  assert.ok(s.storage.writes.every((item) => item.key !== key));
  s.coordinator.dispose();
});

test('quiescing a delayed old owner cancels only its requests while another owner is active', async () => {
  const sharedStorage = memory();
  const sharedNative = native();
  const old = await ready({
    storage: sharedStorage,
    notifications: sharedNative,
    owner: owner('old-wallet'),
    idPrefix: 'old',
  });
  const entered = deferred();
  const release = deferred();
  sharedNative.hooks.beforeSchedule = async (request) => {
    if (request.data.ownerToken === old.ownerToken) {
      entered.resolve();
      await release.promise;
    }
  };
  const creating = old.coordinator.create(draft('Old owner'));
  await entered.promise;
  const quiescing = old.coordinator.quiesceAndCancelOwner();
  const next = await ready({
    storage: sharedStorage,
    notifications: sharedNative,
    owner: owner('new-wallet'),
    idPrefix: 'new',
  });
  assert.equal((await next.coordinator.create(draft('New owner'))).ok, true);
  release.resolve();
  await creating;
  assert.equal((await quiescing).ok, true);
  assert.equal(old.coordinator.getSnapshot().ownerPaused, true);
  assert.equal(sharedNative.pending.size, 1);
  assert.equal([...sharedNative.pending.values()][0].title, 'New owner');
  assert.equal(next.coordinator.getSnapshot().reminders[0].title, 'New owner');
  old.coordinator.dispose();
  next.coordinator.dispose();
});

test('owner pause and reset-failure resume restore future definitions but not elapsed reminders', async () => {
  const s = await ready();
  await s.coordinator.create(draft('Future'));
  await s.coordinator.create(draft('Elapsed', 1));
  assert.equal((await s.coordinator.quiesceAndCancelOwner()).ok, true);
  assert.equal(s.notifications.pending.size, 0);
  s.clock.now += 2000;
  assert.equal((await s.coordinator.resumeOwner()).ok, true);
  assert.equal(s.notifications.pending.size, 1);
  assert.equal([...s.notifications.pending.values()][0].title, 'Future');
  s.coordinator.dispose();
});

test('failed quiesce and resume never replace a pending deletion with an edit or resurrect it', async () => {
  const s = await ready();
  const created = await s.coordinator.create(draft());
  s.notifications.hooks.beforeCancel = () => {
    throw new Error('Cancellation blocked');
  };
  assert.equal((await s.coordinator.remove(created.reminderId)).pending, true);
  assert.equal((await s.coordinator.quiesceAndCancelOwner()).ok, false);
  assert.equal((await s.coordinator.resumeOwner()).ok, false);
  assert.equal((await s.store.load()).operations[0].kind, 'delete');
  s.notifications.hooks.beforeCancel = null;
  assert.equal((await s.coordinator.resumeOwner()).ok, true);
  assert.equal(s.coordinator.getSnapshot().reminders.length, 0);
  assert.equal(s.notifications.pending.size, 0);
  assert.equal(schedules(s).length, 1);
  s.coordinator.dispose();
});

test('resume of an already-active healthy owner does not replace working schedules', async () => {
  const s = await ready();
  await s.coordinator.create(draft());
  const nativeId = [...s.notifications.pending.keys()][0];
  assert.equal((await s.coordinator.resumeOwner()).ok, true);
  assert.equal((await s.coordinator.resumeOwner()).ok, true);
  assert.equal(schedules(s).length, 1);
  assert.deepEqual([...s.notifications.pending.keys()], [nativeId]);
  s.coordinator.dispose();
});

test('a failed pause-intent write resumes accepting without replacing healthy schedules', async () => {
  const s = await ready();
  await s.coordinator.create(draft());
  const originalId = [...s.notifications.pending.keys()][0];
  s.storage.hooks.beforeWrite = (value) => {
    if (value.ownerPaused) throw new Error('Pause intent failed');
  };
  assert.equal((await s.coordinator.quiesceAndCancelOwner()).ok, false);
  assert.equal((await s.store.load()).ownerPaused, false);
  assert.equal((await s.coordinator.resumeOwner()).ok, true);
  assert.equal(schedules(s).length, 1);
  assert.equal(s.notifications.pending.has(originalId), true);
  s.storage.hooks.beforeWrite = null;
  assert.equal((await s.coordinator.create(draft('After recovery'))).ok, true);
  s.coordinator.dispose();
});

test('automatic preference enable snapshots keys atomically and notices deduplicate after financial durability', async () => {
  const s = await ready();
  const event = {
    key: 'budget-new',
    kind: 'budget',
    title: 'Budget reached',
    body: 'Recorded spending is above this limit.',
    occurredAtMs: NOW,
  };
  await s.coordinator.setAutomaticPreferences({ budgets: true, goal: false, achievements: false }, [
    'budget-old',
  ]);
  let saved = await s.store.load();
  assert.equal(saved.automatic.budgets, true);
  assert.ok(saved.observedEventKeys.includes('budget-old'));
  await s.coordinator.observeFinancialEvents(s.ownerToken, [{ ...event, key: 'budget-old' }]);
  assert.equal(schedules(s).length, 0);
  await s.coordinator.observeFinancialEvents(s.ownerToken, [event]);
  await s.coordinator.observeFinancialEvents(s.ownerToken, [event]);
  assert.equal(schedules(s).length, 1);
  assert.equal(
    (await s.store.load()).observedEventKeys.filter((key) => key === event.key).length,
    1,
  );
  const before = s.storage.writes.length;
  assert.equal(
    (
      await s.coordinator.observeFinancialEvents(encodeReminderOwner(owner('stale')), [
        { ...event, key: 'stale' },
      ])
    ).ok,
    false,
  );
  assert.equal(s.storage.writes.length, before);
  s.coordinator.dispose();
});

test('automatic scheduling failure keeps an error and observed key rather than a render retry loop', async () => {
  const s = await ready();
  await s.coordinator.setAutomaticPreferences(
    { budgets: false, goal: true, achievements: false },
    [],
  );
  const event = {
    key: 'goal-one',
    kind: 'goal',
    title: 'Target reached',
    body: 'Recorded balance reached the saved target.',
    occurredAtMs: NOW,
  };
  s.notifications.hooks.beforeSchedule = () => {
    throw new Error('Native unavailable');
  };
  await s.coordinator.observeFinancialEvents(s.ownerToken, [event]);
  await s.coordinator.observeFinancialEvents(s.ownerToken, [event]);
  assert.equal(schedules(s).length, 1);
  assert.equal(s.coordinator.getSnapshot().automaticNoticeErrors.length, 1);
  assert.equal((await s.store.load()).operations.length, 0);
  s.coordinator.dispose();
});

test('sample automatic events have no persistence or native effect, while manual reminders remain usable', async () => {
  const s = await ready({ sampleMode: true });
  await s.coordinator.setAutomaticPreferences({ budgets: true, goal: true, achievements: true }, [
    'sample-history',
  ]);
  const before = s.storage.writes.length;
  await s.coordinator.observeFinancialEvents(s.ownerToken, [
    {
      key: 'sample',
      kind: 'achievement',
      title: 'Sample award',
      body: 'Synthetic example.',
      occurredAtMs: NOW,
    },
  ]);
  assert.equal(s.storage.writes.length, before);
  assert.equal(schedules(s).length, 0);
  assert.deepEqual((await s.store.load()).observedEventKeys, []);
  assert.equal((await s.coordinator.create(draft())).ok, true);
  s.coordinator.dispose();
});

test('inactive retirement strictly preserves current owner, foreign scopes, foreign origins and invalid metadata', async () => {
  const n = native();
  const active = owner('active');
  const inactive = owner('inactive');
  const foreign = owner('other', 'other-tests');
  function request(id, who) {
    return {
      identifier: id,
      title: 'Synthetic',
      body: 'Reminder',
      scheduledAtMs: NOW + 60000,
      data: {
        origin: 'mmm-reminders-v1',
        ownerToken: encodeReminderOwner(who),
        reminderId: 'reminder-one',
        revision: 1,
        operationId: 'operation-one',
        kind: 'manual',
      },
    };
  }
  n.pending.set('active', request('active', active));
  n.pending.set('inactive', request('inactive', inactive));
  n.pending.set('foreign', request('foreign', foreign));
  n.pending.set('foreign-origin', {
    ...request('foreign-origin', inactive),
    data: { ...request('', inactive).data, origin: 'other-app' },
  });
  n.pending.set('malformed', {
    ...request('malformed', inactive),
    data: { ...request('', inactive).data, ownerToken: 'invalid' },
  });
  const retired = await retireInactiveNotifications({
    scope: active.scope,
    activeOwner: active,
    notifications: n.adapter,
  });
  assert.equal(retired.ok, true);
  assert.equal(retired.canceledCount, 1);
  assert.deepEqual([...n.pending.keys()].sort(), [
    'active',
    'foreign',
    'foreign-origin',
    'malformed',
  ]);
  await assert.rejects(() =>
    retireInactiveNotifications({
      scope: { kind: 'canonical' },
      activeOwner: active,
      notifications: n.adapter,
    }),
  );
});

test('retirement stops after delayed enumeration when the active owner changes', async () => {
  const n = native();
  const active = owner('active');
  const next = owner('next');
  const entered = deferred();
  const release = deferred();
  let stillActive = true;
  n.hooks.beforeList = async () => {
    entered.resolve();
    await release.promise;
  };
  const sweeping = retireInactiveNotifications({
    scope: active.scope,
    activeOwner: active,
    notifications: n.adapter,
    stillActive: () => stillActive,
  });
  await entered.promise;
  n.pending.set('new-owner', {
    identifier: 'new-owner',
    title: 'New',
    body: 'Future',
    scheduledAtMs: NOW + 60000,
    data: {
      origin: 'mmm-reminders-v1',
      ownerToken: encodeReminderOwner(next),
      reminderId: 'reminder-next',
      revision: 1,
      operationId: 'operation-next',
      kind: 'manual',
    },
  });
  stillActive = false;
  release.resolve();
  const outcome = await sweeping;
  assert.equal(outcome.ok, false);
  assert.equal(n.calls.filter((item) => item.method === 'cancel').length, 0);
  assert.equal(n.pending.has('new-owner'), true);
});

test('retirement checks the active generation before every cancellation and reports a mid-sweep change', async () => {
  const n = native();
  const active = owner('active');
  const inactive = owner('inactive');
  for (const id of ['first', 'second'])
    n.pending.set(id, {
      identifier: id,
      title: 'Old',
      body: 'Pending',
      scheduledAtMs: NOW + 60000,
      data: {
        origin: 'mmm-reminders-v1',
        ownerToken: encodeReminderOwner(inactive),
        reminderId: `reminder-${id}`,
        revision: 1,
        operationId: `operation-${id}`,
        kind: 'manual',
      },
    });
  let current = true;
  n.hooks.afterCancel = () => {
    current = false;
  };
  const outcome = await retireInactiveNotifications({
    scope: active.scope,
    activeOwner: active,
    notifications: n.adapter,
    stillActive: () => current,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.canceledCount, 1);
  assert.equal(n.calls.filter((item) => item.method === 'cancel').length, 1);
  assert.equal(n.pending.has('second'), true);
});
