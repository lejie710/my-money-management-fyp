const test = require('node:test');
const assert = require('node:assert/strict');
const { safeAuthMessage } = require('../src/accounts/identity');

test('shared duplicate-account guidance works for hosted reset and the local demonstration', () => {
  const message = safeAuthMessage({ code: 'auth/email-already-in-use' }, 'register');
  assert.match(message, /Sign in or use password reset/);
  assert.doesNotMatch(message, /local reset inbox/);
  assert.match(
    safeAuthMessage({ code: 'auth/invalid-credential' }, 'sign-in'),
    /email address or password was not accepted/,
  );
});

test('shared network failures retain wallets without misidentifying the configured service', () => {
  const message = safeAuthMessage(
    { code: 'auth/network-request-failed', message: 'synthetic-private-provider-detail' },
    'sign-in',
  );
  assert.match(message, /account service could not be reached/);
  assert.match(message, /saved wallets are retained/);
  assert.doesNotMatch(message, /local account|synthetic-private-provider-detail/);
  assert.doesNotMatch(
    safeAuthMessage({ message: 'synthetic-private-provider-detail' }, 'sign-in'),
    /synthetic-private-provider-detail/,
  );
});
