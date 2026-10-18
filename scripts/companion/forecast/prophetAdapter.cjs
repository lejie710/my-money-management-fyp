const { performance } = require('node:perf_hooks');
const {
  ForecastError,
  MESSAGES,
  validateWire,
  validateResult,
} = require('../../../src/forecast/protocol');
async function boundedJson(response, assertDeadline) {
  if (!/^application\/json(?:;|$)/i.test(response.headers?.get('content-type') || ''))
    throw new ForecastError('INVALID_MODEL_RESPONSE');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 65536))
    throw new ForecastError('TOO_LARGE');
  if (!response.body?.getReader) throw new ForecastError('INVALID_MODEL_RESPONSE');
  const reader = response.body.getReader(),
    chunks = [];
  let total = 0,
    count = 0,
    complete = false;
  try {
    while (true) {
      assertDeadline();
      const { done, value } = await reader.read();
      assertDeadline();
      if (done) break;
      if (!(value instanceof Uint8Array) || ++count > 1024)
        throw new ForecastError('INVALID_MODEL_RESPONSE');
      total += value.byteLength;
      if (total > 65536) throw new ForecastError('TOO_LARGE');
      if (value.byteLength) chunks.push(Buffer.from(value));
    }
    let result;
    try {
      result = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)),
      );
    } catch {
      throw new ForecastError('INVALID_MODEL_RESPONSE');
    }
    assertDeadline();
    complete = true;
    return result;
  } finally {
    if (!complete) {
      try {
        Promise.resolve(reader.cancel()).catch(() => {});
      } catch {}
    }
    try {
      reader.releaseLock();
    } catch {}
  }
}
function discard(reply) {
  try {
    Promise.resolve(reply?.body?.cancel?.()).catch(() => {});
  } catch {}
}
function createProphetAdapter({
  baseUrl,
  key,
  fetch: fetcher = globalThis.fetch,
  timeoutMs = 65000,
  cancelTimeoutMs = 30000,
  now = () => performance.now(),
} = {}) {
  const match =
    typeof baseUrl === 'string' && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(baseUrl);
  if (
    !match ||
    Number(match[1]) > 65535 ||
    typeof key !== 'string' ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(key) ||
    typeof fetcher !== 'function' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > 65000 ||
    !Number.isInteger(cancelTimeoutMs) ||
    cancelTimeoutMs < 10 ||
    cancelTimeoutMs > 30000
  )
    throw new ForecastError('UNAVAILABLE');
  const jobs = new Set();
  let closed = false,
    blocked = false,
    closing = null;
  const post = (path, body, signal) =>
    fetcher(baseUrl + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
  async function cancelRemote(id) {
    const abort = new AbortController(),
      started = now();
    let timer, reply;
    const check = () => {
      if (abort.signal.aborted || now() - started >= cancelTimeoutMs)
        throw new ForecastError('CLEANUP_UNCONFIRMED');
    };
    try {
      const work = (async () => {
        reply = await post('/v1/forecast/cancel', { version: 1, requestId: id }, abort.signal);
        try {
          check();
          if (reply.redirected || (reply.url && reply.url !== baseUrl + '/v1/forecast/cancel'))
            throw new ForecastError('CLEANUP_UNCONFIRMED');
          const result = await boundedJson(reply, check);
          if (
            !reply.ok ||
            result.version !== 1 ||
            result.requestId !== id ||
            result.cancelled !== true ||
            result.stopped !== true
          )
            throw new ForecastError('CLEANUP_UNCONFIRMED');
          return true;
        } finally {
          if (abort.signal.aborted) discard(reply);
        }
      })();
      return await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new ForecastError('CLEANUP_UNCONFIRMED'));
          }, cancelTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      abort.abort();
      discard(reply);
    }
  }
  async function forecast(request, { signal } = {}) {
    const wire = validateWire(request);
    if (closed || blocked) throw new ForecastError('UNAVAILABLE');
    if (signal?.aborted) throw new ForecastError('CANCELLED');
    const abort = new AbortController(),
      started = now();
    let timer,
      timedOut = false,
      reply,
      rejectWait,
      cancelled = null,
      finish;
    const interrupted = new Promise((_, reject) => {
      rejectWait = reject;
    });
    const done = new Promise((resolve) => {
      finish = resolve;
    });
    const job = { abort, done };
    jobs.add(job);
    const beginCancel = () => {
      if (!cancelled)
        cancelled = cancelRemote(wire.requestId).catch(() => {
          blocked = true;
          throw new ForecastError('CLEANUP_UNCONFIRMED');
        });
      cancelled.catch(() => {});
      return cancelled;
    };
    const onAbort = () => {
      abort.abort();
      void beginCancel();
      rejectWait(new ForecastError(timedOut ? 'TIMEOUT' : 'CANCELLED'));
    };
    job.cancel = onAbort;
    signal?.addEventListener('abort', onAbort, { once: true });
    const check = () => {
      if (now() - started >= timeoutMs) {
        timedOut = true;
        onAbort();
      }
      if (abort.signal.aborted) throw new ForecastError(timedOut ? 'TIMEOUT' : 'CANCELLED');
    };
    timer = setTimeout(() => {
      timedOut = true;
      onAbort();
    }, timeoutMs);
    try {
      if (signal?.aborted) onAbort();
      check();
      const work = (async () => {
        reply = await post('/v1/forecast', wire, abort.signal);
        try {
          check();
          if (reply.redirected || (reply.url && reply.url !== baseUrl + '/v1/forecast'))
            throw new ForecastError('INVALID_MODEL_RESPONSE');
          const value = await boundedJson(reply, check);
          if (!reply.ok)
            throw new ForecastError(
              Object.hasOwn(MESSAGES, value?.error) ? value.error : 'MODEL_FAILED',
            );
          check();
          return validateResult(value, wire);
        } finally {
          if (abort.signal.aborted) discard(reply);
        }
      })();
      return await Promise.race([work, interrupted]);
    } catch (error) {
      if (error instanceof ForecastError && error.code === 'CLEANUP_UNCONFIRMED') blocked = true;
      if (!(error instanceof ForecastError) && !cancelled) beginCancel();
      if (cancelled) await cancelled;
      if (signal?.aborted || closed) throw new ForecastError('CANCELLED');
      if (timedOut) throw new ForecastError('TIMEOUT');
      if (error instanceof ForecastError) throw error;
      throw new ForecastError('NETWORK');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      abort.abort();
      discard(reply);
      jobs.delete(job);
      finish();
    }
  }
  function close() {
    if (closing) return closing;
    closed = true;
    const active = [...jobs];
    active.forEach((job) => job.cancel());
    closing = Promise.all(active.map((job) => job.done)).then(() => {
      if (blocked) throw new ForecastError('CLEANUP_UNCONFIRMED');
    });
    return closing;
  }
  return { forecast, close };
}
module.exports = { createProphetAdapter };
