const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFirebaseAuthAdapter,
  CONFIG,
  EMULATOR_URL,
} = require('../src/accounts/firebaseAdapter');
const { encodeDataScope } = require('../src/accounts/identity');
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
function fakeUser(name = 'A') {
  return {
    uid: `uid-${name}`,
    email: `${name.toLowerCase()}@example.test`,
    displayName: name,
    opaque: `synthetic-${name}`,
    toJSON() {
      return {
        uid: this.uid,
        email: this.email,
        displayName: this.displayName,
        opaque: this.opaque,
      };
    },
  };
}
function fixture(options = {}) {
  const events = [],
    values = new Map(),
    apps = [],
    scope = { kind: 'test', namespace: options.namespace ?? 'firebase-adapter-unit' };
  const cloud = options.configuration;
  const appName = cloud
    ? `mymoney-cloud-${cloud.firebase.projectId}-${encodeURIComponent(encodeDataScope(scope))}`
    : `mymoney-local-${encodeURIComponent(encodeDataScope(scope))}`;
  const sessionKey = `firebase:authUser:${cloud?.firebase.apiKey ?? CONFIG.apiKey}:${appName}`;
  const storedKey = cloud
    ? `@mymoney/auth-cloud/v1/${cloud.firebase.projectId}/${encodeURIComponent(encodeDataScope(scope))}/${encodeURIComponent(sessionKey)}`
    : `@mymoney/auth/v1/${encodeURIComponent(encodeDataScope(scope))}/${encodeURIComponent(sessionKey)}`;
  if (options.initial !== undefined) values.set(storedKey, options.initial);
  const storage = {
    async getItem(key) {
      events.push('storage-read');
      if (options.read) return options.read(key, values);
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      if (options.beforeSet?.(key)) throw Error('Private write failure');
      values.set(key, value);
      if (options.afterSet?.(key)) throw Error('Response lost');
    },
    async removeItem(key) {
      values.delete(key);
    },
  };
  let auth, persistence, before, onAbort;
  const callbacks = [];
  async function apply(user) {
    await before(user);
    if (options.abortAfterGuard) {
      onAbort();
      throw Object.assign(Error('Other middleware rejected'), { code: 'auth/login-blocked' });
    }
    events.push('identity-assigned');
    auth.currentUser = user;
    if (user) await persistence.setItem(sessionKey, JSON.stringify(user.toJSON()));
    else await persistence.removeItem(sessionKey);
    callbacks.forEach((callback) => callback(user));
  }
  const sdk = {
    getApps() {
      return options.existingApp ? [{ name: appName }] : apps;
    },
    initializeApp(config, name) {
      events.push('initializeApp');
      const app = { name, options: config };
      apps.push(app);
      return app;
    },
    async deleteApp() {
      events.push('deleteApp');
    },
    getReactNativePersistence(value) {
      persistence = value;
      return value;
    },
    initializeAuth() {
      events.push('initializeAuth');
      auth = { currentUser: null, ...(options.tenantId ? { tenantId: options.tenantId } : {}) };
      const ready = Promise.resolve().then(async () => {
        try {
          if (!options.memoryFallback) {
            await persistence.setItem('__sak', '1');
            await persistence.removeItem('__sak');
          }
          const raw = options.memoryFallback ? null : await persistence.getItem(sessionKey);
          if (raw && !options.hydrationDeletes)
            auth.currentUser = Object.assign(fakeUser(), JSON.parse(raw));
          if (options.hydrationDeletes) await persistence.removeItem(sessionKey);
        } catch {
          auth.currentUser = null;
        }
        callbacks.forEach((callback) => callback(auth.currentUser));
      });
      auth.authStateReady = () => ready;
      return auth;
    },
    connectAuthEmulator(_auth, url) {
      events.push('connectEmulator');
      assert.equal(
        url,
        cloud?.emulators ? `http://127.0.0.1:${cloud.emulators.auth}` : EMULATOR_URL,
      );
      if (options.connectError) throw Error('Failed setup');
      _auth.emulatorConfig = {
        host: '127.0.0.1',
        port: cloud?.emulators?.auth ?? 9099,
        protocol: 'http',
      };
    },
    beforeAuthStateChanged(_auth, callback, abort) {
      events.push('beforeAuthStateChanged');
      before = callback;
      onAbort = abort;
      return () => {};
    },
    onAuthStateChanged(_auth, callback) {
      events.push('onAuthStateChanged');
      callbacks.push(callback);
      return () => {};
    },
    async signInWithEmailAndPassword(_auth, email) {
      events.push('signIn');
      if (options.signInError) throw options.signInError;
      await apply(fakeUser(email.startsWith('b') ? 'B' : 'A'));
    },
    async createUserWithEmailAndPassword() {
      events.push('register');
      await apply(fakeUser('NEW'));
    },
    async signOut() {
      events.push('signOut');
      await apply(null);
    },
    async updateProfile(user, profile) {
      events.push('updateProfile');
      user.displayName = profile.displayName;
      await persistence.setItem(sessionKey, JSON.stringify(user.toJSON()));
    },
    async sendPasswordResetEmail() {
      events.push('reset-send');
    },
    async verifyPasswordResetCode() {
      return 'a@example.test';
    },
    async confirmPasswordReset() {},
  };
  const runtime = {};
  const adapter = createFirebaseAuthAdapter({
    runtime,
    scope,
    storage,
    sdk,
    configuration: options.configuration,
    timeoutMs: options.timeoutMs ?? 1000,
    fetchImpl: options.fetchImpl,
  });
  return {
    adapter,
    events,
    values,
    storedKey,
    storage,
    sdk,
    scope,
    runtime,
    get auth() {
      return auth;
    },
    beforeChange: async () => {
      events.push('financial-guard');
    },
  };
}

test('initialize/connect/middleware are synchronous before storage awaits; initial restoration emits no change-only replay', async () => {
  const f = fixture();
  let signals = 0;
  f.adapter.subscribe(() => {
    signals++;
  });
  const ready = f.adapter.initialize(f.beforeChange);
  assert.deepEqual(f.events, [
    'initializeApp',
    'initializeAuth',
    'connectEmulator',
    'beforeAuthStateChanged',
    'onAuthStateChanged',
  ]);
  const state = await ready;
  assert.equal(state.persistence, 'confirmed');
  assert.equal(state.user, null);
  assert.equal(state.mutationPending, false);
  assert.equal(signals, 0);
});

test('realistic SDK mutation assigns memory before persistence, with guard before assignment and exact confirmation afterward', async () => {
  const f = fixture();
  await f.adapter.initialize(f.beforeChange);
  await f.adapter.signIn({ email: 'a@example.test', password: 'synthetic' });
  assert.ok(f.events.indexOf('financial-guard') < f.events.indexOf('identity-assigned'));
  const signed = await f.adapter.confirmIdentity();
  assert.equal(signed.user.uid, 'uid-A');
  assert.equal(signed.persistence, 'confirmed');
  assert.equal(Object.keys(signed.user).sort().join(','), 'displayName,email,uid');
  await f.adapter.updateDisplayName('uid-A', ' Updated ');
  assert.equal((await f.adapter.confirmIdentity()).user.displayName, 'Updated');
  await f.adapter.signOut();
  assert.equal((await f.adapter.confirmIdentity()).user, null);
});

test('failed SDK persistence cannot claim the in-memory identity is durable and blocks another mutation', async () => {
  const f = fixture({ beforeSet: (key) => key.includes('authUser') });
  await f.adapter.initialize(f.beforeChange);
  await assert.rejects(f.adapter.signIn({ email: 'b@example.test', password: 'synthetic' }));
  const state = await f.adapter.confirmIdentity();
  assert.equal(state.user.uid, 'uid-B');
  assert.equal(state.persistence, 'unconfirmed');
  assert.equal(state.recovery, 'restart');
  assert.equal(f.values.has(f.storedKey), false);
  await assert.rejects(f.adapter.signOut(), /restart/);
  assert.equal(f.events.filter((value) => value === 'signOut').length, 0);
});

test('write-then-throw is confirmed through opaque readback rather than a false error', async () => {
  const f = fixture({ afterSet: (key) => key.includes('authUser') });
  await f.adapter.initialize(f.beforeChange);
  await f.adapter.signIn({ email: 'a@example.test', password: 'synthetic' });
  assert.equal((await f.adapter.confirmIdentity()).persistence, 'confirmed');
});

test('SDK memory fallback, malformed bytes and hydration deletion remain unconfirmed without losing saved bytes', async () => {
  const original = JSON.stringify(fakeUser().toJSON());
  for (const options of [
    { memoryFallback: true },
    { initial: original, hydrationDeletes: true },
    { initial: 'not JSON with synthetic private marker' },
  ]) {
    const f = fixture(options);
    const state = await f.adapter.initialize(f.beforeChange);
    assert.equal(state.persistence, 'unconfirmed');
    assert.equal(state.recovery, 'restart');
    if (options.initial) assert.equal(f.values.get(f.storedKey), options.initial);
  }
});

test('wrong password preserves previous identity and safe failure drops SDK payloads', async () => {
  const original = JSON.stringify(fakeUser().toJSON());
  const f = fixture({
    initial: original,
    signInError: Object.assign(Error('DO_NOT_LOG_RAW_PAYLOAD'), {
      code: 'auth/wrong-password',
      customData: { private: true },
    }),
  });
  await f.adapter.initialize(f.beforeChange);
  await assert.rejects(
    f.adapter.signIn({ email: 'b@example.test', password: 'wrong' }),
    (error) =>
      error.code === 'auth/wrong-password' &&
      !error.message.includes('DO_NOT_LOG') &&
      !Object.hasOwn(error, 'customData'),
  );
  const state = await f.adapter.confirmIdentity();
  assert.equal(state.user.uid, 'uid-A');
  assert.equal(state.persistence, 'confirmed');
});

test('same-runtime reuse is exact, and an existing unknown named app is never reused or deleted', async () => {
  const f = fixture();
  assert.equal(
    createFirebaseAuthAdapter({
      runtime: f.runtime,
      scope: f.scope,
      storage: f.storage,
      sdk: { ...f.sdk },
    }),
    f.adapter,
  );
  assert.throws(
    () =>
      createFirebaseAuthAdapter({
        runtime: f.runtime,
        scope: { kind: 'canonical' },
        storage: f.storage,
        sdk: f.sdk,
      }),
    /another storage scope/,
  );
  const collision = fixture({ existingApp: true });
  assert.equal((await collision.adapter.initialize(collision.beforeChange)).recovery, 'restart');
  assert.equal(collision.events.includes('deleteApp'), false);
  const setup = fixture({ connectError: true });
  assert.equal((await setup.adapter.initialize(setup.beforeChange)).persistence, 'unconfirmed');
  assert.ok(setup.events.includes('deleteApp'));
});

test('opaque serialization mismatch requires restart rather than inventing rollback or reading token fields', async () => {
  const f = fixture();
  await f.adapter.initialize(f.beforeChange);
  await f.adapter.signIn({ email: 'a@example.test', password: 'synthetic' });
  f.values.set(f.storedKey, JSON.stringify({ unrelated: 'different saved session bytes' }));
  const state = await f.adapter.confirmIdentity();
  assert.equal(state.persistence, 'unconfirmed');
  assert.equal(state.recovery, 'restart');
});

test('middleware abort emits a confirmation signal and does not assert rollback success', async () => {
  const f = fixture({ abortAfterGuard: true });
  await f.adapter.initialize(f.beforeChange);
  let signals = 0;
  f.adapter.subscribe(() => {
    signals++;
  });
  await assert.rejects(f.adapter.signIn({ email: 'a@example.test', password: 'synthetic' }));
  assert.ok(signals > 0);
  assert.equal(f.events.includes('identity-assigned'), false);
  assert.equal((await f.adapter.confirmIdentity()).user, null);
});

test('bounded initialization wait retains mutationPending until the actual storage work settles', async () => {
  const read = deferred();
  let stalled = true;
  const f = fixture({
    timeoutMs: 1,
    read: async (key, values) => (stalled ? read.promise : (values.get(key) ?? null)),
  });
  const initial = await f.adapter.initialize(f.beforeChange);
  assert.equal(initial.persistence, 'unconfirmed');
  assert.equal(initial.mutationPending, true);
  stalled = false;
  read.resolve(null);
  const finished = await f.adapter.initialize(f.beforeChange);
  assert.equal(finished.persistence, 'confirmed');
  assert.equal(finished.mutationPending, false);
});

test('reset work shares the SDK operation gate and its completion signals an interrupted identity check', async () => {
  const inbox = deferred();
  const f = fixture({ fetchImpl: () => inbox.promise });
  await f.adapter.initialize(f.beforeChange);
  let signals = 0;
  f.adapter.subscribe(() => {
    signals++;
  });
  const reset = f.adapter.createResetSession();
  const request = reset.request('a@example.test');
  assert.equal((await f.adapter.confirmIdentity()).mutationPending, true);
  await assert.rejects(
    f.adapter.signIn({ email: 'a@example.test', password: 'synthetic' }),
    /still settling/,
  );
  assert.equal(f.events.includes('signIn'), false);
  inbox.resolve({ ok: true, text: async () => JSON.stringify({ oobCodes: [] }) });
  await request;
  assert.equal((await f.adapter.confirmIdentity()).mutationPending, false);
  assert.ok(signals > 0);
  reset.close();
});

test('an old reset session cannot act after an account mutation changes its binding context', async () => {
  let fetched = 0;
  const f = fixture({
    fetchImpl: async () => {
      fetched++;
      return { ok: true, text: async () => JSON.stringify({ oobCodes: [] }) };
    },
  });
  await f.adapter.initialize(f.beforeChange);
  const reset = f.adapter.createResetSession();
  await f.adapter.signIn({ email: 'a@example.test', password: 'synthetic' });
  assert.equal((await reset.request('a@example.test')).ok, false);
  assert.equal(fetched, 0);
  assert.equal(f.events.includes('reset-send'), false);
});

function cloudConfiguration(projectId = 'project-alpha', mode = 'hosted') {
  return {
    mode,
    firebase: {
      projectId,
      apiKey: 'synthetic-client-config',
      appId: 'synthetic-app',
      authDomain: projectId + '.firebaseapp.com',
      storageBucket: projectId + '.appspot.com',
    },
    ...(mode === 'emulator'
      ? { emulators: { auth: 19099, firestore: 18080, storage: 19199 } }
      : {}),
  };
}
test('hosted Auth preserves guarded persistence and uses separate project-bound SDK apps and session stores', async () => {
  const a = fixture({ configuration: cloudConfiguration() }),
    b = fixture({ configuration: cloudConfiguration('project-bravo') });
  for (const f of [a, b]) {
    await f.adapter.initialize(f.beforeChange);
    assert.equal(f.events.includes('connectEmulator'), false);
    await f.adapter.signIn({ email: 'a@example.test', password: 'synthetic' });
    assert.equal((await f.adapter.confirmIdentity()).persistence, 'confirmed');
  }
  assert.equal(
    (await a.adapter.confirmIdentity()).user.uid,
    (await b.adapter.confirmIdentity()).user.uid,
  );
  assert.notEqual(a.storedKey, b.storedKey);
  assert.ok(a.values.has(a.storedKey));
  assert.ok(b.values.has(b.storedKey));
  assert.equal(a.adapter.getSdkContext().configuration.firebase.projectId, 'project-alpha');
});
test('same runtime refuses project changes before returning another adapter', async () => {
  const f = fixture({ configuration: cloudConfiguration() });
  await f.adapter.initialize(f.beforeChange);
  assert.throws(
    () =>
      createFirebaseAuthAdapter({
        runtime: f.runtime,
        scope: f.scope,
        storage: f.storage,
        sdk: f.sdk,
        configuration: cloudConfiguration('project-bravo'),
      }),
    /another storage scope|another/,
  );
});
test('cloud demonstration connects the explicitly configured loopback Auth port and rejects tenancy', async () => {
  const f = fixture({ configuration: cloudConfiguration('demo-money-backup', 'emulator') });
  assert.equal((await f.adapter.initialize(f.beforeChange)).persistence, 'confirmed');
  assert.equal(f.events.includes('connectEmulator'), true);
  assert.equal(f.auth.emulatorConfig.port, 19099);
  const tenant = fixture({ configuration: cloudConfiguration(), tenantId: 'unsupported-tenant' });
  assert.equal((await tenant.adapter.initialize(tenant.beforeChange)).persistence, 'unconfirmed');
  assert.throws(() => tenant.adapter.getSdkContext());
});
test('hosted reset is an explicit request with no emulator inbox and no wallet/session mutation', async () => {
  const f = fixture({ configuration: cloudConfiguration() });
  await f.adapter.initialize(f.beforeChange);
  await f.adapter.signIn({ email: 'a@example.test', password: 'synthetic' });
  const before = new Map(f.values);
  assert.throws(() => f.adapter.createResetSession(), /Hosted accounts/);
  await f.adapter.requestPasswordReset('a@example.test');
  assert.ok(f.events.includes('reset-send'));
  assert.deepEqual(f.values, before);
  assert.equal((await f.adapter.confirmIdentity()).user.uid, 'uid-A');
});

test('known SDK hydration removal can be explicitly retired but this adapter stays gated until restart', async () => {
  const original = JSON.stringify(fakeUser().toJSON()),
    f = fixture({ initial: original, hydrationDeletes: true });
  f.values.set('unrelated-wallet', 'retained');
  const before = await f.adapter.initialize(f.beforeChange);
  assert.equal(before.persistence, 'unconfirmed');
  assert.equal(before.recovery, 'restart');
  assert.match(before.sessionRetirementToken, /^saved-sign-in-/);
  await assert.rejects(f.adapter.signOut());
  assert.deepEqual(await f.adapter.retireSavedSession(before.sessionRetirementToken), {
    retired: true,
  });
  assert.equal(f.values.has(f.storedKey), false);
  assert.equal(f.values.get('unrelated-wallet'), 'retained');
  assert.ok(f.events.includes('financial-guard'));
  const after = await f.adapter.confirmIdentity();
  assert.equal(after.persistence, 'unconfirmed');
  assert.equal(after.recovery, 'restart');
  assert.equal(after.sessionRetired, true);
  assert.equal(after.sessionRetirementToken, null);
  await assert.rejects(f.adapter.signIn({ email: 'a@example.test', password: 'synthetic' }));
  await assert.rejects(f.adapter.retireSavedSession(before.sessionRetirementToken));
  const restarted = fixture();
  assert.equal(
    (await restarted.adapter.initialize(restarted.beforeChange)).persistence,
    'confirmed',
  );
});

test('session retirement still waits for the financial guard and rejects mismatched offers', async () => {
  const f = fixture({ initial: JSON.stringify(fakeUser().toJSON()), hydrationDeletes: true });
  const before = await f.adapter.initialize(async () => {
    throw Error('Financial write remains unresolved.');
  });
  const original = f.values.get(f.storedKey);
  await assert.rejects(f.adapter.retireSavedSession(before.sessionRetirementToken + '0'));
  await assert.rejects(f.adapter.retireSavedSession(before.sessionRetirementToken));
  assert.equal(f.values.get(f.storedKey), original);
  assert.equal((await f.adapter.confirmIdentity()).sessionRetired, false);
});
