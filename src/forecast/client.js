const {
  getProvider,
  providerRequestBinding,
  PROVIDER_HEADER,
} = require('../companion/providerContract');
const {
  ForecastError,
  MESSAGES,
  validateInput,
  validateWire,
  validateResult,
} = require('./protocol');
let sequence = 0;
const nextId = () =>
  `forecast-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
function createForecastClient(
  configuration,
  { fetch: fetcher = globalThis.fetch, createRequestId = nextId, timeoutMs = 70000 } = {},
) {
  let provider, binding;
  try {
    provider = getProvider(configuration, 'forecast');
    binding = providerRequestBinding(configuration, 'forecast');
  } catch {
    throw new ForecastError('UNAVAILABLE');
  }
  if (
    !provider ||
    !binding ||
    configuration.url !== 'http://127.0.0.1:8787/v1/recognize' ||
    typeof configuration.token !== 'string' ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(configuration.token) ||
    typeof fetcher !== 'function' ||
    typeof createRequestId !== 'function' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > 70000
  )
    throw new ForecastError('UNAVAILABLE');
  const base = configuration.url.slice(0, -'/v1/recognize'.length),
    token = configuration.token;
  const post = (route, body, signal) =>
    fetcher(base + route, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        [PROVIDER_HEADER]: binding,
      },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
      credentials: 'omit',
    });
  const cancel = async (requestId) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30000);
    try {
      const reply = await post('/v1/forecast/cancel', { version: 1, requestId }, abort.signal);
      await reply.body?.cancel?.().catch?.(() => {});
    } catch {
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  };
  return Object.freeze({
    async forecast(input, { signal } = {}) {
      const wire = validateWire({ ...validateInput(input), requestId: createRequestId() });
      if (signal?.aborted) throw new ForecastError('CANCELLED');
      const abort = new AbortController();
      let timedOut = false,
        dispatched = false,
        rejectWait;
      const interrupted = new Promise((_, reject) => {
        rejectWait = reject;
      });
      const onAbort = () => {
        abort.abort();
        rejectWait(new ForecastError(timedOut ? 'TIMEOUT' : 'CANCELLED'));
        if (dispatched) void cancel(wire.requestId);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        onAbort();
      }, timeoutMs);
      try {
        if (signal?.aborted) onAbort();
        if (abort.signal.aborted) throw new ForecastError('CANCELLED');
        dispatched = true;
        const work = post('/v1/forecast', wire, abort.signal).then((reply) => {
          if (abort.signal.aborted) {
            try {
              Promise.resolve(reply.body?.cancel?.()).catch(() => {});
            } catch {}
            throw new ForecastError(timedOut ? 'TIMEOUT' : 'CANCELLED');
          }
          return reply;
        });
        const reply = await Promise.race([work, interrupted]);
        if (reply.status === 401) throw new ForecastError('UNAUTHORIZED');
        const length = reply.headers.get('content-length');
        if (
          reply.redirected ||
          !length ||
          !/^[0-9]+$/.test(length) ||
          Number(length) < 1 ||
          Number(length) > 24576 ||
          !/^application\/json(?:;|$)/i.test(reply.headers.get('content-type') || '')
        )
          throw new ForecastError('INVALID_MODEL_RESPONSE');
        const text = await Promise.race([reply.text(), interrupted]);
        if (text.length > 24576) throw new ForecastError('TOO_LARGE');
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          throw new ForecastError('INVALID_MODEL_RESPONSE');
        }
        if (value.providerBinding !== binding) throw new ForecastError('PROVIDER_CHANGED');
        if (value.requestId !== wire.requestId) throw new ForecastError('INVALID_MODEL_RESPONSE');
        if (!reply.ok)
          throw new ForecastError(
            Object.hasOwn(MESSAGES, value.error?.code) ? value.error.code : 'MODEL_FAILED',
          );
        if (JSON.stringify(value.provider) !== JSON.stringify(provider) || value.version !== 1)
          throw new ForecastError('PROVIDER_CHANGED');
        if (abort.signal.aborted) throw new ForecastError(timedOut ? 'TIMEOUT' : 'CANCELLED');
        return validateResult(value.result, wire);
      } catch (error) {
        if (signal?.aborted) throw new ForecastError('CANCELLED');
        if (timedOut) throw new ForecastError('TIMEOUT');
        if (error instanceof ForecastError) throw error;
        throw new ForecastError('NETWORK');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        abort.abort();
      }
    },
  });
}
module.exports = { createForecastClient, ForecastError };
