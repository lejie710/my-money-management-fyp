const test = require('node:test');
const assert = require('node:assert/strict');
const { createGuardedAuthPersistence } = require('../src/accounts/guardedPersistence');
const prefix = '@mymoney/auth/v1/test-scope/';
const sessionKey = 'firebase:authUser:demo-fyp-local:synthetic-app';
const storedKey = prefix + encodeURIComponent(sessionKey);
const original = JSON.stringify({ opaque: 'synthetic-saved-session' });
function fixture(initial = original, faults = {}) {
  const values = new Map(initial === null ? [] : [[storedKey, initial]]);
  const calls = [];
  const adapter = {
    async getItem(key) {
      calls.push(['get', key]);
      if (faults.read?.(key)) throw Error('Private native read detail');
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      calls.push(['set', key]);
      if (faults.beforeSet?.(key)) throw Error('Native failure');
      values.set(key, value);
      if (faults.afterSet?.(key)) throw Error('Response lost');
    },
    async removeItem(key) {
      calls.push(['remove', key]);
      if (faults.beforeRemove?.(key)) throw Error('Native failure');
      values.delete(key);
      if (faults.afterRemove?.(key)) throw Error('Response lost');
    },
  };
  return {
    guard: createGuardedAuthPersistence(adapter, { prefix, sessionKey }),
    values,
    calls,
    adapter,
  };
}
async function available(guard) {
  await guard.storage.setItem('__sak', '1');
  await guard.storage.removeItem('__sak');
}

test('all reads and availability probes are scoped; confirmation needs the actual SDK probe', async () => {
  const f = fixture();
  await f.guard.preflight();
  assert.equal(await f.guard.confirm(original), false);
  await available(f.guard);
  assert.equal(await f.guard.finishInitialization(original), true);
  assert.equal(f.guard.getState().phase, 'ready');
  assert.ok(f.calls.every(([, key]) => key.startsWith(prefix)));
  assert.equal(f.values.get(storedKey), original);
});

test('SDK startup removal cannot erase an existing opaque session after hydration fallback', async () => {
  const f = fixture();
  await f.guard.preflight();
  await available(f.guard);
  await assert.rejects(f.guard.storage.removeItem(sessionKey), /Restart after storage/);
  assert.equal(f.values.get(storedKey), original);
  assert.equal(f.guard.getState().blocked, true);
  assert.equal(await f.guard.finishInitialization(null), false);
});

test('initial read failure is sticky even when storage later works, preventing memory-fallback false success', async () => {
  let fail = true;
  const f = fixture(original, { read: () => fail });
  await assert.rejects(f.guard.preflight(), /persistence could not be confirmed/);
  fail = false;
  assert.equal(await f.guard.confirm(original), false);
  await assert.rejects(f.guard.storage.removeItem(sessionKey));
  assert.equal(f.values.get(storedKey), original);
});

test('availability write/read failure is sticky and does not falsely confirm an empty in-memory session', async () => {
  const f = fixture(null, { beforeSet: (key) => key.endsWith('__sak') });
  await f.guard.preflight();
  await assert.rejects(available(f.guard));
  assert.equal(await f.guard.finishInitialization(null), false);
  assert.equal(f.guard.getState().blocked, true);
});

test('write-then-throw and remove-then-throw are resolved only by exact observed bytes', async () => {
  const f = fixture(original, {
    afterSet: (key) => key === storedKey,
    afterRemove: (key) => key === storedKey,
  });
  await f.guard.preflight();
  await available(f.guard);
  await f.guard.finishInitialization(original);
  const next = JSON.stringify({ opaque: 'replacement-session' });
  await f.guard.storage.setItem(sessionKey, next);
  assert.equal(await f.guard.confirm(next), true);
  await f.guard.storage.removeItem(sessionKey);
  assert.equal(await f.guard.confirm(null), true);
  assert.equal(f.guard.getState().blocked, false);
});

test('failed writes with unchanged bytes or unreadable post-write state stay unconfirmed', async () => {
  let readFailure = false;
  const f = fixture(original, { read: () => readFailure });
  await f.guard.preflight();
  await available(f.guard);
  await f.guard.finishInitialization(original);
  f.adapter.setItem = async (key, value) => {
    f.values.set(key, value);
    readFailure = true;
  };
  await assert.rejects(f.guard.storage.setItem(sessionKey, JSON.stringify({ opaque: 'new' })));
  readFailure = false;
  assert.equal(await f.guard.confirm(f.values.get(storedKey)), false);
  const unchanged = fixture(original, { beforeSet: (key) => key === storedKey });
  await unchanged.guard.preflight();
  await available(unchanged.guard);
  await unchanged.guard.finishInitialization(original);
  await assert.rejects(
    unchanged.guard.storage.setItem(sessionKey, JSON.stringify({ opaque: 'new' })),
  );
  assert.equal(unchanged.values.get(storedKey), original);
  assert.equal(await unchanged.guard.confirm(original), false);
});

test('malformed JSON is retained and fails with a generic message rather than leaking raw saved bytes', async () => {
  const marker = 'DO_NOT_DISPLAY_SYNTHETIC_SESSION';
  const f = fixture(`{"opaque":"${marker}`);
  await assert.rejects(
    f.guard.preflight(),
    (error) => !error.message.includes(marker) && /persistence/.test(error.message),
  );
  assert.equal(f.values.get(storedKey), `{"opaque":"${marker}`);
  assert.equal(f.guard.getState().blocked, true);
});

test('serialized writes compare opaque bytes without interpreting fields or normalizing JSON', async () => {
  const f = fixture('{ "opaque" : [ 1, 2 ] }');
  await f.guard.preflight();
  await available(f.guard);
  assert.equal(await f.guard.confirm('{"opaque":[1,2]}'), false);
  assert.equal(await f.guard.finishInitialization('{ "opaque" : [ 1, 2 ] }'), true);
  const first = JSON.stringify({ opaque: 1 }),
    second = JSON.stringify({ opaque: 2 });
  await Promise.all([
    f.guard.storage.setItem(sessionKey, first),
    f.guard.storage.setItem(sessionKey, second),
  ]);
  assert.equal(await f.guard.confirm(second), true);
});

async function blockedSession(f) {
  await f.guard.preflight();
  await available(f.guard);
  await assert.rejects(f.guard.storage.removeItem(sessionKey));
  const token = f.guard.getState().sessionRetirementToken;
  assert.match(token, /^saved-sign-in-[1-9][0-9]*$/);
  return token;
}

test('known hydration refusal offers a ticket but performs no removal until explicitly confirmed', async () => {
  const f = fixture(),
    token = await blockedSession(f);
  assert.equal(f.values.get(storedKey), original);
  assert.equal(f.calls.filter(([kind, key]) => kind === 'remove' && key === storedKey).length, 0);
  assert.equal(f.guard.getState().sessionRetired, false);
  assert.equal(f.guard.getState().sessionRetirementToken, token);
  // Reading the offer, cancelling a UI choice or retrying confirmation does not delete anything.
  assert.equal(await f.guard.confirm(null), false);
  assert.equal(f.values.get(storedKey), original);
});

test('explicit retirement removes only its exact auth record and permanently rejects late SDK writes', async () => {
  const f = fixture(),
    token = await blockedSession(f);
  for (const [key, value] of [
    ['wallet-A', 'wallet bytes'],
    ['guest-wallet', 'guest bytes'],
    ['profile-A', 'profile bytes'],
    ['photos-A', 'photo index'],
    ['@mymoney/auth/v1/other/auth', 'other session'],
  ])
    f.values.set(key, value);
  const before = new Map(f.values);
  assert.equal(await f.guard.retireSavedSession(token), true);
  before.delete(storedKey);
  assert.deepEqual(f.values, before);
  assert.equal(f.guard.getState().sessionRetired, true);
  assert.equal(f.guard.getState().blocked, true);
  assert.equal(f.guard.getState().sessionRetirementToken, null);
  await assert.rejects(
    f.guard.storage.setItem(sessionKey, JSON.stringify({ opaque: 'late SDK user' })),
  );
  await assert.rejects(f.guard.retireSavedSession(token));
  assert.equal(await f.guard.finishInitialization(null), false);
  assert.deepEqual(f.values, before);
  assert.equal(f.calls.filter(([kind, key]) => kind === 'remove' && key === storedKey).length, 1);
});

test('no-session and ordinary ready guards have no retirement capability', async () => {
  for (const initial of [null, original]) {
    const f = fixture(initial);
    await f.guard.preflight();
    await available(f.guard);
    await f.guard.finishInitialization(initial);
    assert.equal(f.guard.getState().sessionRetirementToken, null);
    await assert.rejects(f.guard.retireSavedSession('saved-sign-in-1'));
    assert.equal(f.values.get(storedKey) ?? null, initial);
  }
});

test('stale or changed session retirement refuses deletion and never consumes another record', async () => {
  const f = fixture(),
    token = await blockedSession(f);
  await assert.rejects(f.guard.retireSavedSession(token + '0'));
  assert.equal(f.values.get(storedKey), original);
  const changed = JSON.stringify({ opaque: 'another known session' });
  f.values.set(storedKey, changed);
  await assert.rejects(f.guard.retireSavedSession(token));
  assert.equal(f.values.get(storedKey), changed);
  assert.equal(f.guard.getState().sessionRetirementToken, null);
  assert.equal(f.guard.getState().sessionRetired, false);
  assert.equal(f.calls.filter(([kind, key]) => kind === 'remove' && key === storedKey).length, 0);
});

test('retirement read/probe failures do not erase a retained session', async () => {
  for (const kind of ['session-read', 'probe-write', 'unresolved-probe']) {
    const faults = {},
      f = fixture(original, faults),
      token = await blockedSession(f);
    if (kind === 'session-read') faults.read = (key) => key === storedKey;
    if (kind === 'probe-write') faults.beforeSet = (key) => key.endsWith('__fyp_retirement_probe');
    if (kind === 'unresolved-probe') f.values.set(prefix + '__fyp_retirement_probe', 'unconfirmed');
    await assert.rejects(f.guard.retireSavedSession(token));
    assert.equal(f.values.get(storedKey), original);
    assert.equal(f.guard.getState().sessionRetired, false);
    assert.equal(f.guard.getState().sessionRetirementToken, null);
    assert.equal(
      f.calls.filter(([operation, key]) => operation === 'remove' && key === storedKey).length,
      0,
    );
  }
});

test('retirement resolves remove-then-throw only by exact absence readback', async () => {
  const f = fixture(original, { afterRemove: (key) => key === storedKey }),
    token = await blockedSession(f);
  assert.equal(await f.guard.retireSavedSession(token), true);
  assert.equal(f.values.has(storedKey), false);
  assert.equal(f.guard.getState().sessionRetired, true);
});

test('failed removal and unknown removal readback stay blocked without retrying or restoring bytes', async () => {
  const unchanged = fixture(original, { beforeRemove: (key) => key === storedKey }),
    first = await blockedSession(unchanged);
  await assert.rejects(unchanged.guard.retireSavedSession(first));
  assert.equal(unchanged.values.get(storedKey), original);
  assert.equal(unchanged.guard.getState().sessionRetired, false);
  await assert.rejects(unchanged.guard.storage.setItem(sessionKey, '{}'));
  let failedRead = false;
  const uncertain = fixture(original, {
      read: (key) => failedRead && key === storedKey,
      afterRemove: (key) => {
        if (key === storedKey) failedRead = true;
        return false;
      },
    }),
    second = await blockedSession(uncertain);
  await assert.rejects(uncertain.guard.retireSavedSession(second));
  assert.equal(uncertain.values.has(storedKey), false);
  assert.equal(uncertain.guard.getState().sessionRetired, false);
  assert.equal(uncertain.guard.getState().sessionRetirementToken, null);
  failedRead = false;
  await assert.rejects(uncertain.guard.retireSavedSession(second));
  assert.equal(await uncertain.guard.confirm(null), false);
});

test('malformed or unreadable initial sessions and unavailable SDK storage never offer retirement', async () => {
  for (const options of [
    { initial: 'not json' },
    { initial: original, faults: { read: () => true } },
    { initial: original, faults: { beforeSet: (key) => key.endsWith('__sak') } },
  ]) {
    const f = fixture(options.initial, options.faults);
    try {
      await f.guard.preflight();
      await available(f.guard);
    } catch {}
    try {
      await f.guard.storage.removeItem(sessionKey);
    } catch {}
    assert.equal(f.guard.getState().sessionRetirementToken, null);
    await assert.rejects(f.guard.retireSavedSession('saved-sign-in-1'));
    assert.equal(f.values.get(storedKey), options.initial);
  }
});

test('a fresh guard reconciles only a known retained probe after storage recovers', async () => {
  for (const failure of ['readback', 'removal']) {
    const probeKey = prefix + '__fyp_retirement_probe';
    let failed = true;
    const faults = {};
    const f = fixture(original, faults);
    const token = await blockedSession(f);
    if (failure === 'readback')
      faults.read = (key) => failed && key === probeKey && f.values.has(probeKey);
    else faults.beforeRemove = (key) => failed && key === probeKey;
    await assert.rejects(f.guard.retireSavedSession(token));
    assert.equal(f.values.get(probeKey), '1');
    assert.equal(f.values.get(storedKey), original);
    assert.equal(f.guard.getState().sessionRetired, false);
    failed = false;
    const nextGuard = createGuardedAuthPersistence(f.adapter, { prefix, sessionKey });
    const nextToken = await blockedSession({ ...f, guard: nextGuard });
    assert.notEqual(nextToken, token);
    assert.equal(f.values.get(storedKey), original);
    assert.equal(await nextGuard.retireSavedSession(nextToken), true);
    assert.equal(f.values.has(storedKey), false);
    assert.equal(f.values.has(probeKey), false);
    assert.equal(nextGuard.getState().sessionRetired, true);
    assert.equal(f.calls.filter(([kind, key]) => kind === 'remove' && key === storedKey).length, 1);
    await assert.rejects(f.guard.storage.setItem(sessionKey, original));
    await assert.rejects(nextGuard.storage.setItem(sessionKey, original));
  }
});
