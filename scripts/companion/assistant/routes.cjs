const {
  AssistantError,
  MESSAGES,
  requestId,
  validateWire,
  payloadFromWire,
} = require('../../../src/assistant/protocol');
const { PROVIDER_HEADER } = require('../../../src/companion/providerContract');
const {
  assistantProvider,
  validateAssistantResponse,
} = require('../../../src/assistant/providerResponse');
const { OpenAIAdapterError } = require('./openaiAdapter.cjs');
const OPENAI_FAILURE_CODES = Object.freeze({
  CONFIGURATION: 'MODEL_UNAVAILABLE',
  BAD_REQUEST: 'BAD_REQUEST',
  TOO_LARGE: 'TOO_LARGE',
  BUSY: 'BUSY',
  CANCELLED: 'CANCELLED',
  TIMEOUT: 'TIMEOUT',
  UNAUTHORIZED: 'PROVIDER_AUTH',
  RATE_LIMITED: 'RATE_LIMITED',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  REFUSED: 'REFUSED',
  INCOMPLETE: 'INCOMPLETE',
  INVALID_RESPONSE: 'INVALID_MODEL_RESPONSE',
  NETWORK: 'NETWORK',
});
function failureCode(error) {
  return error instanceof OpenAIAdapterError
    ? OPENAI_FAILURE_CODES[error.code] || 'FAILED'
    : error instanceof AssistantError
      ? error.code
      : 'FAILED';
}
function send(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
function failure(res, code, id) {
  const status =
    {
      BAD_REQUEST: 400,
      PROVIDER_MISMATCH: 409,
      PROVIDER_AUTH: 503,
      RATE_LIMITED: 429,
      REFUSED: 422,
      INCOMPLETE: 502,
      TOO_LARGE: 413,
      CONTEXT_TOO_LARGE: 422,
      BUSY: 429,
      TIMEOUT: 504,
      CANCELLED: 499,
      MODEL_UNAVAILABLE: 503,
      INVALID_MODEL_RESPONSE: 502,
    }[code] || 503;
  send(res, status, {
    version: 1,
    ...(id ? { requestId: id } : {}),
    error: { code, message: MESSAGES[code] || MESSAGES.FAILED },
  });
}
async function readBody(req, limit = 24576, timeoutMs = 10000) {
  if (req.headers['content-type'] !== 'application/json') throw new AssistantError('BAD_REQUEST');
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit))
    throw new AssistantError('TOO_LARGE');
  const chunks = [];
  let total = 0,
    timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    req.destroy();
  }, timeoutMs);
  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) throw new AssistantError('TOO_LARGE');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
    } catch {
      throw new AssistantError('BAD_REQUEST');
    }
  } catch (error) {
    if (timedOut) throw new AssistantError('TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
function createAssistantRoutes({
  runtime,
  provider,
  binding = null,
  uploadTimeoutMs = 10000,
  now = Date.now,
} = {}) {
  provider = assistantProvider(provider);
  if (provider.processing === 'cloud' && binding === null) throw new AssistantError('BAD_REQUEST');
  if (binding !== null && (typeof binding !== 'string' || binding.length > 2048))
    throw new AssistantError('BAD_REQUEST');
  const checkBinding = (req) => {
    if (
      (binding === null && req.headers[PROVIDER_HEADER] !== undefined) ||
      (binding !== null && req.headers[PROVIDER_HEADER] !== binding)
    )
      throw new AssistantError('PROVIDER_MISMATCH');
  };
  if (typeof runtime?.complete !== 'function') throw new AssistantError('MODEL_UNAVAILABLE');
  let active = null,
    closed = false,
    closing = null;
  const tombstones = new Map();
  const remember = (id) => {
    for (const [key, until] of tombstones) if (until <= now()) tombstones.delete(key);
    if (!tombstones.has(id) && tombstones.size >= 128) throw new AssistantError('BUSY');
    tombstones.set(id, now() + 180000);
  };
  const expired = (id) => {
    const until = tombstones.get(id);
    if (until && until > now()) return true;
    tombstones.delete(id);
    return false;
  };
  async function explain(req, res) {
    let id = null,
      job = null;
    try {
      if (closed) throw new AssistantError('MODEL_UNAVAILABLE');
      checkBinding(req);
      const body = validateWire(await readBody(req, 24576, uploadTimeoutMs));
      id = body.requestId;
      if (closed) throw new AssistantError('MODEL_UNAVAILABLE');
      if (res.destroyed) throw new AssistantError('CANCELLED');
      if (expired(id)) throw new AssistantError('CANCELLED');
      if (active) throw new AssistantError('BUSY');
      remember(id);
      const abort = new AbortController();
      let finish;
      const done = new Promise((resolve) => {
        finish = resolve;
      });
      job = { id, abort, done, finish };
      active = job;
      const disconnect = () => {
        if (!res.writableEnded) {
          remember(id);
          abort.abort();
        }
      };
      res.once('close', disconnect);
      try {
        const result = await runtime.complete(payloadFromWire(body), { signal: abort.signal });
        if (abort.signal.aborted || closed) throw new AssistantError('CANCELLED');
        const provenance =
          provider.engine === 'lemonade'
            ? {
                engine: 'lemonade',
                processing: 'local',
                model: result.model,
                backend: result.backend,
              }
            : result.provider;
        const accepted = validateAssistantResponse({ ...result, provider: provenance }, provider);
        send(res, 200, {
          version: 1,
          requestId: id,
          ...(binding === null ? {} : { providerBinding: binding }),
          provider:
            binding === null && provider.engine === 'lemonade'
              ? { engine: 'lemonade', model: result.model, backend: result.backend }
              : accepted.provider,
          result: { content: result.content, finishReason: result.finishReason },
        });
      } finally {
        res.off('close', disconnect);
        remember(id);
        if (active === job) active = null;
        finish();
      }
    } catch (error) {
      failure(res, failureCode(error), id);
      req.resume();
    }
  }
  async function cancel(req, res) {
    let id = null;
    try {
      checkBinding(req);
      const body = await readBody(req, 512, uploadTimeoutMs);
      if (
        !body ||
        Object.keys(body).sort().join(',') !== 'requestId,version' ||
        body.version !== 1 ||
        !requestId(body.requestId)
      )
        throw new AssistantError('BAD_REQUEST');
      id = body.requestId;
      remember(id);
      if (active?.id === id) active.abort.abort();
      send(res, 200, {
        version: 1,
        requestId: id,
        cancelled: true,
        ...(binding === null ? {} : { providerBinding: binding }),
      });
    } catch (error) {
      failure(res, failureCode(error), id);
      req.resume();
    }
  }
  function close() {
    if (closing) return closing;
    closed = true;
    const pending = active;
    pending?.abort.abort();
    runtime.close?.();
    closing = (async () => {
      if (pending) await pending.done;
    })();
    return closing;
  }
  return [
    { method: 'POST', path: '/v1/assistant/explain', handle: explain, close },
    { method: 'POST', path: '/v1/assistant/cancel', handle: cancel },
  ];
}
module.exports = { createAssistantRoutes };
