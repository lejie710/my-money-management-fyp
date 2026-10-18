const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTsSource } = require('./helpers/hook-host.cjs');
const identity = require('../src/accounts/identity');
const model = require('../src/core/model');
const { encodeReminderOwner } = require('../src/reminders/store');
const { createAccountPresentation } = loadTsSource(
  path.join(__dirname, '../src/accounts/accountPresentation.ts'),
  { './identity': identity, '../core/model': model },
);
const scope = { kind: 'test', namespace: 'presentation-test' };
const familyFor = (uid) => ({
  scope,
  actor: uid ? { kind: 'firebase', uid } : { kind: 'local' },
});
const ownerFor = (uid, incarnationId = 'wallet-one') =>
  encodeReminderOwner({ ...familyFor(uid), incarnationId });
function ready(uid = null) {
  return {
    phase: 'ready',
    provider: 'local-emulator',
    family: familyFor(uid),
    user: uid ? { uid, email: `${uid}@example.test`, displayName: 'Synthetic name' } : null,
    activeOwnerToken: ownerFor(uid),
    operation: null,
    persistence: 'confirmed',
    sessionRestored: true,
    recovery: 'retry',
    service: 'available',
    message: 'Saved wallet ready.',
    profileNamePending: false,
    profileExtras: null,
    profileExtrasStatus: 'none',
    capabilities: {
      signIn: !uid,
      register: !uid,
      signOut: !!uid,
      editProfile: !!uid,
      saveProfileExtras: !!uid,
      retry: true,
    },
  };
}
function fixture(initial = ready(), options = {}) {
  let view = initial,
    date = '2026-10-18';
  const listeners = new Set(),
    calls = [];
  const result = { ok: true, pending: false, message: 'Confirmed.' };
  const coordinator = {
    getSnapshot: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    initialize() {
      calls.push(['initialize']);
      return Promise.resolve(result);
    },
    dispose() {
      calls.push(['dispose']);
    },
  };
  for (const name of [
    'signIn',
    'register',
    'signOut',
    'updateDisplayName',
    'saveProfileExtras',
    'retry',
  ])
    coordinator[name] = (...args) => {
      calls.push([name, ...args]);
      return Promise.resolve(result);
    };
  const controller = createAccountPresentation({
    coordinator,
    today: () => date,
    ...options,
  });
  return {
    controller,
    calls,
    result,
    listeners,
    set(patch) {
      view = { ...view, ...patch };
      for (const listener of [...listeners]) listener();
    },
    replace(value) {
      view = value;
      for (const listener of [...listeners]) listener();
    },
    setDate(value) {
      date = value;
    },
  };
}

test('projection is stable, detached, whitelisted and starts no account effects', () => {
  const source = ready('actor-a');
  source.user.privateSdkPayload = 'synthetic-private-field';
  source.profileExtras = {
    gender: 'nonbinary',
    birthDate: '2000-02-29',
    privateField: 'omit',
  };
  source.profileExtrasStatus = 'ready';
  const f = fixture(source),
    first = f.controller.getSnapshot();
  let updates = 0;
  f.controller.subscribe(() => updates++);
  f.set({ message: source.message });
  f.controller.refresh();
  assert.strictEqual(f.controller.getSnapshot(), first);
  assert.equal(updates, 0);
  assert.deepEqual(f.calls, []);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.user), true);
  assert.equal(Object.isFrozen(first.profile.extras), true);
  assert.deepEqual(Object.keys(first.user).sort(), ['displayName', 'email', 'uid']);
  assert.deepEqual(Object.keys(first.profile.extras).sort(), ['birthDate', 'gender']);
  assert.equal(JSON.stringify(first).includes('synthetic-private-field'), false);
  source.user.displayName = 'Later external mutation';
  assert.equal(first.user.displayName, 'Synthetic name');
});

test('view token survives ordinary status and transient missing owner, changes for confirmed actor or fresh wallet', () => {
  const f = fixture(ready('actor-a')),
    initial = f.controller.getSnapshot().viewToken;
  f.set({
    message: 'Checking.',
    phase: 'switching',
    activeOwnerToken: null,
    capabilities: { ...ready('actor-a').capabilities, retry: false },
  });
  assert.equal(f.controller.getSnapshot().viewToken, initial);
  f.replace(ready('actor-a'));
  assert.equal(f.controller.getSnapshot().viewToken, initial);
  f.replace(ready('actor-b'));
  const accountB = f.controller.getSnapshot().viewToken;
  assert.notEqual(accountB, initial);
  f.set({ activeOwnerToken: ownerFor('actor-b', 'wallet-fresh') });
  assert.notEqual(f.controller.getSnapshot().viewToken, accountB);
  const fresh = f.controller.getSnapshot().viewToken;
  f.set({
    message: 'Name saved.',
    user: { ...ready('actor-b').user, displayName: 'Renamed' },
  });
  assert.equal(f.controller.getSnapshot().viewToken, fresh);
});

test('unknown identity retires forms once and recovery cannot restore the old form token', () => {
  const f = fixture(ready('actor-a')),
    initial = f.controller.getSnapshot().viewToken;
  f.set({
    phase: 'session-unavailable',
    persistence: 'unconfirmed',
    family: null,
    activeOwnerToken: null,
  });
  const unknown = f.controller.getSnapshot().viewToken;
  assert.notEqual(unknown, initial);
  f.set({ message: 'Recheck saved session.' });
  assert.equal(f.controller.getSnapshot().viewToken, unknown);
  f.replace(ready('actor-a'));
  assert.notEqual(f.controller.getSnapshot().viewToken, initial);
  assert.notEqual(f.controller.getSnapshot().viewToken, unknown);
});

test('a confirmed actor change invalidates forms before its wallet finishes opening', () => {
  const f = fixture(ready('actor-a')),
    initial = f.controller.getSnapshot().viewToken;
  f.replace({
    ...ready('actor-b'),
    phase: 'switching',
    activeOwnerToken: null,
    capabilities: { ...ready('actor-b').capabilities, retry: false },
  });
  assert.notEqual(f.controller.getSnapshot().viewToken, initial);
  assert.equal(f.controller.getSnapshot().busy, true);
  assert.equal(f.controller.getSnapshot().operation, 'reconcile');
});

test('settled restart recovery is not permanently busy merely because retry is unavailable', () => {
  const f = fixture({
    ...ready(),
    phase: 'session-unavailable',
    persistence: 'unconfirmed',
    activeOwnerToken: null,
    family: null,
    recovery: 'restart',
    capabilities: {
      signIn: false,
      register: false,
      signOut: false,
      editProfile: false,
      saveProfileExtras: false,
      retry: false,
    },
  });
  assert.equal(f.controller.getSnapshot().busy, false);
  assert.equal(f.controller.getSnapshot().operation, null);
  assert.equal(f.controller.getSnapshot().canRetry, false);
  assert.match(f.controller.getSnapshot().blockedReason, /Restart required/);
  f.set({ phase: 'restoring' });
  assert.equal(f.controller.getSnapshot().busy, true);
});

test('profile absence stays optional; uncertain extras cannot gain overwrite capability from name editing', () => {
  const f = fixture(ready('actor-a'));
  assert.equal(f.controller.getSnapshot().profile.phase, 'ready');
  assert.equal(f.controller.getSnapshot().profile.extras, null);
  f.set({
    profileNamePending: true,
    profileExtrasStatus: 'uncertain',
    operation: 'profile-extras',
    capabilities: {
      ...ready('actor-a').capabilities,
      saveProfileExtras: false,
      retry: false,
    },
  });
  let view = f.controller.getSnapshot();
  assert.equal(view.operation, 'profile');
  assert.equal(view.profile.phase, 'unavailable');
  assert.equal(view.profile.displayNamePending, true);
  assert.equal(view.canEditProfile, true);
  assert.equal(view.canSaveLocalProfile, false);
  assert.match(view.profile.error, /could not be confirmed/);
  f.set({
    operation: null,
    capabilities: {
      ...ready('actor-a').capabilities,
      saveProfileExtras: false,
    },
  });
  view = f.controller.getSnapshot();
  assert.equal(view.busy, false);
  assert.equal(view.canRetry, true);
});

test('reset allocation is explicit and unavailable for absent provider, unavailable identity or closed presentation', () => {
  let allocations = 0;
  const reset = { synthetic: true },
    factory = () => {
      allocations++;
      return reset;
    };
  const f = fixture(ready(), { createResetSession: factory });
  assert.equal(allocations, 0);
  assert.equal(f.controller.getSnapshot().canRequestReset, true);
  assert.strictEqual(f.controller.createResetSession(), reset);
  assert.equal(allocations, 1);
  f.set({ provider: 'unconfigured' });
  assert.equal(f.controller.getSnapshot().canRequestReset, false);
  assert.throws(() => f.controller.createResetSession(), /unavailable/);
  f.set({
    provider: 'local-emulator',
    phase: 'session-unavailable',
    persistence: 'unconfirmed',
  });
  assert.throws(() => f.controller.createResetSession(), /unavailable/);
  f.replace(ready());
  f.controller.dispose();
  assert.throws(() => f.controller.createResetSession(), /unavailable/);
  assert.equal(allocations, 1);
  const noFactory = fixture();
  assert.equal(noFactory.controller.getSnapshot().canRequestReset, false);
  assert.throws(() => noFactory.controller.createResetSession(), /unavailable/);
});

test('methods preserve exact input and retryProfile uses only the injected reconciliation wrapper', async () => {
  let retries = 0;
  const wrapperResult = {
    ok: false,
    pending: true,
    message: 'Wallet readback pending.',
  };
  const f = fixture(ready(), {
    retry: async () => {
      retries++;
      return wrapperResult;
    },
  });
  const credentials = {
    email: 'synthetic@example.test',
    password: '  exact characters  ',
  };
  assert.strictEqual(await f.controller.signIn(credentials), f.result);
  await f.controller.register({ ...credentials, displayName: 'Explicit name' });
  await f.controller.updateDisplayName('Chosen name');
  await f.controller.saveLocalProfile({ gender: '', birthDate: null });
  await f.controller.signOut();
  assert.strictEqual(await f.controller.retry(), wrapperResult);
  assert.strictEqual(await f.controller.retryProfile(), wrapperResult);
  assert.equal(retries, 2);
  assert.strictEqual(f.calls[0][1], credentials);
  assert.deepEqual(
    f.calls.map(([name]) => name),
    ['signIn', 'register', 'updateDisplayName', 'saveProfileExtras', 'signOut'],
  );
  const normal = fixture();
  await normal.controller.retryProfile();
  assert.deepEqual(normal.calls, [['retry']]);
});

test('foreground date refresh emits once, does not replace the actor token, and observer failures are isolated', () => {
  const f = fixture(),
    initial = f.controller.getSnapshot();
  let delivered = 0;
  const stop = f.controller.subscribe(() => {
    throw Error('observer');
  });
  f.controller.subscribe(() => delivered++);
  f.setDate('2026-10-19');
  assert.equal(f.controller.getSnapshot().today, '2026-10-18');
  f.controller.refresh();
  assert.equal(delivered, 1);
  assert.equal(f.controller.getSnapshot().today, '2026-10-19');
  assert.equal(f.controller.getSnapshot().viewToken, initial.viewToken);
  f.controller.refresh();
  assert.equal(delivered, 1);
  stop();
  assert.deepEqual(f.calls, []);
});

test('dispose is idempotent, removes only projection subscription, and blocks stale mutation callbacks', async () => {
  const f = fixture();
  let delivered = 0;
  f.controller.subscribe(() => delivered++);
  const old = f.controller.signOut,
    first = f.controller.getSnapshot();
  f.controller.dispose();
  f.controller.dispose();
  assert.equal(f.listeners.size, 0);
  f.replace(ready('other'));
  f.controller.refresh();
  assert.strictEqual(f.controller.getSnapshot(), first);
  assert.equal(delivered, 0);
  assert.equal((await old()).ok, false);
  assert.equal((await f.controller.retry()).ok, false);
  assert.deepEqual(f.calls, []);
});
