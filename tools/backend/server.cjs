// Portable authenticated gateway. Importing this file opens no socket or model.
const { isIP } = require('node:net');
const { randomBytes } = require('node:crypto');
const { validateHostedProviders } = require('../../src/companion/providerContract');
const {
  validateServiceMetadata,
  hostedProviderBinding,
  HOSTED_PROVIDER_HEADER,
} = require('../../src/services/contract');
const { ServiceError, readBody, readJsonRequest } = require('./bounded.cjs');
const { isLoopback } = require('./firebaseAuth.cjs');
const assistant = require('../../src/assistant/protocol');
const { OpenAIAdapterError } = require('../../scripts/companion/assistant/openaiAdapter.cjs');
const { validateAssistantResponse } = require('../../src/assistant/providerResponse');
const forecast = require('../../src/forecast/protocol');
const { validateOcrResult } = require('../../src/core/receipt');
const { inspectImageHeader } = require('../../src/attachments/imageHeader');
const ROUTES = new Map([
  ['/v1/assistant/explain', 'assistant'],
  ['/v1/recognize', 'ocr'],
  ['/v1/forecast', 'forecast'],
  ['/v1/assistant/cancel', 'assistant'],
  ['/v1/forecast/cancel', 'forecast'],
]);
const ERROR_CODES = new Set([
  'BAD_REQUEST',
  'TOO_LARGE',
  'BUSY',
  'CANCELLED',
  'TIMEOUT',
  'UNAUTHORIZED',
  'AUTH_UNAVAILABLE',
  'UNAVAILABLE',
  'RATE_LIMITED',
  'DUPLICATE_REQUEST',
  'PROVIDER_CHANGED',
  'PROVIDER_AUTH',
  'REFUSED',
  'INCOMPLETE',
  'INVALID_MODEL_RESPONSE',
  'MODEL_FAILED',
  'CLEANUP_UNCONFIRMED',
  'IMAGE_INVALID',
  'RESPONSE_INVALID',
  'NETWORK',
]);
function createServiceHandler({
  projectId,
  serviceId,
  providers,
  verifyToken,
  quota,
  providerFactory,
  mode = 'hosted',
  trustTlsProxy = false,
  trustedProxyPeers = ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
  requestTimeoutMs = 75000,
  cleanupTimeoutMs = 5000,
  now = Date.now,
} = {}) {
  providers = validateHostedProviders(providers);
  validateServiceMetadata(
    { version: 1, projectId, serviceId, uid: 'configuration-check', providers },
    { projectId, uid: 'configuration-check' },
  );
  if (
    !verifyToken ||
    typeof verifyToken.verify !== 'function' ||
    !quota ||
    typeof quota.reserve !== 'function' ||
    typeof providerFactory !== 'function' ||
    !['hosted', 'emulator'].includes(mode) ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 100 ||
    requestTimeoutMs > 120000 ||
    !Number.isSafeInteger(cleanupTimeoutMs) ||
    cleanupTimeoutMs < 50 ||
    cleanupTimeoutMs > 30000
  )
    throw new Error('Invalid backend configuration.');
  if (
    !Array.isArray(trustedProxyPeers) ||
    trustedProxyPeers.length < 1 ||
    trustedProxyPeers.length > 16 ||
    trustedProxyPeers.some((peer) => typeof peer !== 'string' || !isIP(peer))
  )
    throw new Error('Invalid trusted TLS proxy peers.');
  const trustedPeers = new Set(trustedProxyPeers);
  const active = new Map(),
    control = new Map();
  let closed = false,
    inflight = 0,
    cleanupUnconfirmed = false;
  const metadata = (owner) => ({ version: 1, serviceId, projectId, uid: owner.uid, providers });
  const reply = (res, status, value) => {
    if (res.destroyed || res.writableEnded) return;
    const bytes = Buffer.from(JSON.stringify(value));
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(bytes);
  };
  const limited = (owner) => {
    const instant = now(),
      bucket = Math.floor(instant / 60000);
    for (const [key, value] of control) if (value.bucket !== bucket) control.delete(key);
    for (const key of ['*', quota.ownerKey(owner)]) {
      const old = control.get(key) || { bucket, count: 0 };
      if (old.count >= (key === '*' ? 300 : 60) || (!control.has(key) && control.size >= 10001))
        throw new ServiceError('RATE_LIMITED', 429);
      old.count++;
      control.set(key, old);
    }
  };
  const abortAll = () => {
    closed = true;
    for (const job of active.values()) job.abort.abort();
  };
  async function handle(req, res) {
    let release = null,
      job = null,
      timer = null,
      id = null,
      cap = null,
      owner = null;
    let disconnected = null;
    if (++inflight > 32) {
      inflight--;
      reply(res, 503, { error: { code: 'BUSY', message: 'Service is busy.' } });
      req.resume?.();
      return;
    }
    try {
      if (closed) throw new ServiceError('UNAVAILABLE', 503);
      if (req.url === '/health' && req.method === 'GET') {
        reply(res, 200, { status: 'ready' });
        return;
      }
      if (
        typeof req.url !== 'string' ||
        req.url.length > 100 ||
        Object.hasOwn(req.headers, 'origin') ||
        req.headers['content-encoding']
      )
        throw new ServiceError('BAD_REQUEST');
      if (mode === 'emulator') {
        if (!projectId.startsWith('demo-') || !isLoopback(req.socket?.remoteAddress))
          throw new ServiceError('UNAUTHORIZED', 401);
      } else if (
        req.socket?.encrypted !== true &&
        !(
          trustTlsProxy === true &&
          trustedPeers.has(req.socket?.remoteAddress) &&
          req.headers['x-forwarded-proto'] === 'https'
        )
      )
        throw new ServiceError('HTTPS_REQUIRED', 400);
      if (
        !(req.url === '/v1/services' && req.method === 'GET') &&
        !(req.method === 'POST' && ROUTES.has(req.url))
      )
        throw new ServiceError('NOT_FOUND', 404);
      const auth = req.headers.authorization;
      if (typeof auth !== 'string' || !/^Bearer [A-Za-z0-9_.-]{20,16384}$/.test(auth))
        throw new ServiceError('UNAUTHORIZED', 401);
      owner = await verifyToken.verify(auth.slice(7), { remoteAddress: req.socket?.remoteAddress });
      if (closed || owner.projectId !== projectId) throw new ServiceError('UNAUTHORIZED', 401);
      limited(owner);
      if (req.url === '/v1/services') {
        reply(res, 200, metadata(owner));
        return;
      }
      cap = ROUTES.get(req.url);
      if (!providers[cap]) throw new ServiceError('UNAVAILABLE', 503);
      const binding = hostedProviderBinding(metadata(owner), cap);
      if (req.headers[HOSTED_PROVIDER_HEADER] !== binding)
        throw new ServiceError('PROVIDER_CHANGED', 409);
      if (req.url.endsWith('/cancel')) {
        const body = await readJsonRequest(req, 512);
        if (
          !body ||
          Object.keys(body).sort().join(',') !== 'requestId,version' ||
          body.version !== 1 ||
          !assistant.requestId(body.requestId)
        )
          throw new ServiceError('BAD_REQUEST');
        id = body.requestId;
        quota.retire(owner, id);
        const pending = active.get(JSON.stringify([quota.ownerKey(owner), cap, id]));
        if (pending) {
          pending.abort.abort();
          await pending.done;
          if (pending.cleanupFailed) throw new ServiceError('CLEANUP_UNCONFIRMED', 503);
        }
        reply(res, 200, { version: 1, requestId: id, providerBinding: binding, cancelled: true });
        return;
      }
      let input;
      if (cap === 'ocr') {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(req.headers['content-type']))
          throw new ServiceError('IMAGE_INVALID');
        const length = req.headers['content-length'];
        if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > 6291456))
          throw new ServiceError('TOO_LARGE', 413);
        input = await readBody(req, 6291456);
        const header = inspectImageHeader(input);
        if (header.mimeType !== req.headers['content-type'])
          throw new ServiceError('IMAGE_INVALID');
        id = req.headers['x-mymoney-request-id'];
        if (!assistant.requestId(id)) throw new ServiceError('BAD_REQUEST');
      } else {
        input = await readJsonRequest(req, cap === 'assistant' ? 65536 : 65536);
        input = (cap === 'assistant' ? assistant : forecast).validateWire(input);
        id = input.requestId;
      }
      if (closed || res.destroyed) throw new ServiceError('CANCELLED', 499);
      release = quota.reserve(owner, id);
      const key = JSON.stringify([quota.ownerKey(owner), cap, id]),
        abort = new AbortController();
      let finish;
      const done = new Promise((resolve) => {
        finish = resolve;
      });
      job = { abort, done, finish, key, cleanupFailed: false };
      active.set(key, job);
      timer = setTimeout(() => {
        job.timedOut = true;
        abort.abort();
      }, requestTimeoutMs);
      disconnected = () => {
        if (!res.writableEnded) abort.abort();
      };
      res.once('close', disconnected);
      let runtime = null,
        result,
        removeAbort = null;
      runtime = providerFactory(cap, owner);
      const work = (async () => {
        if (cap === 'assistant') {
          result = await runtime.complete(assistant.payloadFromWire(input), {
            signal: abort.signal,
          });
          const accepted = validateAssistantResponse(result, providers.assistant);
          result = {
            version: 1,
            requestId: id,
            providerBinding: binding,
            provider: accepted.provider,
            result: { content: accepted.content, finishReason: accepted.finishReason },
          };
        } else if (cap === 'ocr') {
          const recognized = validateOcrResult(
            await runtime.recognize(input, { signal: abort.signal }),
          );
          if (recognized.provider !== 'google-cloud-vision')
            throw new ServiceError('RESPONSE_INVALID', 502);
          result = { version: 1, requestId: id, providerBinding: binding, ocr: recognized };
        } else {
          // The shared private Flask service has its own request-id namespace.
          // Never let two authenticated owners address the same private fit ID.
          const internal = forecast.validateWire({
            ...input,
            requestId: 'server-' + randomBytes(24).toString('hex'),
          });
          const response = await runtime.forecast(internal, { signal: abort.signal });
          const validated = forecast.validateResult(response, internal);
          const external = forecast.validateResult({ ...validated, requestId: id }, input);
          result = {
            version: 1,
            requestId: id,
            providerBinding: binding,
            provider: providers.forecast,
            result: external,
          };
        }
        if (abort.signal.aborted || closed) throw new ServiceError('CANCELLED', 499);
        return result;
      })();
      const interrupted = new Promise((_, reject) => {
        const stopped = () =>
          reject(
            new ServiceError(job.timedOut ? 'TIMEOUT' : 'CANCELLED', job.timedOut ? 504 : 499),
          );
        abort.signal.addEventListener('abort', stopped, { once: true });
        removeAbort = () => abort.signal.removeEventListener('abort', stopped);
        if (abort.signal.aborted) stopped();
      });
      try {
        result = await Promise.race([work, interrupted]);
      } finally {
        removeAbort?.();
        let cleanupTimer;
        try {
          const closing = Promise.resolve().then(() => runtime.close?.());
          const results = await Promise.race([
            Promise.allSettled([work, closing]),
            new Promise((_, reject) => {
              cleanupTimer = setTimeout(() => reject(Error('cleanup deadline')), cleanupTimeoutMs);
            }),
          ]);
          if (results[1].status === 'rejected') throw Error('cleanup failed');
        } catch {
          job.cleanupFailed = true;
          cleanupUnconfirmed = true;
          closed = true;
        } finally {
          clearTimeout(cleanupTimer);
        }
      }
      if (job.cleanupFailed) throw new ServiceError('CLEANUP_UNCONFIRMED', 503);
      if (abort.signal.aborted || closed) throw new ServiceError('CANCELLED', 499);
      reply(res, 200, result);
    } catch (error) {
      if (job && error?.code === 'CLEANUP_UNCONFIRMED') job.cleanupFailed = true;
      const providerCode =
        error instanceof OpenAIAdapterError
          ? {
              UNAUTHORIZED: 'PROVIDER_AUTH',
              CONFIGURATION: 'UNAVAILABLE',
              MODEL_UNAVAILABLE: 'UNAVAILABLE',
              INVALID_RESPONSE: 'INVALID_MODEL_RESPONSE',
            }[error.code] || error.code
          : error?.code;
      const code = ERROR_CODES.has(providerCode) ? providerCode : 'UNAVAILABLE';
      const status =
        error instanceof ServiceError
          ? error.status
          : {
              BAD_REQUEST: 400,
              TOO_LARGE: 413,
              CANCELLED: 499,
              BUSY: 429,
              RATE_LIMITED: 429,
              TIMEOUT: 504,
              REFUSED: 422,
              INCOMPLETE: 502,
              INVALID_MODEL_RESPONSE: 502,
            }[code] || 503;
      reply(res, status, {
        version: 1,
        ...(id ? { requestId: id } : {}),
        error: { code, message: 'The requested service could not complete this operation.' },
      });
      req.resume?.();
    } finally {
      clearTimeout(timer);
      if (disconnected) res.off('close', disconnected);
      if (job) {
        active.delete(job.key);
        job.finish();
      }
      release?.();
      inflight--;
    }
  }
  return {
    handle,
    async close() {
      abortAll();
      await Promise.all([...active.values()].map((job) => job.done));
      try {
        await verifyToken.close?.();
      } catch {
        cleanupUnconfirmed = true;
      }
      if (cleanupUnconfirmed) throw new ServiceError('CLEANUP_UNCONFIRMED', 503);
    },
    get activeCount() {
      return active.size;
    },
  };
}
module.exports = { createServiceHandler };
