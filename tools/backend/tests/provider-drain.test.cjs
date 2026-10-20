const test = require('node:test'),
  assert = require('node:assert/strict'),
  { Readable } = require('node:stream'),
  { EventEmitter } = require('node:events'),
  { DatabaseSync } = require('node:sqlite'),
  fs = require('node:fs'),
  path = require('node:path');
const { createServiceHandler } = require('../server.cjs'),
  { createQuotaStore } = require('../quota.cjs');
const {
    createOpenAIAdapter,
    OPENAI_ENDPOINT,
  } = require('../../../scripts/companion/assistant/openaiAdapter.cjs'),
  {
    createGoogleVisionWorker,
    ENDPOINT,
  } = require('../../../scripts/companion/ocr/googleVisionWorker.cjs');
const { inspectImageHeader } = require('../../../src/attachments/imageHeader'),
  { hostedProviderBinding, HOSTED_PROVIDER_HEADER } = require('../../../src/services/contract');
const protocol = require('../../../src/assistant/protocol'),
  { buildAssistantContext, buildAssistantRequest } = require('../../../src/assistant/grounding'),
  { createEmptyLedger } = require('../../../src/core/model');
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
for (const cap of ['assistant', 'ocr'])
  for (const stall of ['headers', 'body'])
    test(`actual ${cap} adapter ${stall} work ignoring abort quarantines gateway admission and shutdown`, async () => {
      const projectId = 'demo-provider-drain',
        uid = 'owner-a',
        providers = {
          assistant:
            cap === 'assistant'
              ? { engine: 'openai', processing: 'cloud', model: 'compatible-model' }
              : null,
          ocr:
            cap === 'ocr'
              ? { engine: 'google-cloud-vision', processing: 'cloud', maxImageBytes: 6291456 }
              : null,
          forecast: null,
        };
      const metadata = { version: 1, serviceId: 'drain-check', projectId, uid, providers };
      let factories = 0,
        rawCalls = 0;
      const ignored = async () => {
        rawCalls++;
        if (stall === 'headers') return new Promise(() => {});
        return {
          ok: true,
          status: 200,
          url: cap === 'assistant' ? OPENAI_ENDPOINT : ENDPOINT,
          redirected: false,
          headers: new Headers({ 'content-type': 'application/json' }),
          body: {
            getReader: () => ({
              read: () => new Promise(() => {}),
              cancel: () => Promise.resolve(),
              releaseLock() {},
            }),
            cancel: () => Promise.resolve(),
          },
        };
      };
      const db = new DatabaseSync(':memory:'),
        quota = createQuotaStore(db),
        service = createServiceHandler({
          projectId,
          serviceId: 'drain-check',
          providers,
          mode: 'emulator',
          quota,
          cleanupTimeoutMs: 50,
          verifyToken: { verify: async () => ({ projectId, uid }) },
          providerFactory: () => {
            factories++;
            return cap === 'assistant'
              ? createOpenAIAdapter({
                  apiKey: 'synthetic-placeholder-only',
                  model: 'compatible-model',
                  requestContract: protocol,
                  fetch: ignored,
                  timeoutMs: 50,
                })
              : createGoogleVisionWorker({
                  apiKey: 'synthetic-placeholder-only',
                  inspectImageHeader,
                  fetchImpl: ignored,
                  timeoutMs: 20,
                });
          },
        });
      function request(id) {
        const body =
          cap === 'assistant'
            ? Buffer.from(
                JSON.stringify(
                  protocol.wireFromPayload(
                    buildAssistantRequest(
                      buildAssistantContext(createEmptyLedger(), {
                        startDate: '2026-10-01',
                        endDate: '2026-10-31',
                      }),
                      'Explain my expenses.',
                    ),
                    id,
                  ),
                ),
              )
            : fs.readFileSync(path.join(__dirname, '../../../tests/fixtures/images/receipt-a.png'));
        const req = Readable.from([body]);
        req.url = cap === 'assistant' ? '/v1/assistant/explain' : '/v1/recognize';
        req.method = 'POST';
        req.socket = { remoteAddress: '127.0.0.1' };
        req.headers = {
          authorization: 'Bearer synthetic-auth-token-placeholder',
          'content-type': cap === 'assistant' ? 'application/json' : 'image/png',
          'content-length': String(body.length),
          'x-mymoney-request-id': id,
          [HOSTED_PROVIDER_HEADER]: hostedProviderBinding(metadata, cap),
        };
        return req;
      }
      const first = new Reply();
      await service.handle(request('first-raw-work-request-0001'), first);
      assert.equal(first.status, 504);
      const later = new Reply();
      await service.handle(request('second-raw-work-request-0002'), later);
      assert.equal(later.status, 503);
      assert.equal(factories, 1);
      assert.equal(rawCalls, 1);
      assert.equal(quota.activeCount, 0);
      await assert.rejects(service.close(), (e) => e.code === 'CLEANUP_UNCONFIRMED');
      db.close();
    });
