'use strict';
const { createProviderWork } = require('../providerWork.cjs');

// Server-side adapter only. Importing or constructing it performs no request.
// The caller supplies the existing pure assistant protocol; no mobile/provider
// credentials, filesystem, environment lookup, or financial writer is used here.
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const MAX_REQUEST_BYTES = 32768;
const MAX_RESPONSE_BYTES = 65536;
const MAX_RESPONSE_CHUNKS = 4096;
const MAX_EMPTY_CHUNKS = 32;
const MAX_CONTENT_CHARACTERS = 1800;
const MESSAGES = Object.freeze({
  CONFIGURATION: 'Choose an explicit OpenAI model and a private server credential.',
  BAD_REQUEST: 'The selected financial facts and question could not be prepared.',
  TOO_LARGE: 'The selected facts and question exceed the request limit.',
  BUSY: 'Another OpenAI request is still pending. Wait before trying again.',
  CANCELLED: 'The explanation was cancelled. The provider may already have processed the request.',
  TIMEOUT:
    'OpenAI did not finish within the deadline. The provider may already have processed the request.',
  UNAUTHORIZED:
    'OpenAI rejected the server credential or its access. Check the private configuration.',
  RATE_LIMITED:
    'OpenAI could not accept another request. Check your provider limits before retrying.',
  MODEL_UNAVAILABLE: 'The configured OpenAI service or model is unavailable.',
  REFUSED: 'OpenAI declined this question. The calculated financial facts remain available.',
  INCOMPLETE: 'The OpenAI response did not finish. No partial explanation was accepted.',
  INVALID_RESPONSE: 'The OpenAI response did not match the required financial explanation format.',
  NETWORK: 'The OpenAI request could not be confirmed. No automatic retry was made.',
});

class OpenAIAdapterError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'NETWORK';
    super(MESSAGES[safeCode]);
    this.name = 'OpenAIAdapterError';
    this.code = safeCode;
  }
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const modelId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const fail = (code) => {
  throw new OpenAIAdapterError(code);
};
function cancelBody(body, tracker) {
  if (tracker) return tracker.cancel(body);
  try {
    void Promise.resolve(body?.cancel?.()).catch(() => {});
  } catch {}
}

function prepareRequest(payload, model, maxCompletionTokens, contract) {
  let wire, canonical;
  try {
    // These are the current app's real protocol validators, injected by the host.
    // Rebuild canonical messages so extra client fields cannot become API options.
    wire = contract.wireFromPayload(payload, 'openai-adapter-validation');
    canonical = contract.payloadFromWire(wire);
  } catch {
    fail('BAD_REQUEST');
  }
  if (
    !object(wire) ||
    !Array.isArray(wire.facts) ||
    wire.facts.some((fact) => !object(fact)) ||
    !object(canonical)
  )
    fail('BAD_REQUEST');
  const ids = wire.facts.map((fact) => fact.id);
  if (
    ids.length < 1 ||
    ids.length > 48 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(id)) ||
    !Array.isArray(canonical.messages) ||
    canonical.messages.length !== 3 ||
    canonical.messages.some(
      (message, index) =>
        !object(message) ||
        message.role !== (index === 0 ? 'system' : 'user') ||
        typeof message.content !== 'string',
    )
  )
    fail('BAD_REQUEST');
  const request = {
    model,
    messages: canonical.messages.map(({ role, content }) => ({
      role,
      content,
    })),
    max_completion_tokens: maxCompletionTokens,
    n: 1,
    stream: false,
    store: false,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'financial_explanation',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            answer: { type: 'string' },
            factIds: { type: 'array', items: { type: 'string', enum: ids } },
          },
          required: ['answer', 'factIds'],
          additionalProperties: false,
        },
      },
    },
  };
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) fail('TOO_LARGE');
  return { body, ids };
}

async function readResponse(response, current, bindReader, tracker) {
  try {
    current();
  } catch (error) {
    cancelBody(response?.body, tracker);
    throw error;
  }
  if (!response || response.redirected || response.url !== OPENAI_ENDPOINT) {
    cancelBody(response?.body, tracker);
    fail('INVALID_RESPONSE');
  }
  if (!response.ok) {
    // Never read/return provider error text, which can contain request diagnostics.
    cancelBody(response.body, tracker);
    if (response.status === 401 || response.status === 403) fail('UNAUTHORIZED');
    if (response.status === 429) fail('RATE_LIMITED');
    fail('MODEL_UNAVAILABLE');
  }
  if (!/^application\/json(?:;|$)/i.test(response.headers?.get('content-type') || '')) {
    cancelBody(response.body, tracker);
    fail('INVALID_RESPONSE');
  }
  const length = response.headers?.get('content-length');
  if (
    length !== null &&
    length !== undefined &&
    (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)
  ) {
    cancelBody(response.body, tracker);
    fail('INVALID_RESPONSE');
  }
  if (typeof response.body?.getReader !== 'function') fail('INVALID_RESPONSE');
  const reader = response.body.getReader();
  bindReader(reader);
  const chunks = [];
  let total = 0,
    chunkCount = 0,
    emptyCount = 0;
  try {
    while (true) {
      current();
      const { done, value } = await reader.read();
      current();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('INVALID_RESPONSE');
      if (++chunkCount > MAX_RESPONSE_CHUNKS) fail('INVALID_RESPONSE');
      if (value.byteLength === 0) {
        if (++emptyCount > MAX_EMPTY_CHUNKS) fail('INVALID_RESPONSE');
        continue;
      }
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) fail('INVALID_RESPONSE');
      chunks.push(Buffer.from(value));
    }
    current();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof OpenAIAdapterError) throw error;
    fail('INVALID_RESPONSE');
  } finally {
    cancelBody(reader, tracker);
    try {
      reader.releaseLock();
    } catch {}
  }
}

function normalizeCompletion(raw, ids, requestedModel) {
  if (
    !object(raw) ||
    raw.object !== 'chat.completion' ||
    !modelId(raw.model) ||
    !Array.isArray(raw.choices) ||
    raw.choices.length !== 1
  )
    fail('INVALID_RESPONSE');
  const choice = raw.choices[0],
    message = choice?.message;
  if (
    !object(message) ||
    message.role !== 'assistant' ||
    message.tool_calls ||
    message.function_call
  )
    fail('INVALID_RESPONSE');
  if (
    message.refusal !== undefined &&
    message.refusal !== null &&
    typeof message.refusal !== 'string'
  )
    fail('INVALID_RESPONSE');
  if (typeof message.refusal === 'string' && message.refusal.trim()) fail('REFUSED');
  if (choice.finish_reason !== 'stop') fail('INCOMPLETE');
  if (
    typeof message.content !== 'string' ||
    !message.content.trim() ||
    message.content.length > MAX_CONTENT_CHARACTERS
  )
    fail('INVALID_RESPONSE');
  let answer;
  try {
    answer = JSON.parse(message.content);
  } catch {
    fail('INVALID_RESPONSE');
  }
  if (
    !object(answer) ||
    Object.keys(answer).sort().join(',') !== 'answer,factIds' ||
    typeof answer.answer !== 'string' ||
    !answer.answer.trim() ||
    answer.answer.length > 1200 ||
    answer.answer.trim().split(/\s+/).length > 180 ||
    !Array.isArray(answer.factIds) ||
    answer.factIds.length < 1 ||
    answer.factIds.length > 8 ||
    new Set(answer.factIds).size !== answer.factIds.length ||
    answer.factIds.some((id) => typeof id !== 'string' || !ids.includes(id))
  )
    fail('INVALID_RESPONSE');
  return Object.freeze({
    model: raw.model,
    requestedModel,
    content: JSON.stringify({
      answer: answer.answer.trim(),
      factIds: [...answer.factIds],
    }),
    finishReason: 'stop',
    provider: Object.freeze({
      engine: 'openai',
      processing: 'cloud',
      requestedModel,
      model: raw.model,
    }),
  });
}

function createOpenAIAdapter(options) {
  const allowed = [
    'apiKey',
    'model',
    'requestContract',
    'fetch',
    'timeoutMs',
    'maxCompletionTokens',
    'now',
  ];
  if (!object(options) || Object.keys(options).some((key) => !allowed.includes(key)))
    fail('CONFIGURATION');
  const {
    apiKey,
    model,
    requestContract,
    fetch: fetcher = globalThis.fetch,
    timeoutMs = 60000,
    maxCompletionTokens = 1024,
    now = () => globalThis.performance.now(),
  } = options;
  if (
    typeof apiKey !== 'string' ||
    !/^[\x21-\x7e]{20,512}$/.test(apiKey) ||
    !modelId(model) ||
    typeof fetcher !== 'function' ||
    typeof now !== 'function' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 50 ||
    timeoutMs > 120000 ||
    !Number.isSafeInteger(maxCompletionTokens) ||
    maxCompletionTokens < 128 ||
    maxCompletionTokens > 2048 ||
    typeof requestContract?.wireFromPayload !== 'function' ||
    typeof requestContract?.payloadFromWire !== 'function'
  )
    fail('CONFIGURATION');
  const contract = {
    wireFromPayload: requestContract.wireFromPayload,
    payloadFromWire: requestContract.payloadFromWire,
  };
  const tracker = createProviderWork();
  let active = null,
    closed = false,
    closing = null;
  return Object.freeze({
    async complete(payload, { signal } = {}) {
      if (closed) fail('CANCELLED');
      if (active || tracker.pendingCount) fail('BUSY');
      if (
        signal !== undefined &&
        (typeof signal?.aborted !== 'boolean' ||
          typeof signal?.addEventListener !== 'function' ||
          typeof signal?.removeEventListener !== 'function')
      )
        fail('BAD_REQUEST');
      if (signal?.aborted) fail('CANCELLED');
      const prepared = prepareRequest(payload, model, maxCompletionTokens, contract);
      let clockStart;
      try {
        clockStart = now();
      } catch {
        fail('CONFIGURATION');
      }
      if (
        !Number.isFinite(clockStart) ||
        clockStart < 0 ||
        clockStart > Number.MAX_SAFE_INTEGER - timeoutMs
      )
        fail('CONFIGURATION');
      const deadlineAt = clockStart + timeoutMs;
      let clockLast = clockStart;
      const abort = new AbortController();
      let stopCode = null,
        reader = null,
        rejectStop;
      const stopped = new Promise((_, reject) => {
        rejectStop = reject;
      });
      const stop = (code) => {
        if (stopCode) return;
        stopCode = code;
        abort.abort();
        cancelBody(reader, tracker);
        rejectStop(new OpenAIAdapterError(code));
      };
      const current = () => {
        let observed;
        try {
          observed = now();
        } catch {
          stop('TIMEOUT');
        }
        if (!Number.isFinite(observed) || observed < clockLast || observed >= deadlineAt)
          stop('TIMEOUT');
        else clockLast = observed;
        if (stopCode || closed) fail(stopCode || 'CANCELLED');
      };
      const job = { stop };
      active = job;
      const onAbort = () => stop('CANCELLED');
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) stop('CANCELLED');
      const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
      try {
        const work = Promise.resolve().then(async () => {
          current();
          const response = await fetcher(OPENAI_ENDPOINT, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: prepared.body,
            signal: abort.signal,
            redirect: 'error',
            credentials: 'omit',
          });
          const raw = await readResponse(
            response,
            current,
            (value) => {
              reader = value;
              if (stopCode) cancelBody(reader, tracker);
            },
            tracker,
          );
          current();
          const result = normalizeCompletion(raw, prepared.ids, model);
          current();
          return result;
        });
        tracker.track(work);
        return await Promise.race([work, stopped]);
      } catch (error) {
        if (stopCode) throw new OpenAIAdapterError(stopCode);
        if (error instanceof OpenAIAdapterError) throw error;
        throw new OpenAIAdapterError('NETWORK');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        abort.abort();
        cancelBody(reader, tracker);
        if (active === job) active = null;
      }
    },
    status() {
      return Object.freeze({ busy: active !== null || tracker.pendingCount > 0, closed });
    },
    close() {
      closed = true;
      active?.stop('CANCELLED');
      if (!closing) closing = tracker.drain();
      return closing;
    },
  });
}

module.exports = {
  createOpenAIAdapter,
  OpenAIAdapterError,
  OPENAI_ENDPOINT,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_RESPONSE_CHUNKS,
  MAX_EMPTY_CHUNKS,
};
