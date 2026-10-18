const test = require('node:test'),
  assert = require('node:assert/strict');
const { createProphetAdapter } = require('../forecast/prophetAdapter.cjs');
const f = require('../../../tests/helpers/prophet-fixtures.cjs');
const options = { baseUrl: 'http://127.0.0.1:8765', key: 'k'.repeat(43) };
const reply = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
test('private adapter forwards curated request to fixed loopback path with server-only credential', async () => {
  const calls = [];
  const adapter = createProphetAdapter({
    ...options,
    fetch: async (url, settings) => {
      calls.push({ url, settings });
      return reply(f.result(JSON.parse(settings.body)));
    },
  });
  assert.equal(calls.length, 0);
  assert.equal((await adapter.forecast(f.wire())).forecast.length, 6);
  assert.equal(calls[0].url, options.baseUrl + '/v1/forecast');
  assert.equal(calls[0].settings.headers.Authorization, 'Bearer ' + options.key);
  assert.equal(calls[0].settings.redirect, 'error');
  await adapter.close();
});
test('foreign endpoints, redirect and malformed provider result are rejected', async () => {
  assert.throws(() => createProphetAdapter({ ...options, baseUrl: 'https://example.com' }));
  for (const fetcher of [
    async () => ({ redirected: true, url: 'http://127.0.0.1:9999' }),
    async () => reply({ ...f.result(), trainingMonths: 2 }),
  ]) {
    const adapter = createProphetAdapter({ ...options, fetch: fetcher });
    await assert.rejects(adapter.forecast(f.wire()));
    await adapter.close();
  }
});
test('active cancellation requests exact worker cancellation and waits for confirmed stop', async () => {
  const calls = [];
  let resolveStop;
  const adapter = createProphetAdapter({
    ...options,
    fetch: async (url, settings) => {
      calls.push({ url, settings });
      if (url.endsWith('/cancel'))
        return new Promise((resolve) => {
          resolveStop = () =>
            resolve(
              reply({ version: 1, requestId: f.wire().requestId, cancelled: true, stopped: true }),
            );
        });
      return new Promise(() => {});
    },
  });
  const abort = new AbortController();
  const pending = adapter.forecast(f.wire(), { signal: abort.signal });
  abort.abort();
  let settled = false;
  pending.catch(() => {
    settled = true;
  });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].settings.body), {
    version: 1,
    requestId: f.wire().requestId,
  });
  resolveStop();
  await assert.rejects(pending, /cancelled/);
  await adapter.close();
});
test('unconfirmed cancellation blocks reuse and makes shutdown report failure', async () => {
  const adapter = createProphetAdapter({
    ...options,
    cancelTimeoutMs: 10,
    fetch: async () => new Promise(() => {}),
  });
  const abort = new AbortController();
  const pending = adapter.forecast(f.wire(), { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, /not confirmed shutdown/);
  await assert.rejects(adapter.forecast(f.wire()), /not available/);
  await assert.rejects(adapter.close(), /not confirmed shutdown/);
});
test('deadline cancels the owned request and response-size checks remain bounded', async () => {
  const adapter = createProphetAdapter({
    ...options,
    timeoutMs: 10,
    fetch: async (url) =>
      url.endsWith('/cancel')
        ? reply({ version: 1, requestId: f.wire().requestId, cancelled: true, stopped: true })
        : new Promise(() => {}),
  });
  await assert.rejects(adapter.forecast(f.wire()), /deadline/);
  await adapter.close();
  const large = createProphetAdapter({
    ...options,
    fetch: async () =>
      new Response(Buffer.alloc(65537), { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(large.forecast(f.wire()), /size/);
  await large.close();
});

test('known Python cleanup uncertainty prevents any further model request', async () => {
  let calls = 0;
  const adapter = createProphetAdapter({
    ...options,
    fetch: async () => {
      calls++;
      return reply({ error: 'CLEANUP_UNCONFIRMED' }, 503);
    },
  });
  await assert.rejects(adapter.forecast(f.wire()), /not confirmed shutdown/);
  await assert.rejects(adapter.forecast(f.wire()), /not available/);
  assert.equal(calls, 1);
  await assert.rejects(adapter.close(), /not confirmed shutdown/);
});
