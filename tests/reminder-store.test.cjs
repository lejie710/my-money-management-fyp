'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  encodeReminderOwner,
  decodeReminderOwner,
  sameReminderScope,
  reminderStorageKey,
  createReminderStore,
  parseReminderDelay,
  MAX_REMINDER_DELAY_SECONDS,
} = require('../src/reminders/store');
const { owner, memory, setup, draft } = require('./reminder-fixtures.cjs');

test('a full event history can reopen and snapshot the same baseline without counting duplicates as new events', async () => {
  const keys = Array.from({ length: 20000 }, (_, index) => `historical-${index}`);
  const original = setup();
  assert.equal((await original.coordinator.initialize(keys)).ok, true);
  original.coordinator.dispose();
  const reopened = setup({ storage: original.storage, notifications: original.notifications });
  assert.equal((await reopened.coordinator.initialize(keys)).ok, true);
  const preferences = { budgets: true, goal: false, achievements: false };
  assert.equal((await reopened.coordinator.setAutomaticPreferences(preferences, keys)).ok, true);
  assert.equal((await reopened.store.load()).observedEventKeys.length, 20000);
  assert.equal(reopened.notifications.calls.filter((call) => call.method === 'schedule').length, 0);
  assert.throws(
    () => reopened.coordinator.setAutomaticPreferences(preferences, [...keys, 'new-event']),
    /too large/,
  );
  reopened.coordinator.dispose();
});

test('reminder owner tokens separate canonical/test scopes, account tags and wallet incarnations', () => {
  const canonical = {
    scope: { kind: 'canonical' },
    actor: { kind: 'local' },
    incarnationId: 'wallet-one',
  };
  const contexts = [
    canonical,
    owner('wallet-one', 'canonical'),
    owner('wallet-two', 'canonical'),
    { ...canonical, actor: { kind: 'firebase', uid: 'local' } },
  ];
  const keys = contexts.map(reminderStorageKey);
  assert.equal(new Set(keys).size, contexts.length);
  for (const context of contexts)
    assert.deepEqual(decodeReminderOwner(encodeReminderOwner(context)), context);
  assert.equal(sameReminderScope(canonical.scope, contexts[3].scope), true);
  assert.equal(sameReminderScope(canonical.scope, contexts[1].scope), false);
  assert.ok(keys.every((key) => key.startsWith('@mymoney/reminders/v1/')));
});

test('owner decoding rejects malformed, ambiguous and excessive metadata', () => {
  const token = encodeReminderOwner(owner());
  for (const value of [
    null,
    {},
    'broken',
    token + ' ',
    '[]',
    '["canonical","unexpected","local",null,"wallet-one"]',
    '["canonical",null,"local","unexpected","wallet-one"]',
    '["other",null,"local",null,"wallet-one"]',
    '["test"," ","local",null,"wallet-one"]',
    '["canonical",null,"local",null,"../escape"]',
    'x'.repeat(3000),
  ]) {
    assert.throws(() => decodeReminderOwner(value));
  }
  assert.throws(() => encodeReminderOwner({ ...owner(), extra: true }));
  assert.throws(() =>
    encodeReminderOwner({ ...owner(), scope: { kind: 'canonical', namespace: 'test' } }),
  );
});

test('delay parsing is strict whole seconds with an explicit one-year bound', () => {
  assert.equal(parseReminderDelay(' 00060 '), 60);
  assert.equal(parseReminderDelay('1'), 1);
  assert.equal(parseReminderDelay(String(MAX_REMINDER_DELAY_SECONDS)), MAX_REMINDER_DELAY_SECONDS);
  for (const value of [
    '',
    '0',
    '-1',
    '+1',
    '1.5',
    '10seconds',
    '1e3',
    '1,000',
    'Infinity',
    '31536001',
    null,
    60,
  ])
    assert.throws(() => parseReminderDelay(value));
});

test('missing reminder data differs from corrupt, future-version or wrong-owner data', async () => {
  const data = memory();
  const store = createReminderStore(data.adapter, owner());
  assert.equal(await store.load(), null);
  const valid = store.empty();
  for (const bytes of [
    'broken-json',
    JSON.stringify({ ...valid, version: 99 }),
    JSON.stringify({ ...valid, owner: owner('another-wallet') }),
  ]) {
    data.values.set(store.key, bytes);
    await assert.rejects(() => store.load());
    assert.equal(data.values.get(store.key), bytes);
  }
  assert.equal(data.writes.length, 0);
});

test('reminder updates preserve unrelated saved metadata and never write ledger keys', async () => {
  const s = setup();
  const initial = { ...s.store.empty(), futureMetadata: { keep: true } };
  s.storage.values.set(s.store.key, JSON.stringify(initial));
  const financialKey = '@mymoney/core/v4';
  const financialBytes = '{"unrelated":"financial records"}';
  s.storage.values.set(financialKey, financialBytes);
  assert.equal((await s.coordinator.initialize([])).ok, true);
  assert.equal((await s.coordinator.create(draft())).ok, true);
  assert.deepEqual((await s.store.load()).futureMetadata, { keep: true });
  assert.equal(s.storage.values.get(financialKey), financialBytes);
  assert.ok(s.storage.writes.every((item) => item.key === s.store.key));
  s.coordinator.dispose();
});

test('saved reminder and journal validation rejects broken references and partial records', async () => {
  const s = setup();
  await s.coordinator.initialize([]);
  await s.coordinator.create(draft());
  const state = await s.store.load();
  for (const patch of [
    { reminders: [state.reminders[0], state.reminders[0]] },
    { reminders: [{ ...state.reminders[0], revision: 0 }] },
    { reminders: [{ ...state.reminders[0], scheduledAtMs: NaN }] },
    { reminders: [{ ...state.reminders[0], notificationId: null }] },
    { observedEventKeys: ['event', 'event'] },
    { operations: [{ kind: 'edit' }] },
    { ownerPaused: 'false' },
  ])
    await assert.rejects(() => s.store.save({ ...state, ...patch }));
  s.coordinator.dispose();
});
