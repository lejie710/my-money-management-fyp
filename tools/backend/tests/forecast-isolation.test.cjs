const test = require('node:test'),
  assert = require('node:assert/strict'),
  { Readable } = require('node:stream'),
  { EventEmitter } = require('node:events'),
  { DatabaseSync } = require('node:sqlite');
const { createServiceHandler } = require('../server.cjs'),
  { createQuotaStore } = require('../quota.cjs');
const { createProphetAdapter } = require('../../../scripts/companion/forecast/prophetAdapter.cjs'),
  protocol = require('../../../src/forecast/protocol');
const { hostedProviderBinding, HOSTED_PROVIDER_HEADER } = require('../../../src/services/contract');
const projectId = 'demo-forecast-isolation',
  provider = {
    engine: 'prophet',
    processing: 'cloud',
    version: protocol.VERSION,
    maxHistoryMonths: 120,
  },
  providers = { assistant: null, ocr: null, forecast: provider },
  externalId = 'same-client-request-id-0001';
const input = {
  version: protocol.VERSION,
  requestId: externalId,
  currency: 'MYR',
  asOfDate: '2026-10-18',
  history: Array.from({ length: 18 }, (_, i) => {
    const n = 2025 * 12 + 3 + i;
    return {
      month: Math.floor(n / 12) + '-' + String((n % 12) + 1).padStart(2, '0'),
      expenseMinor: 10000 + i * 100,
    };
  }),
  targetMonths: ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04'],
};
const metadata = (uid) => ({ version: 1, serviceId: 'isolation-check', projectId, uid, providers });
class Reply extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
  }
  writeHead(status) {
    this.status = status;
  }
  end(raw) {
    this.body = JSON.parse(raw);
    this.writableEnded = true;
  }
}
function request(uid, cancel = false) {
  const bytes = Buffer.from(JSON.stringify(cancel ? { version: 1, requestId: externalId } : input)),
    req = Readable.from([bytes]);
  req.url = '/v1/forecast' + (cancel ? '/cancel' : '');
  req.method = 'POST';
  req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = {
    authorization: 'Bearer synthetic-token-for-' + uid,
    'content-type': 'application/json',
    'content-length': String(bytes.length),
    [HOSTED_PROVIDER_HEADER]: hostedProviderBinding(metadata(uid), 'forecast'),
  };
  return req;
}
function response(url, value) {
  const res = new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}
function result(wire) {
  return {
    version: protocol.VERSION,
    requestId: wire.requestId,
    provider: 'prophet',
    currency: wire.currency,
    asOfDate: wire.asOfDate,
    trainingThroughMonth: '2026-09',
    trainingMonths: 18,
    predictionUnit: 'currency-minor-unit',
    rounding: 'half-away-from-zero',
    negativePredictionPolicy: 'preserve-and-label',
    hasNegativePredictions: false,
    intervals: null,
    settings: protocol.SETTINGS,
    forecast: wire.targetMonths.map((month, i) => ({
      month,
      lead: i + 2,
      predictedMinor: 12000 + i,
    })),
  };
}
test('two owners sharing an external ID cannot cancel each other in the real gateway/Prophet adapter boundary', async () => {
  const db = new DatabaseSync(':memory:'),
    seen = [],
    cancelIds = [];
  let resolveA,
    arriveA,
    arriveB,
    innerCancelledA = false;
  const startedA = new Promise((r) => (arriveA = r)),
    startedB = new Promise((r) => (arriveB = r));
  const privateFetch = async (url, options) => {
    const wire = JSON.parse(options.body);
    if (url.endsWith('/cancel')) {
      cancelIds.push(wire.requestId);
      if (wire.requestId === seen[0]?.requestId) innerCancelledA = true;
      return response(url, {
        version: 1,
        requestId: wire.requestId,
        cancelled: true,
        stopped: true,
      });
    }
    seen.push(wire);
    if (seen.length === 1) {
      arriveA();
      return new Promise((resolve) => {
        resolveA = () => resolve(response(url, result(wire)));
      });
    }
    arriveB();
    return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(Error('request aborted')), {
        once: true,
      });
    });
  };
  const service = createServiceHandler({
    projectId,
    serviceId: 'isolation-check',
    providers,
    mode: 'emulator',
    quota: createQuotaStore(db),
    verifyToken: {
      verify: async (token) => ({ projectId, uid: token.slice('synthetic-token-for-'.length) }),
    },
    providerFactory: () =>
      createProphetAdapter({
        baseUrl: 'http://127.0.0.1:40001',
        key: 'synthetic-private-token-placeholder-000000000000',
        fetch: privateFetch,
      }),
  });
  const a = new Reply(),
    b = new Reply(),
    cancelB = new Reply();
  const first = service.handle(request('owner-a'), a);
  await startedA;
  const second = service.handle(request('owner-b'), b);
  await startedB;
  await service.handle(request('owner-b', true), cancelB);
  await second;
  assert.equal(cancelB.status, 200);
  assert.equal(b.status, 499);
  assert.equal(innerCancelledA, false);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].requestId, seen[1].requestId);
  assert.ok(seen.every((w) => w.requestId !== externalId));
  assert.deepEqual(cancelIds, [seen[1].requestId]);
  assert.equal(service.activeCount, 1);
  resolveA();
  await first;
  assert.equal(a.status, 200);
  assert.equal(a.body.requestId, externalId);
  assert.equal(a.body.result.requestId, externalId);
  protocol.validateResult(a.body.result, input);
  await service.close();
  db.close();
});
