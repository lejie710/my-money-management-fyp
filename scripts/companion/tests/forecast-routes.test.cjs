const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http');
const { createForecastRoutes } = require('../forecast/routes.cjs');
const {
  providerRequestBinding,
  PROVIDER_HEADER,
} = require('../../../src/companion/providerContract');
const { ForecastError } = require('../../../src/forecast/protocol');
const f = require('../../../tests/helpers/prophet-fixtures.cjs');
const binding = providerRequestBinding(f.configuration, 'forecast');
async function setup(t, runtime) {
  const routes = createForecastRoutes({ runtime, configuration: f.configuration });
  const server = http.createServer((req, res) => {
    res.setHeader('Connection', 'close');
    const route = routes.find((value) => value.method === req.method && value.path === req.url);
    if (route) void route.handle(req, res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await routes[0].close();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    routes,
    post: async (path, value, headers = {}) => {
      const response = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [PROVIDER_HEADER]: binding, ...headers },
        body: JSON.stringify(value),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}
test('route rejects wrong provider before forwarding and echoes exact binding on success', async (t) => {
  const calls = [];
  const s = await setup(t, {
    forecast: async (value) => {
      calls.push(value);
      return f.result(value);
    },
  });
  let r = await s.post('/v1/forecast', f.wire(), { [PROVIDER_HEADER]: 'stale' });
  assert.equal(r.status, 409);
  assert.equal(calls.length, 0);
  r = await s.post('/v1/forecast', f.wire());
  assert.equal(r.status, 200);
  assert.equal(r.body.providerBinding, binding);
  assert.deepEqual(r.body.provider, f.provider);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], f.wire());
});
test('cancel before request is remembered and cannot start a later fit', async (t) => {
  let calls = 0;
  const s = await setup(t, {
    forecast: async (value) => {
      calls++;
      return f.result(value);
    },
  });
  const r = await s.post('/v1/forecast/cancel', { version: 1, requestId: f.wire().requestId });
  assert.equal(r.status, 200);
  assert.equal((await s.post('/v1/forecast', f.wire())).status, 499);
  assert.equal(calls, 0);
});
test('cancellation waits for the active runtime to stop and wrong identities do not cancel it', async (t) => {
  let entered,
    stopped = false;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const s = await setup(t, {
    forecast: (value, { signal }) =>
      new Promise((resolve, reject) => {
        entered();
        signal.addEventListener(
          'abort',
          () =>
            setImmediate(() => {
              stopped = true;
              reject(new ForecastError('CANCELLED'));
            }),
          { once: true },
        );
      }),
  });
  const work = s.post('/v1/forecast', f.wire());
  await started;
  const other = await s.post('/v1/forecast/cancel', {
    version: 1,
    requestId: 'other_forecast_request_001',
  });
  assert.equal(other.status, 200);
  assert.equal(stopped, false);
  const r = await s.post('/v1/forecast/cancel', { version: 1, requestId: f.wire().requestId });
  assert.equal(r.status, 200);
  assert.equal(stopped, true);
  assert.equal((await work).status, 499);
});
test('malformed monthly data and invalid runtime results are refused', async (t) => {
  let calls = 0;
  const s = await setup(t, {
    forecast: async (value) => {
      calls++;
      return { ...f.result(value), currency: 'JPY' };
    },
  });
  let value = f.wire();
  value.history[0].expenseMinor = -1;
  assert.equal((await s.post('/v1/forecast', value)).status, 400);
  assert.equal(calls, 0);
  assert.equal((await s.post('/v1/forecast', f.wire())).status, 502);
  assert.equal(calls, 1);
});
