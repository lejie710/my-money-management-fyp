const {
  validateServiceConfiguration,
  validateServiceMetadata,
  hostedProviderBinding,
  HOSTED_PROVIDER_HEADER,
} = require('./contract');
const { strictJson } = require('./strictJson');
const { utf8, decodeUtf8 } = require('../cloud/backupFormat');
const assistantProtocol = require('../assistant/protocol');
const { validateAssistantResponse } = require('../assistant/providerResponse');
const forecastProtocol = require('../forecast/protocol');
const { validateOcrResult } = require('../core/receipt');
const { inspectImageHeader } = require('../attachments/imageHeader');
const { ReceiptClientError } = require('../receipts/client');
class HostedServiceError extends Error {
  constructor(code) {
    super(
      {
        UNAUTHORIZED: 'Sign in again before using connected services.',
        STALE_SESSION: 'The account or connection changed. Reopen this feature.',
        PROVIDER_CHANGED: 'The configured provider changed. Recheck services before retrying.',
        RATE_LIMITED: 'The service request limit was reached. Try again later.',
        BUSY: 'The service is busy. Try again deliberately.',
        TIMEOUT: 'The connected service did not respond in time.',
        CANCELLED: 'The service request was cancelled.',
        UNAVAILABLE: 'The connected service is unavailable.',
        INVALID_RESPONSE: 'The service response could not be verified.',
        BAD_REQUEST: 'The selected request could not be sent.',
      }[code] || 'The connected service could not complete this request.',
    );
    this.name = 'HostedServiceError';
    this.code = code;
  }
}
const fail = (code) => {
  throw new HostedServiceError(code);
};
let sequence = 0;
const nextId = () =>
  `hosted-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
function createHostedSession({
  configuration,
  auth,
  fetch: fetcher = globalThis.fetch,
  createRequestId = nextId,
  timeoutMs = 75000,
} = {}) {
  configuration = validateServiceConfiguration(configuration);
  if (
    !auth ||
    auth.projectId !== configuration.projectId ||
    typeof auth.getIdToken !== 'function' ||
    typeof auth.isCurrent !== 'function' ||
    typeof fetcher !== 'function' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 50 ||
    timeoutMs > 120000
  )
    fail('BAD_REQUEST');
  const owner = {
    projectId: auth.projectId,
    uid: auth.uid,
    ownerToken: auth.ownerToken,
    viewToken: auth.viewToken,
  };
  let metadata = null,
    closed = false;
  const pending = new Set();
  const current = () => {
    if (
      closed ||
      !auth.isCurrent() ||
      auth.projectId !== owner.projectId ||
      auth.uid !== owner.uid ||
      auth.ownerToken !== owner.ownerToken ||
      auth.viewToken !== owner.viewToken
    )
      fail('STALE_SESSION');
  };
  async function readJson(response, maximum, signal) {
    if (
      response.redirected ||
      !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '') ||
      !response.body?.getReader
    )
      fail('INVALID_RESPONSE');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maximum))
      fail('INVALID_RESPONSE');
    const reader = response.body.getReader();
    let count = 0,
      size = 0;
    const chunks = [];
    const cancel = () => {
      try {
        void Promise.resolve(reader.cancel()).catch(() => {});
      } catch {}
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        if (signal.aborted) fail('CANCELLED');
        current();
        const row = await reader.read();
        current();
        if (signal.aborted) fail('CANCELLED');
        if (row.done) break;
        if (
          !(row.value instanceof Uint8Array) ||
          ++count > 4096 ||
          (size += row.value.byteLength) > maximum
        )
          fail('INVALID_RESPONSE');
        if (row.value.byteLength) chunks.push(row.value);
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      try {
        return strictJson(decodeUtf8(bytes), maximum);
      } catch {
        fail('INVALID_RESPONSE');
      }
    } catch (error) {
      cancel();
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  }
  async function request(
    path,
    {
      capability,
      body,
      contentType = 'application/json',
      signal,
      milliseconds = timeoutMs,
      requestId,
      maximum = 65536,
    } = {},
  ) {
    current();
    if (signal?.aborted) fail('CANCELLED');
    const abort = new AbortController();
    pending.add(abort);
    let expired = false,
      rejectStopped;
    const stopped = new Promise((_, reject) => {
      rejectStopped = reject;
    });
    abort.signal.addEventListener(
      'abort',
      () => rejectStopped(new HostedServiceError(expired ? 'TIMEOUT' : 'CANCELLED')),
      { once: true },
    );
    const stop = () => {
      abort.abort();
      rejectStopped(new HostedServiceError(expired ? 'TIMEOUT' : 'CANCELLED'));
    };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const timer = setTimeout(() => {
      expired = true;
      stop();
    }, milliseconds);
    const work = (async () => {
      const token = await auth.getIdToken(false);
      current();
      if (abort.signal.aborted) fail('CANCELLED');
      if (
        typeof token !== 'string' ||
        token.length < 20 ||
        token.length > 16384 ||
        !/^[-A-Za-z0-9_.]+$/.test(token)
      )
        fail('UNAUTHORIZED');
      const url = configuration.origin + path;
      const headers = {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': contentType }),
        ...(capability
          ? { [HOSTED_PROVIDER_HEADER]: hostedProviderBinding(metadata, capability) }
          : {}),
        ...(requestId ? { 'x-mymoney-request-id': requestId } : {}),
      };
      const response = await fetcher(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body,
        signal: abort.signal,
        redirect: 'error',
        credentials: 'omit',
      });
      try {
        current();
        if (abort.signal.aborted) fail('CANCELLED');
        if (response.url && response.url !== url) fail('INVALID_RESPONSE');
      } catch (e) {
        try {
          void response.body?.cancel?.().catch(() => {});
        } catch {}
        throw e;
      }
      const result = await readJson(response, maximum, abort.signal);
      current();
      if (!response.ok) {
        const code = result?.error?.code;
        throw new HostedServiceError(
          typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? code : 'UNAVAILABLE',
        );
      }
      if (capability && result.providerBinding !== hostedProviderBinding(metadata, capability))
        fail('PROVIDER_CHANGED');
      return result;
    })();
    try {
      return await Promise.race([work, stopped]);
    } catch (error) {
      if (error instanceof HostedServiceError) throw error;
      throw new HostedServiceError('NETWORK');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      abort.abort();
      pending.delete(abort);
    }
  }
  async function cancel(capability, id) {
    try {
      current();
      await request(`/v1/${capability === 'assistant' ? 'assistant' : 'forecast'}/cancel`, {
        capability,
        body: JSON.stringify({ version: 1, requestId: id }),
        milliseconds: 15000,
        maximum: 8192,
      });
    } catch {}
  }
  const ready = (capability) => {
    current();
    if (!metadata || !metadata.providers[capability]) fail('UNAVAILABLE');
  };
  async function run(capability, input, signal) {
    ready(capability);
    const id = createRequestId();
    if (!assistantProtocol.requestId(id)) fail('BAD_REQUEST');
    let path,
      body,
      type = 'application/json',
      wire;
    if (capability === 'assistant') {
      wire = assistantProtocol.wireFromPayload(input, id);
      path = '/v1/assistant/explain';
      body = JSON.stringify(wire);
    } else if (capability === 'forecast') {
      wire = forecastProtocol.validateWire({
        ...forecastProtocol.validateInput(input),
        requestId: id,
      });
      path = '/v1/forecast';
      body = JSON.stringify(wire);
    } else {
      if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > 6291456)
        fail('BAD_REQUEST');
      const image = inspectImageHeader(input);
      type = image.mimeType;
      path = '/v1/recognize';
      body = new Uint8Array(input);
    }
    if (typeof body === 'string' && utf8(body).byteLength > 65536) fail('BAD_REQUEST');
    const abort = () => {
      if (capability !== 'ocr') void cancel(capability, id);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const value = await request(path, {
        capability,
        body,
        contentType: type,
        signal,
        requestId: id,
        maximum: capability === 'ocr' ? 1048576 : 65536,
      });
      if (value.version !== 1 || value.requestId !== id) fail('INVALID_RESPONSE');
      if (capability === 'assistant')
        return validateAssistantResponse(
          {
            model: value.provider?.model,
            requestedModel: value.provider?.requestedModel,
            provider: value.provider,
            content: value.result?.content,
            finishReason: value.result?.finishReason,
          },
          metadata.providers.assistant,
        );
      if (capability === 'forecast') {
        if (JSON.stringify(value.provider) !== JSON.stringify(metadata.providers.forecast))
          fail('PROVIDER_CHANGED');
        return forecastProtocol.validateResult(value.result, wire);
      }
      const result = validateOcrResult(value.ocr);
      if (result.provider !== 'google-cloud-vision') fail('PROVIDER_CHANGED');
      return result;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  async function capabilityCall(capability, operation) {
    try {
      return await operation();
    } catch (error) {
      const ErrorType =
        capability === 'assistant'
          ? assistantProtocol.AssistantError
          : capability === 'forecast'
            ? forecastProtocol.ForecastError
            : ReceiptClientError;
      if (error instanceof ErrorType) throw error;
      const mappings =
        capability === 'assistant'
          ? {
              RATE_LIMITED: 'RATE_LIMITED',
              UNAUTHORIZED: 'UNAUTHORIZED',
              PROVIDER_AUTH: 'PROVIDER_AUTH',
              PROVIDER_CHANGED: 'PROVIDER_MISMATCH',
              STALE_SESSION: 'CANCELLED',
              BUSY: 'BUSY',
              TIMEOUT: 'TIMEOUT',
              CANCELLED: 'CANCELLED',
              BAD_REQUEST: 'BAD_REQUEST',
              INVALID_RESPONSE: 'INVALID_MODEL_RESPONSE',
              UNAVAILABLE: 'MODEL_UNAVAILABLE',
              REFUSED: 'REFUSED',
              INCOMPLETE: 'INCOMPLETE',
              DUPLICATE_REQUEST: 'CANCELLED',
              CLEANUP_UNCONFIRMED: 'MODEL_UNAVAILABLE',
              NETWORK: 'NETWORK',
            }
          : capability === 'forecast'
            ? {
                RATE_LIMITED: 'RATE_LIMITED',
                UNAUTHORIZED: 'UNAUTHORIZED',
                PROVIDER_CHANGED: 'PROVIDER_CHANGED',
                STALE_SESSION: 'CANCELLED',
                BUSY: 'BUSY',
                TIMEOUT: 'TIMEOUT',
                CANCELLED: 'CANCELLED',
                BAD_REQUEST: 'BAD_REQUEST',
                INVALID_RESPONSE: 'INVALID_MODEL_RESPONSE',
                UNAVAILABLE: 'UNAVAILABLE',
                DUPLICATE_REQUEST: 'CANCELLED',
                CLEANUP_UNCONFIRMED: 'CLEANUP_UNCONFIRMED',
                MODEL_FAILED: 'MODEL_FAILED',
                NETWORK: 'NETWORK',
              }
            : {
                RATE_LIMITED: 'RATE_LIMITED',
                UNAUTHORIZED: 'UNAUTHORIZED',
                PROVIDER_AUTH: 'PROVIDER_AUTH',
                PROVIDER_CHANGED: 'PROVIDER_MISMATCH',
                STALE_SESSION: 'CANCELLED',
                BUSY: 'BUSY',
                TIMEOUT: 'TIMEOUT',
                CANCELLED: 'CANCELLED',
                BAD_REQUEST: 'IMAGE_INVALID',
                IMAGE_INVALID: 'IMAGE_INVALID',
                INVALID_RESPONSE: 'INVALID_RESPONSE',
                RESPONSE_INVALID: 'INVALID_RESPONSE',
                UNAVAILABLE: 'OCR_UNAVAILABLE',
                DUPLICATE_REQUEST: 'CANCELLED',
                CLEANUP_UNCONFIRMED: 'WORKER_UNCONFIRMED',
                TOO_LARGE: 'CLOUD_TOO_LARGE',
                NETWORK: 'NETWORK',
              };
      // A backend/body value alone is not an Error capability. Only our own
      // bounded transport error is mapped; arbitrary thrown code fields are ignored.
      const code =
        error instanceof HostedServiceError ? mappings[error.code] || 'NETWORK' : 'NETWORK';
      throw new ErrorType(code);
    }
  }
  return Object.freeze({
    async connect() {
      current();
      metadata = validateServiceMetadata(
        await request('/v1/services', { milliseconds: 10000, maximum: 8192 }),
        owner,
      );
      current();
      return metadata;
    },
    assistant: (payload, { signal } = {}) =>
      capabilityCall('assistant', () => run('assistant', payload, signal)),
    receipt: Object.freeze({
      recognize: (bytes, { signal } = {}) => capabilityCall('ocr', () => run('ocr', bytes, signal)),
    }),
    forecast: (input, { signal } = {}) =>
      capabilityCall('forecast', () => run('forecast', input, signal)),
    isCurrent: () => {
      try {
        current();
        return true;
      } catch {
        return false;
      }
    },
    close() {
      closed = true;
      for (const abort of pending) abort.abort();
      pending.clear();
    },
  });
}
module.exports = { createHostedSession, HostedServiceError };
