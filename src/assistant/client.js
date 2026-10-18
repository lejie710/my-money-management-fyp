const { AssistantError, MESSAGES, MODEL_ID, wireFromPayload, requestId } = require('./protocol');
const MAX_RESPONSE = 8192;
function createAssistantClient(
  config,
  { fetch: fetcher = globalThis.fetch, createRequestId, timeoutMs = 123000 } = {},
) {
  const match =
    typeof config?.url === 'string'
      ? /^http:\/\/127\.0\.0\.1:(\d+)\/v1\/recognize$/.exec(config.url)
      : null;
  if (
    !match ||
    Number(match[1]) < 1 ||
    Number(match[1]) > 65535 ||
    typeof config.token !== 'string' ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(config.token) ||
    typeof fetcher !== 'function' ||
    typeof createRequestId !== 'function' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 50 ||
    timeoutMs > 123000
  )
    throw new AssistantError('MODEL_UNAVAILABLE');
  const base = config.url.slice(0, -'/v1/recognize'.length),
    token = config.token;
  const post = (path, body, signal) =>
    fetcher(base + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
      credentials: 'omit',
    });
  async function cancelRemote(id) {
    const abort = new AbortController();
    let timer;
    try {
      const response = await Promise.race([
        post('/v1/assistant/cancel', { version: 1, requestId: id }, abort.signal),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            abort.abort();
            resolve(null);
          }, 3000);
        }),
      ]);
      void response?.body?.cancel?.().catch?.(() => {});
    } catch {
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }
  return {
    async complete(payload, { signal } = {}) {
      const id = createRequestId();
      if (!requestId(id)) throw new AssistantError('BAD_REQUEST');
      const wire = wireFromPayload(payload, id);
      if (signal?.aborted) throw new AssistantError('CANCELLED');
      const abort = new AbortController();
      let timedOut = false,
        dispatched = false;
      let rejectDeadline;
      const deadline = new Promise((_, reject) => {
        rejectDeadline = reject;
      });
      const onAbort = () => {
        abort.abort();
        rejectDeadline(new AssistantError(timedOut ? 'TIMEOUT' : 'CANCELLED'));
        if (dispatched) void cancelRemote(id);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        onAbort();
      }, timeoutMs);
      try {
        dispatched = true;
        const response = await Promise.race([
          post('/v1/assistant/explain', wire, abort.signal),
          deadline,
        ]);
        const length = response.headers.get('content-length');
        if (
          !length ||
          !/^\d+$/.test(length) ||
          Number(length) < 1 ||
          Number(length) > MAX_RESPONSE ||
          !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')
        )
          throw new AssistantError('INVALID_MODEL_RESPONSE');
        const text = await Promise.race([response.text(), deadline]);
        if (text.length > MAX_RESPONSE) throw new AssistantError('INVALID_MODEL_RESPONSE');
        let result;
        try {
          result = JSON.parse(text);
        } catch {
          throw new AssistantError('INVALID_MODEL_RESPONSE');
        }
        if (result?.version !== 1 || (result.requestId !== id && response.status !== 401))
          throw new AssistantError('INVALID_MODEL_RESPONSE');
        if (!response.ok)
          throw new AssistantError(
            Object.hasOwn(MESSAGES, result.error?.code) ? result.error.code : 'FAILED',
          );
        if (
          result.requestId !== id ||
          result.provider?.engine !== 'lemonade' ||
          result.provider.model !== MODEL_ID ||
          !['vulkan', 'cpu'].includes(result.provider.backend) ||
          typeof result.result?.content !== 'string' ||
          !result.result.content.trim() ||
          result.result.content.length > 1800 ||
          result.result.finishReason !== 'stop'
        )
          throw new AssistantError('INVALID_MODEL_RESPONSE');
        if (abort.signal.aborted) throw new AssistantError(timedOut ? 'TIMEOUT' : 'CANCELLED');
        return {
          model: result.provider.model,
          content: result.result.content,
          finishReason: result.result.finishReason,
        };
      } catch (error) {
        if (abort.signal.aborted) throw new AssistantError(timedOut ? 'TIMEOUT' : 'CANCELLED');
        if (error instanceof AssistantError) throw error;
        throw new AssistantError('NETWORK');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        abort.abort();
      }
    },
  };
}
module.exports = { createAssistantClient, AssistantError };
