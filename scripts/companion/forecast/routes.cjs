const {
  getProvider,
  providerRequestBinding,
  PROVIDER_HEADER,
} = require('../../../src/companion/providerContract');
const {
  ForecastError,
  MESSAGES,
  requestId,
  validateWire,
  validateResult,
} = require('../../../src/forecast/protocol');
async function readBody(req, maximum, timeoutMs) {
  if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding'])
    throw new ForecastError('BAD_REQUEST');
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > maximum))
    throw new ForecastError('TOO_LARGE');
  const chunks = [];
  let count = 0,
    size = 0,
    timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    req.destroy();
  }, timeoutMs);
  try {
    for await (const chunk of req) {
      if (++count > 1024) throw new ForecastError('TOO_LARGE');
      size += chunk.byteLength;
      if (size > maximum) throw new ForecastError('TOO_LARGE');
      if (chunk.byteLength) chunks.push(Buffer.from(chunk));
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)),
      );
    } catch {
      throw new ForecastError('BAD_REQUEST');
    }
  } catch (error) {
    if (timedOut) throw new ForecastError('TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
function createForecastRoutes({
  runtime,
  configuration,
  uploadTimeoutMs = 10000,
  now = Date.now,
} = {}) {
  const provider = getProvider(configuration, 'forecast');
  const providerBinding = providerRequestBinding(configuration, 'forecast');
  if (!provider || !providerBinding || typeof runtime?.forecast !== 'function')
    throw new ForecastError('UNAVAILABLE');
  let active = null,
    closed = false,
    closing = null;
  const remembered = new Map();
  const remember = (id) => {
    for (const [key, until] of remembered) if (until <= now()) remembered.delete(key);
    if (!remembered.has(id) && remembered.size >= 128) throw new ForecastError('BUSY');
    remembered.set(id, now() + 180000);
  };
  const send = (res, status, payload) => {
    if (res.destroyed || res.writableEnded) return;
    const body = JSON.stringify({ version: 1, providerBinding, ...payload });
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  };
  const failed = (res, error, id) => {
    const code = error instanceof ForecastError ? error.code : 'MODEL_FAILED';
    send(
      res,
      {
        BAD_REQUEST: 400,
        TOO_LARGE: 413,
        PROVIDER_CHANGED: 409,
        BUSY: 429,
        TIMEOUT: 504,
        CANCELLED: 499,
        INVALID_MODEL_RESPONSE: 502,
      }[code] || 503,
      { ...(id ? { requestId: id } : {}), error: { code, message: MESSAGES[code] } },
    );
  };
  const checkProvider = (req) => {
    if (req.headers[PROVIDER_HEADER] !== providerBinding)
      throw new ForecastError('PROVIDER_CHANGED');
    if (closed) throw new ForecastError('UNAVAILABLE');
  };
  async function forecast(req, res) {
    let id = null;
    try {
      checkProvider(req);
      const wire = validateWire(await readBody(req, 65536, uploadTimeoutMs));
      id = wire.requestId;
      checkProvider(req);
      if (res.destroyed || (remembered.get(id) || 0) > now()) throw new ForecastError('CANCELLED');
      if (active) throw new ForecastError('BUSY');
      remember(id);
      const abort = new AbortController();
      let finish;
      const done = new Promise((resolve) => {
        finish = resolve;
      });
      const job = { id, abort, done };
      active = job;
      const disconnect = () => {
        if (!res.writableEnded) abort.abort();
      };
      res.once('close', disconnect);
      try {
        const result = await runtime.forecast(wire, { signal: abort.signal });
        if (abort.signal.aborted || closed) throw new ForecastError('CANCELLED');
        send(res, 200, { requestId: id, provider, result: validateResult(result, wire) });
      } catch (error) {
        job.error = error;
        throw error;
      } finally {
        res.off('close', disconnect);
        if (active === job) active = null;
        finish();
      }
    } catch (error) {
      failed(res, error, id);
      req.resume();
    }
  }
  async function cancel(req, res) {
    let id = null;
    try {
      checkProvider(req);
      const value = await readBody(req, 512, uploadTimeoutMs);
      if (
        !value ||
        Object.keys(value).sort().join(',') !== 'requestId,version' ||
        value.version !== 1 ||
        !requestId(value.requestId)
      )
        throw new ForecastError('BAD_REQUEST');
      id = value.requestId;
      remember(id);
      const pending = active?.id === id ? active : null;
      if (pending) {
        pending.abort.abort();
        await pending.done;
        if (pending.error?.code === 'CLEANUP_UNCONFIRMED') throw pending.error;
      }
      send(res, 200, { requestId: id, cancelled: true });
    } catch (error) {
      failed(res, error, id);
      req.resume();
    }
  }
  function close() {
    if (closing) return closing;
    closed = true;
    const pending = active;
    pending?.abort.abort();
    closing = (async () => {
      if (pending) await pending.done;
      await runtime.close?.();
    })();
    return closing;
  }
  return [
    { method: 'POST', path: '/v1/forecast', handle: forecast, close },
    { method: 'POST', path: '/v1/forecast/cancel', handle: cancel },
  ];
}
module.exports = { createForecastRoutes };
