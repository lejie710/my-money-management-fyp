const { createReminderStore, encodeReminderOwner } = require('../src/reminders/store');
const { createReminderCoordinator } = require('../src/reminders/coordinator');

const NOW = Date.UTC(2026, 9, 18);
const copy = (value) => JSON.parse(JSON.stringify(value));
const owner = (incarnationId = 'wallet-one', namespace = 'reminder-unit') => ({
  scope: { kind: 'test', namespace },
  actor: { kind: 'local' },
  incarnationId,
});
const draft = (title = 'Review spending', seconds = 600) => ({
  title,
  body: 'Open the recorded report.',
  scheduledAtMs: NOW + seconds * 1000,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function memory() {
  const values = new Map();
  const reads = [];
  const writes = [];
  const hooks = { beforeRead: null, beforeWrite: null, afterWrite: null };
  const adapter = {
    async getItem(key) {
      reads.push(key);
      if (hooks.beforeRead) await hooks.beforeRead(key);
      return values.get(key) ?? null;
    },
    async setItem(key, bytes) {
      const parsed = JSON.parse(bytes);
      writes.push({ key, value: parsed });
      if (hooks.beforeWrite) await hooks.beforeWrite(parsed, key);
      values.set(key, bytes);
      if (hooks.afterWrite) await hooks.afterWrite(parsed, key);
    },
  };
  return { values, reads, writes, hooks, adapter };
}

function native() {
  const pending = new Map();
  const calls = [];
  const hooks = {
    beforeList: null,
    beforeSchedule: null,
    afterSchedule: null,
    beforeCancel: null,
    afterCancel: null,
  };
  const control = {
    permission: { status: 'granted', canAskAgain: true, channelEnabled: true },
    requestedPermission: { status: 'granted', canAskAgain: true, channelEnabled: true },
  };
  const adapter = {
    async ensureChannel() {
      calls.push({ method: 'channel' });
    },
    async getPermission() {
      calls.push({ method: 'permission' });
      return copy(control.permission);
    },
    async requestPermission() {
      calls.push({ method: 'request-permission' });
      control.permission = copy(control.requestedPermission);
      return copy(control.permission);
    },
    async listScheduled() {
      calls.push({ method: 'list' });
      if (hooks.beforeList) await hooks.beforeList();
      return [...pending.values()].map(copy);
    },
    async schedule(request) {
      calls.push({ method: 'schedule', request: copy(request) });
      if (hooks.beforeSchedule) await hooks.beforeSchedule(request);
      pending.set(request.identifier, copy(request));
      if (hooks.afterSchedule) await hooks.afterSchedule(request);
      return request.identifier;
    },
    async cancel(identifier) {
      calls.push({ method: 'cancel', identifier });
      if (hooks.beforeCancel) await hooks.beforeCancel(identifier);
      pending.delete(identifier);
      if (hooks.afterCancel) await hooks.afterCancel(identifier);
    },
  };
  return { pending, calls, hooks, control, adapter };
}

function setup(options = {}) {
  const storage = options.storage ?? memory();
  const notifications = options.notifications ?? native();
  const selectedOwner = options.owner ?? owner();
  const clock = options.clock ?? { now: NOW };
  let sequence = 0;
  const store = createReminderStore(storage.adapter, selectedOwner);
  const coordinator = createReminderCoordinator({
    owner: selectedOwner,
    store,
    notifications: notifications.adapter,
    now: () => clock.now,
    newId: (kind) => `${kind}-${options.idPrefix ?? 'unit'}-${++sequence}`,
    sampleMode: options.sampleMode ?? false,
  });
  return {
    storage,
    notifications,
    owner: selectedOwner,
    ownerToken: encodeReminderOwner(selectedOwner),
    clock,
    store,
    coordinator,
  };
}

module.exports = { NOW, copy, owner, draft, deferred, memory, native, setup };
