const test = require('node:test');
const assert = require('node:assert/strict');
const { createForecastClient } = require('../src/forecast/client');
const { providerRequestBinding, PROVIDER_HEADER } = require('../src/companion/providerContract');
const f = require('./helpers/prophet-fixtures.cjs');
const binding = providerRequestBinding(f.configuration, 'forecast');
const reply = (value, status = 200) => {
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    },
  });
};
const envelope = (request) => ({
  version: 1,
  requestId: request.requestId,
  providerBinding: binding,
  provider: f.provider,
  result: f.result(request),
});
test('client sends only explicit selected history with exact provider header, never on construction', async () => {
  const calls = [];
  const client = createForecastClient(f.configuration, {
    createRequestId: () => f.wire().requestId,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return reply(envelope(JSON.parse(options.body)));
    },
  });
  assert.equal(calls.length, 0);
  const response = await client.forecast(f.input(), { signal: new AbortController().signal });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/v1/forecast');
  assert.equal(calls[0].options.headers[PROVIDER_HEADER], binding);
  assert.deepEqual(JSON.parse(calls[0].options.body), f.wire());
  assert.equal(response.forecast.length, 6);
});
test('client rejects disabled provider, wrong echoed binding and mismatched result', async () => {
  assert.throws(
    () =>
      createForecastClient({
        ...f.configuration,
        providers: {
          ocr: { engine: 'windows-media-ocr', processing: 'local', maxImageBytes: 10485760 },
          assistant: null,
          forecast: null,
        },
      }),
    /not available/,
  );
  for (const mutate of [
    (v) => {
      v.providerBinding = 'other';
    },
    (v) => {
      v.result.currency = 'JPY';
    },
    (v) => {
      v.requestId = 'another_request_000';
    },
  ]) {
    const client = createForecastClient(f.configuration, {
      createRequestId: () => f.wire().requestId,
      fetch: async () => {
        const value = envelope(f.wire());
        mutate(value);
        return reply(value);
      },
    });
    await assert.rejects(client.forecast(f.input(), { signal: new AbortController().signal }));
  }
});
test('pre-cancel makes no request, and active cancellation sends exact cancel identity and ignores late result', async () => {
  const calls = [];
  let resolve;
  const client = createForecastClient(f.configuration, {
    createRequestId: () => f.wire().requestId,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/cancel'))
        return reply({
          version: 1,
          requestId: f.wire().requestId,
          providerBinding: binding,
          cancelled: true,
        });
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const before = new AbortController();
  before.abort();
  await assert.rejects(client.forecast(f.input(), { signal: before.signal }), /cancelled/);
  assert.equal(calls.length, 0);
  const active = new AbortController();
  const pending = client.forecast(f.input(), { signal: active.signal });
  active.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    version: 1,
    requestId: f.wire().requestId,
  });
  assert.equal(calls[1].options.headers[PROVIDER_HEADER], binding);
  resolve(reply(envelope(f.wire())));
  await new Promise(setImmediate);
});
test('client bounds response and model wait without accepting a malformed result', async () => {
  for (const fetcher of [
    async () =>
      new Response('{}', {
        headers: { 'content-type': 'application/json', 'content-length': '999999' },
      }),
    async () => reply({ bad: true }),
  ]) {
    await assert.rejects(
      createForecastClient(f.configuration, { fetch: fetcher }).forecast(f.input(), {
        signal: new AbortController().signal,
      }),
    );
  }
  const client = createForecastClient(f.configuration, {
    timeoutMs: 10,
    fetch: async (url) =>
      url.endsWith('/cancel') ? reply({ cancelled: true }) : new Promise(() => {}),
  });
  await assert.rejects(
    client.forecast(f.input(), { signal: new AbortController().signal }),
    /deadline/,
  );
});
