const test = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { createFirebaseVerifier, CERTIFICATES } = require('../firebaseAuth.cjs');
const { strictJson } = require('../../../src/services/strictJson');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = publicKey.export({ type: 'spki', format: 'pem' }),
  projectId = 'project-finance-reference';
const payload = (extra = {}) => ({
  aud: projectId,
  iss: 'https://securetoken.google.com/' + projectId,
  sub: 'account-a',
  iat: 1000,
  exp: 4600,
  auth_time: 990,
  firebase: { sign_in_provider: 'password' },
  ...extra,
});
function token(body = payload(), header = { alg: 'RS256', typ: 'JWT', kid: 'key-a' }) {
  const a = Buffer.from(JSON.stringify(header)).toString('base64url'),
    b = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)).toString('base64url');
  return (
    a +
    '.' +
    b +
    '.' +
    crypto.sign('RSA-SHA256', Buffer.from(a + '.' + b), privateKey).toString('base64url')
  );
}
function setup() {
  let calls = 0,
    time = 0;
  const verifier = createFirebaseVerifier({
    projectId,
    clock: () => 1100,
    monotonic: () => time,
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, CERTIFICATES);
      assert.equal(options.redirect, 'error');
      const response = new Response(JSON.stringify({ 'key-a': pem }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=99999' },
      });
      Object.defineProperty(response, 'url', { value: CERTIFICATES });
      return response;
    },
  });
  return {
    verifier,
    calls: () => calls,
    advance: (value) => {
      time = value;
    },
  };
}
test('strict JSON rejects duplicate escaped members, nonfinite values and deep nesting', () => {
  assert.deepEqual(strictJson('{"a":[1,true,null]}'), { a: [1, true, null] });
  for (const text of [
    '{"a":1,"\\u0061":2}',
    '{"a":1e999}',
    '[1,]',
    '['.repeat(26) + ']'.repeat(26),
  ])
    assert.throws(() => strictJson(text));
  const x = strictJson('{"__proto__":{"x":1}}');
  assert.equal(Object.getPrototypeOf(x), Object.prototype);
  assert.equal({}.x, undefined);
});
test('RS256 verifies signature/project/subject and caches only bounded fixed-origin keys', async () => {
  const s = setup();
  assert.equal((await s.verifier.verify(token())).uid, 'account-a');
  await s.verifier.verify(token());
  assert.equal(s.calls(), 1);
  s.advance(3600001);
  await s.verifier.verify(token());
  assert.equal(s.calls(), 2);
});
test('wrong audience issuer expiry issued time subject tenant and algorithm fail closed', async () => {
  const s = setup();
  for (const change of [
    { aud: 'wrong-project' },
    { iss: 'https://example.invalid' },
    { exp: 1100 },
    { iat: 1200 },
    { auth_time: 1200 },
    { sub: '' },
    { firebase: { sign_in_provider: 'password', tenant: 'other' } },
    { user_id: 'other' },
  ])
    await assert.rejects(
      s.verifier.verify(token(payload(change))),
      (e) => e.code === 'UNAUTHORIZED',
    );
  await assert.rejects(
    s.verifier.verify(token(payload(), { alg: 'none', typ: 'JWT', kid: 'key-a' })),
  );
  assert.equal(s.calls(), 0);
});
test('tampered signed content and duplicate JWT claims are rejected', async () => {
  const s = setup(),
    parts = token().split('.');
  parts[1] = Buffer.from(JSON.stringify(payload({ sub: 'account-b' }))).toString('base64url');
  await assert.rejects(s.verifier.verify(parts.join('.')), (e) => e.code === 'UNAUTHORIZED');
  await assert.rejects(s.verifier.verify(token('{"aud":"' + projectId + '","aud":"other"}')));
});
test('unsigned emulator identity requires explicit demo config and actual loopback caller', async () => {
  assert.throws(() => createFirebaseVerifier({ projectId, mode: 'emulator' }));
  assert.throws(() =>
    createFirebaseVerifier({
      projectId: 'demo-money-backup',
      mode: 'emulator',
      listenHost: '0.0.0.0',
    }),
  );
  const verifier = createFirebaseVerifier({
    projectId: 'demo-money-backup',
    mode: 'emulator',
    listenHost: '127.0.0.1',
    clock: () => 1100,
    fetch: () => {
      throw Error('No network allowed');
    },
  });
  const h = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'),
    p = Buffer.from(
      JSON.stringify(
        payload({
          aud: 'demo-money-backup',
          iss: 'https://securetoken.google.com/demo-money-backup',
        }),
      ),
    ).toString('base64url');
  assert.equal(
    (await verifier.verify(h + '.' + p + '.', { remoteAddress: '127.0.0.1' })).uid,
    'account-a',
  );
  await assert.rejects(verifier.verify(h + '.' + p + '.', { remoteAddress: '192.0.2.1' }));
});
test('certificate redirects and foreign origins never establish trust', async () => {
  let cancelled = 0;
  const verifier = createFirebaseVerifier({
    projectId,
    clock: () => 1100,
    fetch: async () => ({
      ok: true,
      url: 'https://example.invalid/cert',
      redirected: true,
      body: {
        cancel() {
          cancelled++;
          return Promise.resolve();
        },
      },
    }),
  });
  await assert.rejects(verifier.verify(token()), (e) => e.code === 'AUTH_UNAVAILABLE');
  assert.equal(cancelled, 1);
});

test('unsettled certificate transport blocks another refresh and cannot claim clean shutdown', async () => {
  let calls = 0,
    instant = 0;
  const verifier = createFirebaseVerifier({
    projectId,
    clock: () => 1100,
    monotonic: () => instant,
    timeoutMs: 50,
    fetch: async () => {
      calls++;
      return new Promise(() => {});
    },
  });
  await assert.rejects(verifier.verify(token()), (e) => e.code === 'AUTH_UNAVAILABLE');
  instant = 60000;
  await assert.rejects(verifier.verify(token()), (e) => e.code === 'AUTH_UNAVAILABLE');
  assert.equal(calls, 1);
  await assert.rejects(verifier.close({ timeoutMs: 50 }));
});
