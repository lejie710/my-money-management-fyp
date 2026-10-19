const { strictJson } = require('../../src/services/strictJson');
class ServiceError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
async function readBody(
  stream,
  maximum,
  { milliseconds = 10000, signal, now = () => performance.now() } = {},
) {
  const started = now();
  let count = 0,
    size = 0,
    expired = false;
  const chunks = [];
  const current = () => {
    if (signal?.aborted) throw new ServiceError('CANCELLED', 499);
    if (expired || now() - started >= milliseconds) throw new ServiceError('TIMEOUT', 504);
  };
  const timer = setTimeout(() => {
    expired = true;
    stream.destroy?.();
  }, milliseconds);
  const abort = () => stream.destroy?.();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream) {
      current();
      if (++count > 4096) throw new ServiceError('TOO_LARGE', 413);
      size += chunk.byteLength;
      if (size > maximum) throw new ServiceError('TOO_LARGE', 413);
      if (chunk.byteLength) chunks.push(Buffer.from(chunk));
    }
    current();
    return Buffer.concat(chunks, size);
  } catch (e) {
    current();
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
async function readJsonRequest(req, maximum, options) {
  if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding'])
    throw new ServiceError('BAD_REQUEST');
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > maximum))
    throw new ServiceError('TOO_LARGE', 413);
  try {
    return strictJson(
      new TextDecoder('utf-8', { fatal: true }).decode(await readBody(req, maximum, options)),
      maximum,
    );
  } catch (e) {
    if (e instanceof ServiceError) throw e;
    throw new ServiceError('BAD_REQUEST');
  }
}
async function readFetchJson(response, maximum, signal, tracker) {
  const cancel = (target) => {
    if (tracker) return tracker.cancel(target);
    try {
      void Promise.resolve(target?.cancel?.()).catch(() => {});
    } catch {}
  };
  if (
    !response?.body?.getReader ||
    !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')
  ) {
    cancel(response?.body);
    throw new ServiceError('AUTH_UNAVAILABLE', 503);
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maximum)) {
    cancel(response.body);
    throw new ServiceError('AUTH_UNAVAILABLE', 503);
  }
  const reader = response.body.getReader();
  let size = 0,
    count = 0;
  const parts = [];
  const onAbort = () => cancel(reader);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new ServiceError('AUTH_UNAVAILABLE', 503);
      const row = await reader.read();
      if (signal?.aborted) throw new ServiceError('AUTH_UNAVAILABLE', 503);
      if (row.done) break;
      if (
        !(row.value instanceof Uint8Array) ||
        ++count > 1024 ||
        (size += row.value.byteLength) > maximum
      )
        throw new ServiceError('AUTH_UNAVAILABLE', 503);
      if (row.value.byteLength) parts.push(Buffer.from(row.value));
    }
    return strictJson(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, size)),
      maximum,
    );
  } catch {
    cancel(reader);
    throw new ServiceError('AUTH_UNAVAILABLE', 503);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {}
  }
}
module.exports = { ServiceError, readBody, readJsonRequest, readFetchJson };
