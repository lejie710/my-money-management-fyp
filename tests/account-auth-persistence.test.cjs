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
