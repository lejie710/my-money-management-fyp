const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectImageHeader } = require('../src/attachments/imageHeader');
const core = require('../src/core/model');
const receipt = require('../src/core/receipt');
const grounding = require('../src/assistant/grounding');
const protocol = require('../src/assistant/protocol');
const { createAssistantSession } = require('../src/assistant/sessionGate');
const { createAssistantClient } = require('../src/assistant/client');
const { createReceiptClient } = require('../src/receipts/client');
const { createAssistantRoutes } = require('../scripts/companion/assistant/routes.cjs');
const { createReceiptCompanion } = require('../scripts/companion/ocr/companion.cjs');
const {
  createOpenAIAdapter,
  OpenAIAdapterError,
  OPENAI_ENDPOINT,
} = require('../scripts/companion/assistant/openaiAdapter.cjs');
const {
  createGoogleVisionWorker,
  normalizeVisionResponse,
  ENDPOINT: VISION_ENDPOINT,
} = require('../scripts/companion/ocr/googleVisionWorker.cjs');
const { PROVIDER_HEADER, providerRequestBinding } = require('../src/companion/providerContract');
const { deferred, flush } = require('./helpers/native-adapter-vm.cjs');
const nativeFetch = globalThis.fetch;
let unexpectedNetwork = 0;
globalThis.fetch = (url, options) => {
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(String(url))) {
    unexpectedNetwork++;
    throw Error('Only local fixture servers are permitted.');
  }
  return nativeFetch(url, options);
};
after(() => {
  globalThis.fetch = nativeFetch;
  assert.equal(unexpectedNetwork, 0);
});
const OPENAI = Object.freeze({
  engine: 'openai',
  processing: 'cloud',
  model: 'synthetic-model-alias',
});
const VISION = Object.freeze({
  engine: 'google-cloud-vision',
  processing: 'cloud',
  maxImageBytes: 6291456,
});
const WINDOWS = Object.freeze({
  engine: 'windows-media-ocr',
  processing: 'local',
  maxImageBytes: 10485760,
});
const LOCAL = Object.freeze({ engine: 'lemonade', processing: 'local', model: grounding.MODEL_ID });
const providers = (assistant = OPENAI, ocr = VISION) => ({ assistant, ocr, forecast: null });
const configuration = (selected = providers()) => ({
  version: 2,
  runId: 'provider-contract-tests',
  providers: selected,
  token: 'synthetic_pairing_token_1234567890123456789012345',
  url: 'http://127.0.0.1:8787/v1/recognize',
});
const context = () =>
  grounding.buildAssistantContext(core.createEmptyLedger(), {
    startDate: '2026-10-01',
    endDate: '2026-10-31',
  });
const payload = () => grounding.buildAssistantRequest(context(), 'Explain income.');
const answer = JSON.stringify({
  answer: 'Recorded income is MYR 0.00. Income-based ratios are undefined.',
  factIds: ['income', 'ratios'],
});
const openaiResult = (content = answer) => ({
  model: 'synthetic-model-snapshot',
  requestedModel: OPENAI.model,
  content,
  finishReason: 'stop',
  provider: {
    engine: 'openai',
    processing: 'cloud',
    model: 'synthetic-model-snapshot',
    requestedModel: OPENAI.model,
  },
});
const jsonResponse = (value, status = 200) => {
  const text = JSON.stringify(value);
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
  });
};
const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/images/receipt-a.png'));
function visionDocument() {
  const lines = ['GROCERY SHOP', 'DATE 2026-10-18', 'TOTAL RM12.50'];
  return {
    responses: [
      {
        fullTextAnnotation: {
          text: lines.join('\n'),
          pages: [
            {
              width: 1100,
              height: 900,
              confidence: 0.8,
              property: { detectedLanguages: [{ languageCode: 'en', confidence: 0.9 }] },
              blocks: [
                {
                  paragraphs: [
                    {
                      words: lines.flatMap((line, row) =>
                        line.split(' ').map((text, column) => {
                          const x = 20 + column * 260,
                            y = 30 + row * 60;
                          return {
                            symbols: [...text].map((text) => ({ text })),
                            confidence: 0.75,
                            boundingBox: {
                              vertices: [
                                { x, y },
                                { x: x + 240, y },
                                { x: x + 240, y: y + 30 },
                                { x, y: y + 30 },
                              ],
                            },
                          };
                        }),
                      ),
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  };
}
const visionResult = () => normalizeVisionResponse(visionDocument(), inspectImageHeader(bytes), 1);
async function service(selected, options, run) {
  const config = configuration(selected);
  const server = createReceiptCompanion({
    token: config.token,
    worker: options.worker ?? {
      recognize: async () => {
        throw Error('Unexpected OCR');
      },
    },
    provider: selected.ocr,
    binding: selected.ocr ? providerRequestBinding(config, 'ocr') : null,
    routes: options.runtime
      ? createAssistantRoutes({
          runtime: options.runtime,
          provider: selected.assistant,
          binding: providerRequestBinding(config, 'assistant'),
        })
      : [],
  });
  const endpoint = await server.listen(0);
  try {
    await run({ ...config, url: endpoint.url });
  } finally {
    await server.close();
  }
}

test('explicit OpenAI request traverses paired local route with selected facts, truthful model alias and unchanged ledger', async () => {
  let calls = 0;
  const runtime = createOpenAIAdapter({
    apiKey: 'synthetic-private-provider-key',
    model: OPENAI.model,
    requestContract: protocol,
    fetch: async (url, options) => {
      assert.equal(url, OPENAI_ENDPOINT);
      calls++;
      const body = JSON.parse(options.body);
      assert.equal(body.model, OPENAI.model);
      assert.equal(body.messages.length, 3);
      assert.equal(body.store, false);
      assert.equal(body.stream, false);
      assert.ok(!JSON.stringify(body).includes('synthetic-private-provider-key'));
      const response = jsonResponse({
        object: 'chat.completion',
        model: 'synthetic-model-snapshot',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: answer, refusal: null },
          },
        ],
      });
      Object.defineProperty(response, 'url', { value: OPENAI_ENDPOINT });
      return response;
    },
  });
  const ledger = core.createEmptyLedger(),
    before = JSON.stringify(ledger);
  await service(providers(OPENAI, null), { runtime }, async (config) => {
    const client = createAssistantClient(config, { createRequestId: () => crypto.randomUUID() });
    assert.equal(calls, 0);
    const result = await client.complete(payload());
    assert.equal(result.model, 'synthetic-model-snapshot');
    assert.equal(result.requestedModel, OPENAI.model);
    assert.equal(result.provider.engine, 'openai');
    assert.equal(result.provider.processing, 'cloud');
    assert.equal(grounding.assessAnswer(context(), result.content).accepted, true);
    assert.equal(calls, 1);
  });
  assert.equal(JSON.stringify(ledger), before);
});

test('assistant rejects missing or mismatched provider binding before parsing/forwarding explain and cancel', async () => {
  let calls = 0;
  await service(
    providers(OPENAI, null),
    {
      runtime: {
        complete: async () => {
          calls++;
          return openaiResult();
        },
      },
    },
    async (config) => {
      for (const suffix of ['explain', 'cancel'])
        for (const supplied of [undefined, 'wrong-binding']) {
          const response = await fetch(
            config.url.replace('/v1/recognize', '/v1/assistant/' + suffix),
            {
              method: 'POST',
              headers: {
                Authorization: 'Bearer ' + config.token,
                'content-type': 'application/json',
                ...(supplied ? { [PROVIDER_HEADER]: supplied } : {}),
              },
              body: '{',
            },
          );
          assert.equal(response.status, 409);
          assert.equal((await response.json()).error.code, 'PROVIDER_MISMATCH');
        }
      assert.equal(calls, 0);
    },
  );
});

test('cloud response echo, model and provenance mismatches are never accepted by the mobile client', async () => {
  const config = configuration(providers(OPENAI, null));
  for (const alteration of [
    (r) => ({ ...r, providerBinding: 'other' }),
    (r) => ({ ...r, provider: { ...r.provider, processing: 'local' } }),
    (r) => ({ ...r, provider: { ...r.provider, requestedModel: 'other' } }),
    (r) => ({ ...r, provider: { ...r.provider, engine: 'lemonade' } }),
  ]) {
    const client = createAssistantClient(config, {
      createRequestId: () => 'synthetic_request_1234',
      fetch: async (_url, options) => {
        assert.equal(options.headers[PROVIDER_HEADER], providerRequestBinding(config, 'assistant'));
        const result = openaiResult();
        return jsonResponse(
          alteration({
            version: 1,
            requestId: 'synthetic_request_1234',
            providerBinding: providerRequestBinding(config, 'assistant'),
            provider: result.provider,
            result: { content: result.content, finishReason: 'stop' },
          }),
        );
      },
    });
    await assert.rejects(
      client.complete(payload()),
      (error) => error.code === 'INVALID_MODEL_RESPONSE',
    );
  }
});

test('OpenAI errors are mapped to deliberate safe client codes without upstream diagnostics', async () => {
  for (const [source, expected] of [
    ['UNAUTHORIZED', 'PROVIDER_AUTH'],
    ['RATE_LIMITED', 'RATE_LIMITED'],
    ['REFUSED', 'REFUSED'],
    ['INCOMPLETE', 'INCOMPLETE'],
    ['TIMEOUT', 'TIMEOUT'],
  ]) {
    await service(
      providers(OPENAI, null),
      {
        runtime: {
          complete: async () => {
            throw new OpenAIAdapterError(source);
          },
        },
      },
      async (config) => {
        await assert.rejects(
          createAssistantClient(config, { createRequestId: () => crypto.randomUUID() }).complete(
            payload(),
          ),
          (error) => error.code === expected && !error.message.includes('synthetic-private'),
        );
      },
    );
  }
});

test('assistant cancellation carries provider binding and aborts the owned cloud request without accepting late content', async () => {
  const entered = deferred(),
    release = deferred();
  let aborted = false,
    cancels = 0;
  await service(
    providers(OPENAI, null),
    {
      runtime: {
        async complete(_value, { signal }) {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              release.resolve();
            },
            { once: true },
          );
          entered.resolve();
          await release.promise;
          return openaiResult();
        },
      },
    },
    async (config) => {
      const client = createAssistantClient(config, {
        createRequestId: () => crypto.randomUUID(),
        fetch: async (url, options) => {
          assert.equal(
            options.headers[PROVIDER_HEADER],
            providerRequestBinding(config, 'assistant'),
          );
          if (url.endsWith('/cancel')) cancels++;
          return fetch(url, options);
        },
      });
      const abort = new AbortController(),
        pending = client.complete(payload(), { signal: abort.signal });
      await entered.promise;
      abort.abort();
      await assert.rejects(pending, (error) => error.code === 'CANCELLED');
      for (let index = 0; index < 30 && !aborted; index++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(aborted, true);
      assert.equal(cancels, 1);
    },
  );
});

test('provider-aware session still rejects write claims and drops stale cloud results', async () => {
  let current = true;
  const gate = createAssistantSession({
    actorKey: 'wallet-owner',
    sessionKey: 'session',
    context: context(),
    expectedProvider: OPENAI,
    isCurrent: () => current,
    transport: async () =>
      openaiResult(JSON.stringify({ answer: 'I have saved a transaction.', factIds: ['income'] })),
  });
  assert.equal((await gate.ask('Explain income.')).status, 'rejected');
  gate.close();
  const wait = deferred();
  const stale = createAssistantSession({
    actorKey: 'wallet-owner',
    sessionKey: 'next',
    context: context(),
    expectedProvider: OPENAI,
    isCurrent: () => current,
    transport: () => wait.promise,
  });
  const pending = stale.ask('Explain income.');
  await flush();
  current = false;
  wait.resolve(openaiResult());
  assert.equal((await pending).status, 'stale');
  stale.close();
});

test('Google Vision passes through paired route and preserves geometry/provenance until explicit ordinary expense confirmation', async () => {
  let calls = 0;
  const worker = createGoogleVisionWorker({
    apiKey: 'synthetic-vision-credential',
    inspectImageHeader,
    fetchImpl: async (url, options) => {
      assert.equal(url, VISION_ENDPOINT);
      calls++;
      assert.deepEqual(
        Buffer.from(JSON.parse(options.body).requests[0].image.content, 'base64'),
        bytes,
      );
      return jsonResponse(visionDocument());
    },
  });
  const ledger = core.createEmptyLedger(),
    before = JSON.stringify(ledger);
  await service(providers(null, VISION), { worker }, async (config) => {
    const client = createReceiptClient(config);
    assert.equal(calls, 0);
    const recognized = await client.recognize(bytes);
    assert.equal(recognized.provider, 'google-cloud-vision');
    assert.equal(recognized.language, 'en');
    assert.equal(recognized.words[0].polygon.length, 4);
    assert.equal(recognized.words[0].confidence, 0.75);
    const candidate = receipt.parseReceipt(recognized, {
      walletCurrency: 'MYR',
      today: '2026-10-18',
    });
    assert.equal(candidate.provider, 'google-cloud-vision');
    assert.equal(candidate.total.suggestedMinor, 1250);
    const review = {
      title: 'Groceries',
      date: '2026-10-18',
      amount: '12.50',
      currency: 'MYR',
      categoryId: 'expense-food',
      confirmed: false,
    };
    assert.throws(() =>
      receipt.reviewedReceiptTransaction(ledger, candidate, review, 'expense-review'),
    );
    assert.equal(JSON.stringify(ledger), before);
    const transaction = receipt.reviewedReceiptTransaction(
      ledger,
      candidate,
      { ...review, confirmed: true },
      'expense-review',
    );
    assert.equal(transaction.type, 'expense');
    assert.equal(transaction.amountMinor, 1250);
    assert.equal(calls, 1);
  });
  assert.equal(JSON.stringify(ledger), before);
});

test('Vision binding, six-MiB limit and declared provider mismatch reject before accepting OCR', async () => {
  let calls = 0;
  await service(
    providers(null, VISION),
    {
      worker: {
        async recognize() {
          calls++;
          return visionResult();
        },
      },
    },
    async (config) => {
      const rejected = await fetch(config.url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + config.token, 'content-type': 'image/png' },
        body: bytes,
      });
      assert.equal(rejected.status, 409);
      assert.equal(calls, 0);
      await assert.rejects(
        createReceiptClient(config).recognize(new Uint8Array(6291457)),
        (error) => error.code === 'CLOUD_TOO_LARGE',
      );
      assert.equal(calls, 0);
    },
  );
  const config = configuration(providers(null, VISION));
  const local = {
    version: 1,
    provider: 'windows-media-ocr',
    language: 'en-US',
    width: 1100,
    height: 900,
    elapsedMs: 1,
    textAngle: null,
    words: [],
  };
  await assert.rejects(
    createReceiptClient(config, {
      fetch: async () =>
        jsonResponse({
          version: 1,
          providerBinding: providerRequestBinding(config, 'ocr'),
          ocr: local,
        }),
    }).recognize(bytes),
    (error) => error.code === 'INVALID_RESPONSE',
  );
  await assert.rejects(
    createReceiptClient(config, {
      fetch: async () =>
        jsonResponse({ version: 1, providerBinding: 'other', ocr: visionResult() }),
    }).recognize(bytes),
    (error) => error.code === 'INVALID_RESPONSE',
  );
});

test('Vision metadata validation rejects invented geometry/confidence and keeps original result immutable', () => {
  const value = visionResult(),
    before = JSON.stringify(value);
  for (const alteration of [
    (r) => ({ ...r, pageConfidence: 2 }),
    (r) => ({ ...r, language: 'en-US' }),
    (r) => ({ ...r, words: [{ ...r.words[0], polygon: [{ x: 1, y: 1 }] }] }),
    (r) => ({ ...r, words: [{ ...r.words[0], confidence: NaN }] }),
  ])
    assert.throws(() => receipt.validateOcrResult(alteration(value)));
  assert.equal(JSON.stringify(value), before);
});

test('unresponsive receipt fetch/body respects cancellation and deadlines without a second upload', async () => {
  const config = configuration(providers(null, VISION));
  let calls = 0;
  const client = createReceiptClient(config, {
    timeoutMs: 50,
    fetch: () => {
      calls++;
      return new Promise(() => {});
    },
  });
  await assert.rejects(client.recognize(bytes), (error) => error.code === 'TIMEOUT');
  assert.equal(calls, 1);
  const abort = new AbortController(),
    pending = client.recognize(bytes, { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, (error) => error.code === 'CANCELLED');
  assert.equal(calls, 2);
});

test('v2 local providers remain local and disabled modalities cannot silently construct clients', async () => {
  await service(
    providers(LOCAL, WINDOWS),
    {
      runtime: {
        complete: async () => ({
          model: grounding.MODEL_ID,
          backend: 'cpu',
          content: answer,
          finishReason: 'stop',
        }),
      },
      worker: {
        recognize: async () => ({
          version: 1,
          provider: 'windows-media-ocr',
          language: 'en-US',
          width: 1100,
          height: 900,
          elapsedMs: 1,
          textAngle: null,
          words: [],
        }),
      },
    },
    async (config) => {
      assert.equal(
        (
          await createAssistantClient(config, {
            createRequestId: () => crypto.randomUUID(),
          }).complete(payload())
        ).provider.processing,
        'local',
      );
      assert.equal(
        (await createReceiptClient(config).recognize(bytes)).provider,
        'windows-media-ocr',
      );
    },
  );
  assert.throws(() =>
    createAssistantClient(configuration(providers(null, WINDOWS)), {
      createRequestId: () => crypto.randomUUID(),
    }),
  );
  assert.throws(() => createReceiptClient(configuration(providers(OPENAI, null))));
  assert.throws(() => createAssistantRoutes({ runtime: { complete() {} }, provider: OPENAI }));
  assert.throws(() => createReceiptCompanion({ worker: { recognize() {} }, provider: VISION }));
});
