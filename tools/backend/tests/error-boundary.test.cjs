const test = require('node:test'),
  assert = require('node:assert/strict'),
  { Readable } = require('node:stream'),
  { EventEmitter } = require('node:events'),
  { DatabaseSync } = require('node:sqlite');
const { createServiceHandler } = require('../server.cjs'),
  { createQuotaStore } = require('../quota.cjs'),
  { ServiceError } = require('../bounded.cjs');
const { OpenAIAdapterError } = require('../../../scripts/companion/assistant/openaiAdapter.cjs');
const { createHostedSession } = require('../../../src/services/client'),
  { createAssistantSession } = require('../../../src/assistant/sessionGate'),
  { buildAssistantContext } = require('../../../src/assistant/grounding'),
  { createEmptyLedger } = require('../../../src/core/model');
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
  end(bytes) {
    this.bytes = bytes;
    this.writableEnded = true;
  }
}
for (const sample of [
  { upstream: 'RATE_LIMITED', expected: 'RATE_LIMITED' },
  { upstream: 'UNAUTHORIZED', expected: 'PROVIDER_AUTH' },
  { upstream: 'MODEL_UNAVAILABLE', expected: 'MODEL_UNAVAILABLE' },
  { authDenied: true, expected: 'UNAUTHORIZED' },
])
  test(`actual gateway/mobile/session gate preserves ${sample.expected}`, async () => {
    const projectId = 'demo-error-boundary',
      uid = 'owner-a',
      provider = { engine: 'openai', processing: 'cloud', model: 'compatible-model' },
      db = new DatabaseSync(':memory:');
    let deny = false;
    const service = createServiceHandler({
      projectId,
      serviceId: 'error-check',
      providers: { assistant: provider, ocr: null, forecast: null },
      mode: 'emulator',
      quota: createQuotaStore(db),
      verifyToken: {
        verify: async () => {
          if (deny) throw new ServiceError('UNAUTHORIZED', 401);
          return { projectId, uid };
        },
      },
      providerFactory: () => ({
        complete: async () => {
          throw new OpenAIAdapterError(sample.upstream);
        },
        close() {},
      }),
    });
    const bridge = async (url, options = {}) => {
      const req = Readable.from(options.body ? [Buffer.from(options.body)] : []);
      req.url = new URL(url).pathname;
      req.method = options.method || 'GET';
      req.socket = { remoteAddress: '127.0.0.1' };
      req.headers = Object.fromEntries(
        Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]),
      );
      const res = new Reply();
      await service.handle(req, res);
      const response = new Response(res.bytes, { status: res.status, headers: res.headers });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    };
    const hosted = createHostedSession({
      configuration: { version: 1, mode: 'emulator', origin: 'http://127.0.0.1:40001', projectId },
      auth: {
        projectId,
        uid,
        ownerToken: 'owner',
        viewToken: 'view',
        getIdToken: async () => 'synthetic-auth-token-placeholder',
        isCurrent: () => true,
      },
      fetch: bridge,
    });
    await hosted.connect();
    deny = sample.authDenied === true;
    const context = buildAssistantContext(createEmptyLedger(), {
        startDate: '2026-10-01',
        endDate: '2026-10-31',
      }),
      session = createAssistantSession({
        actorKey: 'owner-a',
        sessionKey: 'panel-a',
        context,
        isCurrent: () => true,
        transport: hosted.assistant,
        expectedProvider: provider,
      });
    const result = await session.ask('Explain my expenses.');
    assert.equal(result.status, 'unavailable');
    assert.equal(result.code, sample.expected);
    session.close();
    hosted.close();
    await service.close();
    db.close();
  });
test('arbitrary thrown code fields cannot impersonate trusted hosted errors', async () => {
  const projectId = 'demo-untrusted-errors',
    provider = { engine: 'openai', processing: 'cloud', model: 'compatible-model' },
    metadata = {
      version: 1,
      serviceId: 'error-check',
      projectId,
      uid: 'owner-a',
      providers: { assistant: provider, ocr: null, forecast: null },
    };
  const hosted = createHostedSession({
    configuration: { version: 1, mode: 'emulator', origin: 'http://127.0.0.1:40001', projectId },
    auth: {
      projectId,
      uid: 'owner-a',
      ownerToken: 'owner',
      viewToken: 'view',
      getIdToken: async () => 'synthetic-auth-token-placeholder',
      isCurrent: () => true,
    },
    fetch: async (url) => {
      if (url.endsWith('/services')) {
        const r = new Response(JSON.stringify(metadata), {
          headers: { 'content-type': 'application/json' },
        });
        Object.defineProperty(r, 'url', { value: url });
        return r;
      }
      throw { code: 'RATE_LIMITED', message: 'untrusted detail' };
    },
  });
  await hosted.connect();
  const context = buildAssistantContext(createEmptyLedger(), {
      startDate: '2026-10-01',
      endDate: '2026-10-31',
    }),
    session = createAssistantSession({
      actorKey: 'owner-a',
      sessionKey: 'panel-a',
      context,
      isCurrent: () => true,
      transport: hosted.assistant,
      expectedProvider: provider,
    });
  const result = await session.ask('Explain my expenses.');
  assert.equal(result.code, 'NETWORK');
  session.close();
  hosted.close();
});
