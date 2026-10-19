const test = require('node:test'),
  assert = require('node:assert/strict'),
  { Readable } = require('node:stream'),
  { EventEmitter } = require('node:events'),
  { DatabaseSync } = require('node:sqlite');
const { createQuotaStore } = require('../quota.cjs'),
  { createServiceHandler } = require('../server.cjs');
const { HOSTED_PROVIDER_HEADER, hostedProviderBinding } = require('../../../src/services/contract');
const {
  buildAssistantContext,
  buildAssistantRequest,
} = require('../../../src/assistant/grounding');
const { wireFromPayload } = require('../../../src/assistant/protocol');
const { createEmptyLedger } = require('../../../src/core/model');
const projectId = 'demo-money-backup',
  provider = { engine: 'openai', processing: 'cloud', model: 'compatible-model' },
  providers = { assistant: provider, ocr: null, forecast: null };
const metadata = (uid) => ({ version: 1, serviceId: 'test-service', projectId, uid, providers });
const wire = (id) =>
  wireFromPayload(
    buildAssistantRequest(
      buildAssistantContext(createEmptyLedger(), {
        startDate: '2026-10-01',
        endDate: '2026-10-31',
      }),
      'Explain my expenses.',
    ),
    id,
  );
class Reply extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
  }
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }
  end(raw) {
    this.body = JSON.parse(raw);
    this.writableEnded = true;
  }
}
function request(path, uid = 'owner-a', body, headers = {}) {
  const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = Readable.from(bytes ? [bytes] : []);
  req.url = path;
  req.method = bytes ? 'POST' : 'GET';
  req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = {
    authorization: 'Bearer synthetic-token-for-' + uid,
    ...(bytes
      ? { 'content-type': 'application/json', 'content-length': String(bytes.length) }
      : {}),
    ...(path === '/v1/services'
      ? {}
      : { [HOSTED_PROVIDER_HEADER]: hostedProviderBinding(metadata(uid), 'assistant') }),
    ...headers,
  };
  return req;
}
function setup(factory, options = {}) {
  const db = new DatabaseSync(':memory:'),
    quota = createQuotaStore(db, options);
  const server = createServiceHandler({
    projectId,
    serviceId: 'test-service',
    providers,
    mode: 'emulator',
    quota,
    verifyToken: {
      verify: async (t) => ({ projectId, uid: t.slice('synthetic-token-for-'.length) }),
    },
    providerFactory: factory,
  });
  return { server, db, quota };
}
const success = () => ({
  complete: async () => ({
    model: provider.model,
    requestedModel: provider.model,
    provider: { ...provider, requestedModel: provider.model },
    content: JSON.stringify({
      answer: 'No recorded expenses are present in the selected period.',
      factIds: ['expense'],
    }),
    finishReason: 'stop',
  }),
  close() {},
});
test('metadata binds the verified owner and actual configured providers', async () => {
  const s = setup(success),
    res = new Reply();
  await s.server.handle(request('/v1/services'), res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, metadata('owner-a'));
  s.db.close();
});
test('owner/provider mismatch and browser origin reject before provider work', async () => {
  let calls = 0;
  const s = setup(() => {
    calls++;
    return success();
  });
  for (const headers of [
    { [HOSTED_PROVIDER_HEADER]: hostedProviderBinding(metadata('owner-b'), 'assistant') },
    { origin: 'https://example.invalid' },
  ]) {
    const res = new Reply();
    await s.server.handle(
      request('/v1/assistant/explain', 'owner-a', wire('request-owner-a-0001'), headers),
      res,
    );
    assert.ok([400, 409].includes(res.status));
  }
  assert.equal(calls, 0);
  s.db.close();
});
test('real protocol route returns matching provenance and retires duplicate request IDs', async () => {
  const s = setup(success),
    one = new Reply(),
    two = new Reply();
  await s.server.handle(
    request('/v1/assistant/explain', 'owner-a', wire('request-owner-a-0001')),
    one,
  );
  await s.server.handle(
    request('/v1/assistant/explain', 'owner-a', wire('request-owner-a-0001')),
    two,
  );
  assert.equal(one.status, 200);
  assert.equal(one.body.providerBinding, hostedProviderBinding(metadata('owner-a'), 'assistant'));
  assert.equal(two.status, 409);
  assert.equal(s.quota.activeCount, 0);
  s.db.close();
});
test('quota is owner-isolated, concurrency bounded and counters survive wrapper reconstruction', () => {
  const db = new DatabaseSync(':memory:'),
    config = { ownerPerMinute: 1, ownerPerDay: 2, globalPerMinute: 10, globalPerDay: 10 },
    owner = { projectId, uid: 'owner-a' },
    q = createQuotaStore(db, config);
  const release = q.reserve(owner, 'first');
  assert.throws(
    () => q.reserve(owner, 'parallel'),
    (e) => e.code === 'BUSY',
  );
  release();
  assert.throws(
    () => createQuotaStore(db, config).reserve(owner, 'second'),
    (e) => e.code === 'RATE_LIMITED',
  );
  createQuotaStore(db, config).reserve({ projectId, uid: 'owner-b' }, 'third')();
  db.close();
});
test('cancel cannot interrupt another owner; matching owner cancellation waits for completion', async () => {
  let entered;
  const ready = new Promise((r) => (entered = r));
  const s = setup(() => ({
    complete: (_, { signal }) =>
      new Promise((_, reject) => {
        entered();
        signal.addEventListener(
          'abort',
          () => {
            const e = Error('cancelled');
            e.code = 'CANCELLED';
            reject(e);
          },
          { once: true },
        );
      }),
    close() {},
  }));
  const result = new Reply();
  const work = s.server.handle(
    request('/v1/assistant/explain', 'owner-a', wire('request-owner-a-0001')),
    result,
  );
  await ready;
  const wrong = new Reply();
  await s.server.handle(
    request('/v1/assistant/cancel', 'owner-b', { version: 1, requestId: 'request-owner-a-0001' }),
    wrong,
  );
  assert.equal(s.server.activeCount, 1);
  const own = new Reply();
  await s.server.handle(
    request('/v1/assistant/cancel', 'owner-a', { version: 1, requestId: 'request-owner-a-0001' }),
    own,
  );
  await work;
  assert.equal(own.status, 200);
  assert.equal(result.status, 499);
  assert.equal(s.server.activeCount, 0);
  s.db.close();
});
test('unconfirmed provider close blocks success and retires the backend', async () => {
  const s = setup(() => ({
      ...success(),
      close() {
        throw Error('cleanup');
      },
    })),
    res = new Reply();
  await s.server.handle(
    request('/v1/assistant/explain', 'owner-a', wire('request-owner-a-0001')),
    res,
  );
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'CLEANUP_UNCONFIRMED');
  const later = new Reply();
  await s.server.handle(request('/v1/services'), later);
  assert.equal(later.status, 503);
  s.db.close();
});

test('a provider ignoring abort cannot keep the request open or admit further model work', async () => {
  const db = new DatabaseSync(':memory:'),
    quota = createQuotaStore(db);
  let calls = 0;
  const service = createServiceHandler({
    projectId,
    serviceId: 'test-service',
    providers,
    mode: 'emulator',
    quota,
    requestTimeoutMs: 100,
    cleanupTimeoutMs: 50,
    verifyToken: { verify: async () => ({ projectId, uid: 'owner-a' }) },
    providerFactory: () => {
      calls++;
      return { complete: () => new Promise(() => {}), close() {} };
    },
  });
  const first = new Reply();
  await service.handle(
    request('/v1/assistant/explain', 'owner-a', wire('request-unresponsive-0001')),
    first,
  );
  assert.equal(first.status, 504);
  const later = new Reply();
  await service.handle(
    request('/v1/assistant/explain', 'owner-a', wire('request-unresponsive-0002')),
    later,
  );
  assert.equal(later.status, 503);
  assert.equal(calls, 1);
  await assert.rejects(service.close(), (e) => e.code === 'CLEANUP_UNCONFIRMED');
  db.close();
});

test('forwarded HTTPS headers are accepted only from an explicitly trusted proxy peer', async () => {
  const db = new DatabaseSync(':memory:'),
    quota = createQuotaStore(db),
    hostedProject = 'project-finance-reference';
  let verified = 0;
  const service = createServiceHandler({
    projectId: hostedProject,
    serviceId: 'test-service',
    providers,
    mode: 'hosted',
    trustTlsProxy: true,
    trustedProxyPeers: ['10.10.0.2'],
    quota,
    verifyToken: {
      verify: async () => {
        verified++;
        return { projectId: hostedProject, uid: 'owner-a' };
      },
    },
    providerFactory: success,
  });
  for (const peer of ['192.0.2.55', '10.10.0.2']) {
    const req = request('/v1/services');
    req.socket.remoteAddress = peer;
    req.headers['x-forwarded-proto'] = 'https';
    const res = new Reply();
    await service.handle(req, res);
    assert.equal(res.status, peer === '10.10.0.2' ? 200 : 400);
  }
  assert.equal(verified, 1);
  db.close();
});
test('a provider close that hangs is bounded and prevents success', async () => {
  const db = new DatabaseSync(':memory:'),
    quota = createQuotaStore(db);
  const service = createServiceHandler({
    projectId,
    serviceId: 'test-service',
    providers,
    mode: 'emulator',
    quota,
    cleanupTimeoutMs: 50,
    verifyToken: { verify: async () => ({ projectId, uid: 'owner-a' }) },
    providerFactory: () => ({ ...success(), close: () => new Promise(() => {}) }),
  });
  const res = new Reply();
  await service.handle(
    request('/v1/assistant/explain', 'owner-a', wire('request-close-hang-0001')),
    res,
  );
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'CLEANUP_UNCONFIRMED');
  await assert.rejects(service.close());
  db.close();
});
