// Firebase ID tokens only: fixed Google signing-certificate origin, never a token-supplied URL.
const crypto = require('node:crypto');
const { createProviderWork } = require('../../scripts/companion/providerWork.cjs');
const { strictJson } = require('../../src/services/strictJson');
const { validProjectId, validOwnerUid } = require('../../src/services/contract');
const { ServiceError, readFetchJson } = require('./bounded.cjs');
const CERTIFICATES =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const loopback = (address) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const denied = () => {
  throw new ServiceError('UNAUTHORIZED', 401);
};
function decode(segment, maximum) {
  if (
    typeof segment !== 'string' ||
    !segment.length ||
    segment.length > maximum ||
    !/^[A-Za-z0-9_-]+$/.test(segment)
  )
    denied();
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) denied();
  try {
    return strictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), maximum);
  } catch {
    denied();
  }
}
function claims(value, projectId, now) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.aud !== projectId ||
    value.iss !== 'https://securetoken.google.com/' + projectId ||
    !validOwnerUid(value.sub)
  )
    denied();
  if (
    !Number.isSafeInteger(value.exp) ||
    !Number.isSafeInteger(value.iat) ||
    !Number.isSafeInteger(value.auth_time) ||
    value.exp <= now ||
    value.iat > now ||
    value.auth_time > now ||
    value.auth_time > value.iat ||
    value.iat < 0 ||
    value.auth_time < 0 ||
    value.exp <= value.iat ||
    value.exp - value.iat > 3660
  )
    denied();
  if (
    !value.firebase ||
    typeof value.firebase !== 'object' ||
    Array.isArray(value.firebase) ||
    Object.hasOwn(value.firebase, 'tenant') ||
    typeof value.firebase.sign_in_provider !== 'string' ||
    !value.firebase.sign_in_provider
  )
    denied();
  if (value.user_id !== undefined && value.user_id !== value.sub) denied();
  return Object.freeze({ projectId, uid: value.sub, issuedAt: value.iat, expiresAt: value.exp });
}
function createFirebaseVerifier({
  projectId,
  mode = 'hosted',
  listenHost = '127.0.0.1',
  fetch: fetcher = globalThis.fetch,
  clock = () => Date.now() / 1000,
  monotonic = () => performance.now(),
  timeoutMs = 5000,
} = {}) {
  if (
    !validProjectId(projectId) ||
    !['hosted', 'emulator'].includes(mode) ||
    typeof fetcher !== 'function' ||
    typeof clock !== 'function' ||
    typeof monotonic !== 'function' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 50 ||
    timeoutMs > 5000
  )
    throw new Error('Invalid authentication configuration.');
  if (mode === 'emulator' && (!projectId.startsWith('demo-') || !loopback(listenHost)))
    throw new Error('Emulator authentication requires a demo project and loopback listener.');
  if (mode === 'hosted' && projectId.startsWith('demo-'))
    throw new Error('Demo identities cannot authenticate a hosted backend.');
  const tracker = createProviderWork(),
    controllers = new Set();
  let closing = null;
  let cache = new Map(),
    expires = 0,
    lastAttempt = -Infinity,
    pending = null,
    closed = false;
  async function certificates() {
    const instant = monotonic();
    if (!Number.isFinite(instant)) throw new ServiceError('AUTH_UNAVAILABLE', 503);
    if (pending) return pending;
    if (tracker.pendingCount || tracker.cleanupFailed)
      throw new ServiceError('AUTH_UNAVAILABLE', 503);
    if (instant - lastAttempt < 30000) throw new ServiceError('AUTH_UNAVAILABLE', 503);
    lastAttempt = instant;
    pending = (async () => {
      const abort = new AbortController();
      controllers.add(abort);
      let rejectDeadline;
      const deadline = new Promise((_, reject) => {
        rejectDeadline = reject;
      });
      const timer = setTimeout(() => {
        abort.abort();
        rejectDeadline(new ServiceError('AUTH_UNAVAILABLE', 503));
      }, timeoutMs);
      const started = monotonic();
      try {
        const fetching = Promise.resolve().then(() =>
          fetcher(CERTIFICATES, {
            method: 'GET',
            redirect: 'error',
            credentials: 'omit',
            signal: abort.signal,
            headers: { Accept: 'application/json' },
          }),
        );
        tracker.track(fetching);
        fetching.then(
          (value) => {
            if (abort.signal.aborted) {
              try {
                tracker.cancel(value?.body);
              } catch {}
            }
          },
          () => {},
        );
        const response = await Promise.race([fetching, deadline]);
        if (
          abort.signal.aborted ||
          monotonic() - started >= timeoutMs ||
          closed ||
          !response?.ok ||
          response.redirected ||
          response.url !== CERTIFICATES
        ) {
          tracker.cancel(response?.body);
          throw new ServiceError('AUTH_UNAVAILABLE', 503);
        }
        const raw = await Promise.race([
          tracker.track(readFetchJson(response, 65536, abort.signal, tracker)),
          deadline,
        ]);
        if (
          abort.signal.aborted ||
          monotonic() - started >= timeoutMs ||
          closed ||
          !raw ||
          Array.isArray(raw) ||
          typeof raw !== 'object' ||
          Object.keys(raw).length < 1 ||
          Object.keys(raw).length > 8
        )
          throw new ServiceError('AUTH_UNAVAILABLE', 503);
        const next = new Map();
        for (const [kid, pem] of Object.entries(raw)) {
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(kid) || typeof pem !== 'string' || pem.length > 8192)
            throw new ServiceError('AUTH_UNAVAILABLE', 503);
          const key = crypto.createPublicKey(pem);
          if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048)
            throw new ServiceError('AUTH_UNAVAILABLE', 503);
          next.set(kid, key);
        }
        const age = /\bmax-age=([0-9]+)\b/.exec(response.headers.get('cache-control') || '');
        if (!age || Number(age[1]) < 1) throw new ServiceError('AUTH_UNAVAILABLE', 503);
        cache = next;
        expires = monotonic() + Math.min(3600, Number(age[1])) * 1000;
        return cache;
      } catch {
        throw new ServiceError('AUTH_UNAVAILABLE', 503);
      } finally {
        clearTimeout(timer);
        controllers.delete(abort);
      }
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  }
  return {
    async verify(token, { remoteAddress } = {}) {
      if (closed || typeof token !== 'string' || token.length > 16384) denied();
      const parts = token.split('.');
      if (parts.length !== 3) denied();
      const header = decode(parts[0], 2048),
        payload = decode(parts[1], 12288),
        now = clock();
      if (!Number.isFinite(now)) denied();
      const owner = claims(payload, projectId, now);
      if (!header || typeof header !== 'object' || Array.isArray(header) || header.typ !== 'JWT')
        denied();
      if (mode === 'emulator') {
        if (
          !loopback(remoteAddress) ||
          header.alg !== 'none' ||
          parts[2] !== '' ||
          Object.keys(header).some((k) => !['alg', 'typ'].includes(k))
        )
          denied();
        return owner;
      }
      if (
        header.alg !== 'RS256' ||
        typeof header.kid !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(header.kid) ||
        Object.keys(header).some((k) => !['alg', 'kid', 'typ'].includes(k)) ||
        !/^[A-Za-z0-9_-]{100,1024}$/.test(parts[2])
      )
        denied();
      if (monotonic() >= expires || !cache.has(header.kid)) await certificates();
      const key = cache.get(header.kid);
      if (!key) denied();
      const signature = Buffer.from(parts[2], 'base64url');
      if (
        signature.toString('base64url') !== parts[2] ||
        !crypto.verify(
          'RSA-SHA256',
          Buffer.from(parts[0] + '.' + parts[1]),
          { key, padding: crypto.constants.RSA_PKCS1_PADDING },
          signature,
        )
      )
        denied();
      if (closed) denied();
      return claims(payload, projectId, clock());
    },
    close({ timeoutMs: drainTimeoutMs = 5000 } = {}) {
      closed = true;
      cache.clear();
      for (const controller of controllers) controller.abort();
      if (!Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 50 || drainTimeoutMs > 5000)
        drainTimeoutMs = 5000;
      if (!closing) closing = tracker.drain(drainTimeoutMs);
      return closing;
    },
  };
}
module.exports = { createFirebaseVerifier, CERTIFICATES, isLoopback: loopback };
