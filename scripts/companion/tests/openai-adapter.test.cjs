'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../..');
const protocol = require(path.join(root, 'src/assistant/protocol'));
const grounding = require(path.join(root, 'src/assistant/grounding'));
const model = require(path.join(root, 'src/core/model'));
const adapterModule = require('../assistant/openaiAdapter.cjs');
const {
  createOpenAIAdapter,
  OpenAIAdapterError,
  OPENAI_ENDPOINT,
  MAX_RESPONSE_BYTES,
  MAX_RESPONSE_CHUNKS,
  MAX_EMPTY_CHUNKS,
} = adapterModule;
const PRIVATE_TEST_KEY = 'synthetic-private-key-for-offline-contract-tests';
const MODEL = 'synthetic-openai-model';
const context = () =>
  grounding.buildAssistantContext(model.createEmptyLedger(), {
    startDate: '2026-10-01',
    endDate: '2026-10-31',
  });
const payload = () => grounding.buildAssistantRequest(context(), 'Explain recorded income.');
const content = JSON.stringify({
  answer: 'Recorded income is MYR 0.00. Income-based ratios are undefined.',
  factIds: ['income', 'ratios'],
});
const completion = (changes = {}) => ({
  object: 'chat.completion',
  model: MODEL,
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content, refusal: null },
    },
  ],
  ...changes,
});
function response(value = completion(), options = {}) {
  const bytes = Buffer.from(JSON.stringify(value));
  const chunks = options.chunks || [bytes];
  const counters = { reads: 0, cancels: 0, readers: 0 };
  let index = 0;
  const cancel = async () => {
    counters.cancels++;
  };
  const reader = {
    async read() {
      counters.reads++;
      if (options.read) return options.read();
      return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true };
    },
    cancel,
    releaseLock() {},
  };
  const result = {
    ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
    status: options.status ?? 200,
    url: options.url ?? OPENAI_ENDPOINT,
    redirected: options.redirected ?? false,
    headers: {
      get(name) {
        if (name === 'content-type') return options.contentType ?? 'application/json';
        if (name === 'content-length')
          return Object.hasOwn(options, 'length') ? options.length : String(bytes.length);
        return null;
      },
    },
    body: {
      cancel,
      getReader() {
        counters.readers++;
        return reader;
      },
    },
  };
  return { result, counters };
}
function fixture(fetcher = async () => response().result, extra = {}) {
  const calls = [];
  const adapter = createOpenAIAdapter({
    apiKey: PRIVATE_TEST_KEY,
    model: MODEL,
    requestContract: protocol,
    fetch: async (url, request) => {
      assert.equal(url, OPENAI_ENDPOINT, 'Only the fixed official endpoint may be requested');
      assert.equal(request.method, 'POST');
      calls.push({ url, request });
      return fetcher(url, request);
    },
    ...extra,
  });
  return { adapter, calls };
}
const code = (expected) => (error) => {
  assert.ok(error instanceof OpenAIAdapterError);
  assert.equal(error.code, expected);
  assert.equal(String(error).includes(PRIVATE_TEST_KEY), false);
  return true;
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  return {
    promise: new Promise((done) => {
      resolve = done;
    }),
    resolve: (value) => resolve(value),
  };
}

test('module import and configured construction make no network or credential-discovery request', () => {
  let network = 0;
  const sandbox = {
    module: { exports: {} },
    require: (name) => {
      assert.equal(name, '../providerWork.cjs');
      return require('../providerWork.cjs');
    },
    fetch: () => {
      network++;
      throw Error('Forbidden network');
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../assistant/openaiAdapter.cjs'), 'utf8'),
    sandbox,
  );
  const adapter = sandbox.module.exports.createOpenAIAdapter({
    apiKey: PRIVATE_TEST_KEY,
    model: MODEL,
    requestContract: protocol,
  });
  assert.equal(network, 0);
  assert.equal(adapter.status().busy, false);
  adapter.close();
  assert.equal(network, 0);
  assert.equal(JSON.stringify(adapter.status()).includes(PRIVATE_TEST_KEY), false);
});

test('missing credentials/model, endpoint overrides and invalid limits fail before any request', () => {
  let calls = 0;
  const base = {
    apiKey: PRIVATE_TEST_KEY,
    model: MODEL,
    requestContract: protocol,
    fetch: () => {
      calls++;
    },
  };
  for (const change of [
    { apiKey: undefined },
    { apiKey: '' },
    { apiKey: 'key\nwith-control' },
    { model: undefined },
    { model: '' },
    { model: 'https://another.invalid' },
    { baseUrl: 'https://another.invalid' },
    { timeoutMs: 0 },
    { timeoutMs: 120001 },
    { maxCompletionTokens: 2049 },
    { maxCompletionTokens: 1 },
    { requestContract: {} },
  ])
    assert.throws(() => createOpenAIAdapter({ ...base, ...change }), code('CONFIGURATION'));
  assert.equal(calls, 0);
});

test('explicit completion sends only canonical selected facts with OpenAI structured output and bounded options', async () => {
  const f = fixture();
  const input = {
    ...payload(),
    tools: [{ privateData: 'must-not-leave' }],
    apiKey: 'must-not-leave',
  };
  const output = await f.adapter.complete(input);
  assert.equal(f.calls.length, 1);
  const request = f.calls[0].request,
    body = JSON.parse(request.body);
  assert.equal(request.headers.Authorization, `Bearer ${PRIVATE_TEST_KEY}`);
  assert.equal(request.redirect, 'error');
  assert.equal(request.credentials, 'omit');
  assert.deepEqual(Object.keys(body).sort(), [
    'max_completion_tokens',
    'messages',
    'model',
    'n',
    'response_format',
    'store',
    'stream',
  ]);
  assert.equal(body.model, MODEL);
  assert.equal(body.max_completion_tokens, 1024);
  assert.equal(body.n, 1);
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
  const wire = protocol.wireFromPayload(payload(), 'synthetic-request-123');
  assert.deepEqual(
    body.response_format.json_schema.schema.properties.factIds.items.enum,
    wire.facts.map((fact) => fact.id),
  );
  assert.deepEqual(body.messages, protocol.payloadFromWire(wire).messages);
  assert.equal(request.body.includes(PRIVATE_TEST_KEY), false);
  assert.equal(request.body.includes('must-not-leave'), false);
  assert.equal(output.provider.engine, 'openai');
  assert.equal(output.provider.processing, 'cloud');
  assert.equal(output.requestedModel, MODEL);
  assert.equal(output.model, MODEL);
  assert.equal(output.finishReason, 'stop');
  assert.equal(output.content, content);
  assert.equal(output.backend, undefined);
  assert.deepEqual(f.adapter.status(), { busy: false, closed: false });
});

test('invalid grounded requests and oversized encoded bodies are rejected without dispatch', async () => {
  const f = fixture();
  for (const input of [null, {}, { ...payload(), model: 'other' }, { ...payload(), messages: [] }])
    await assert.rejects(f.adapter.complete(input), code('BAD_REQUEST'));
  const large = fixture(undefined, {
    requestContract: {
      wireFromPayload: () => ({ facts: [{ id: 'income' }] }),
      payloadFromWire: () => ({
        messages: [
          { role: 'system', content: 'x'.repeat(33000) },
          { role: 'user', content: '{}' },
          { role: 'user', content: '{}' },
        ],
      }),
    },
  });
  await assert.rejects(large.adapter.complete({}), code('TOO_LARGE'));
  assert.equal(f.calls.length, 0);
  assert.equal(large.calls.length, 0);
});

test('HTTP authentication, rate and provider failures expose fixed messages without reading error bodies', async () => {
  for (const [status, expected] of [
    [401, 'UNAUTHORIZED'],
    [403, 'UNAUTHORIZED'],
    [429, 'RATE_LIMITED'],
    [400, 'MODEL_UNAVAILABLE'],
    [500, 'MODEL_UNAVAILABLE'],
  ]) {
    const fake = response({ error: { message: PRIVATE_TEST_KEY } }, { status });
    const f = fixture(async () => fake.result);
    await assert.rejects(f.adapter.complete(payload()), code(expected));
    assert.equal(fake.counters.readers, 0);
    assert.ok(fake.counters.cancels > 0);
    assert.equal(f.calls.length, 1);
  }
});

test('redirects, foreign response origins, invalid media types and oversized declared responses fail closed', async () => {
  for (const options of [
    { redirected: true },
    { url: 'https://another.invalid/completion' },
    { contentType: 'text/html' },
    { length: 'not-a-length' },
    { length: String(MAX_RESPONSE_BYTES + 1) },
  ]) {
    const fake = response(completion(), options);
    const f = fixture(async () => fake.result);
    await assert.rejects(f.adapter.complete(payload()), code('INVALID_RESPONSE'));
    assert.equal(fake.counters.readers, 0);
    assert.equal(f.calls.length, 1);
  }
});

test('actual streamed bytes are bounded without Content-Length and invalid UTF8/JSON is rejected', async () => {
  for (const chunks of [
    [Buffer.alloc(MAX_RESPONSE_BYTES + 1)],
    [Buffer.from([0xc3, 0x28])],
    [Buffer.from('{broken')],
  ]) {
    const fake = response({}, { length: null, chunks });
    const f = fixture(async () => fake.result);
    await assert.rejects(f.adapter.complete(payload()), code('INVALID_RESPONSE'));
    assert.ok(fake.counters.cancels > 0);
  }
  const bytes = Buffer.from(JSON.stringify(completion()));
  const good = response({}, { length: null, chunks: [bytes.subarray(0, 20), bytes.subarray(20)] });
  assert.equal(
    (await fixture(async () => good.result).adapter.complete(payload())).content,
    content,
  );
});

test('refusals and incomplete or tool-bearing completions never become accepted explanations', async () => {
  const cases = [
    [
      {
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          refusal: 'Private provider text',
          content: null,
        },
      },
      'REFUSED',
    ],
    [{ finish_reason: 'length', message: { role: 'assistant', content } }, 'INCOMPLETE'],
    [
      {
        finish_reason: 'content_filter',
        message: { role: 'assistant', content },
      },
      'INCOMPLETE',
    ],
    [
      {
        finish_reason: 'stop',
        message: { role: 'assistant', content, tool_calls: [{}] },
      },
      'INVALID_RESPONSE',
    ],
    [
      {
        finish_reason: 'stop',
        message: { role: 'assistant', content, refusal: {} },
      },
      'INVALID_RESPONSE',
    ],
  ];
  for (const [choice, expected] of cases) {
    const f = fixture(async () => response(completion({ choices: [choice] })).result);
    await assert.rejects(f.adapter.complete(payload()), code(expected));
  }
});

test('only supplied unique string fact IDs and a bounded answer are accepted', async () => {
  const cases = [
    { answer: 'An explanation.', factIds: ['notSupplied'] },
    { answer: 'An explanation.', factIds: [1] },
    { answer: 'An explanation.', factIds: ['income', 'income'] },
    { answer: '', factIds: ['income'] },
    { answer: 'word '.repeat(181), factIds: ['income'] },
    { answer: 'x'.repeat(1201), factIds: ['income'] },
    { answer: 'An explanation.', factIds: [], extra: true },
  ];
  for (const answer of cases) {
    const f = fixture(
      async () =>
        response(
          completion({
            choices: [
              {
                finish_reason: 'stop',
                message: { role: 'assistant', content: JSON.stringify(answer) },
              },
            ],
          }),
        ).result,
    );
    await assert.rejects(f.adapter.complete(payload()), code('INVALID_RESPONSE'));
  }
});

test('reported model aliases remain truthful instead of impersonating the local Qwen provider', async () => {
  const f = fixture(
    async () => response(completion({ model: 'synthetic-resolved-snapshot' })).result,
  );
  const result = await f.adapter.complete(payload());
  assert.equal(result.requestedModel, MODEL);
  assert.equal(result.model, 'synthetic-resolved-snapshot');
  assert.notEqual(result.model, protocol.MODEL_ID);
});

test('malformed completion envelopes and invalid JSON content are rejected before returning provider metadata', async () => {
  for (const raw of [
    null,
    {},
    completion({ choices: [] }),
    completion({ choices: [completion().choices[0], completion().choices[0]] }),
    completion({ model: undefined }),
    completion({ model: 'https://foreign.invalid' }),
    completion({ object: 'other' }),
    completion({
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: '{broken' },
        },
      ],
    }),
    completion({
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'x'.repeat(1801) },
        },
      ],
    }),
  ]) {
    const f = fixture(async () => response(raw).result);
    await assert.rejects(f.adapter.complete(payload()), code('INVALID_RESPONSE'));
    assert.equal(f.calls.length, 1);
  }
});

test('invalid cancellation handles and malformed injected contract results fail with bounded messages before dispatch', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.complete(payload(), { signal: {} }), code('BAD_REQUEST'));
  const invalid = fixture(undefined, {
    requestContract: {
      wireFromPayload: () => ({ facts: [null] }),
      payloadFromWire: () => ({}),
    },
  });
  await assert.rejects(invalid.adapter.complete(payload()), code('BAD_REQUEST'));
  assert.equal(f.calls.length, 0);
  assert.equal(invalid.calls.length, 0);
  const invalidMessage = fixture(undefined, {
    requestContract: {
      wireFromPayload: () => ({ facts: [{ id: 'income' }] }),
      payloadFromWire: () => ({
        messages: [null, { role: 'user', content: '{}' }, { role: 'user', content: '{}' }],
      }),
    },
  });
  await assert.rejects(invalidMessage.adapter.complete(payload()), code('BAD_REQUEST'));
  assert.equal(invalidMessage.calls.length, 0);
});

test('duplicate pending calls are rejected and each deliberate later call makes exactly one request', async () => {
  const work = deferred();
  let dispatched = 0;
  const f = fixture(async () => (++dispatched === 1 ? work.promise : response().result));
  const pending = f.adapter.complete(payload());
  await assert.rejects(f.adapter.complete(payload()), code('BUSY'));
  await flush();
  assert.equal(f.calls.length, 1);
  work.resolve(response().result);
  await pending;
  assert.equal(f.adapter.status().busy, false);
  await f.adapter.complete(payload());
  assert.equal(f.calls.length, 2);
});

test('caller cancellation rejects immediately and cancels a response arriving after the caller left', async () => {
  const work = deferred(),
    controller = new AbortController();
  const f = fixture(async () => work.promise);
  const pending = f.adapter.complete(payload(), { signal: controller.signal });
  await flush();
  controller.abort();
  await assert.rejects(pending, code('CANCELLED'));
  assert.equal(f.calls[0].request.signal.aborted, true);
  const late = response();
  work.resolve(late.result);
  await flush();
  assert.ok(late.counters.cancels > 0);
  assert.equal(late.counters.readers, 0);
  assert.equal(f.calls.length, 1);
});

test('deadline covers stalled headers and stalled bodies without automatic retries', async () => {
  for (const stall of ['headers', 'body']) {
    const never = new Promise(() => {});
    const fake = response({}, { read: () => never });
    const f = fixture(async () => (stall === 'headers' ? never : fake.result), {
      timeoutMs: 50,
    });
    await assert.rejects(f.adapter.complete(payload()), code('TIMEOUT'));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].request.signal.aborted, true);
    assert.equal(f.adapter.status().busy, true);
    await assert.rejects(f.adapter.complete(payload()), code('BUSY'));
    if (stall === 'body') assert.ok(fake.counters.cancels > 0);
  }
});

test('monotonic elapsed checks stop immediately resolving headers and chunks even if timer callbacks are starved', async () => {
  for (const phase of ['headers', 'body', 'empty-chunks']) {
    let elapsed = 0;
    const fake = response(
      {},
      {
        read: async () => {
          elapsed += 10;
          return {
            done: false,
            value: phase === 'empty-chunks' ? Buffer.alloc(0) : Buffer.from(' '),
          };
        },
      },
    );
    const f = fixture(
      async () => {
        if (phase === 'headers') elapsed = 50;
        return fake.result;
      },
      { timeoutMs: 50, now: () => elapsed },
    );
    await assert.rejects(f.adapter.complete(payload()), code('TIMEOUT'));
    assert.equal(f.calls.length, 1);
    assert.ok(fake.counters.cancels > 0);
    if (phase === 'headers') assert.equal(fake.counters.readers, 0);
    else assert.equal(fake.counters.reads, 5);
  }
});

test('empty and excessive chunk counts are bounded independently of byte size', async () => {
  for (const [value, limit] of [
    [Buffer.alloc(0), MAX_EMPTY_CHUNKS],
    [Buffer.from(' '), MAX_RESPONSE_CHUNKS],
  ]) {
    const fake = response({}, { length: null, read: async () => ({ done: false, value }) });
    const f = fixture(async () => fake.result, { now: () => 0 });
    await assert.rejects(f.adapter.complete(payload()), code('INVALID_RESPONSE'));
    assert.equal(fake.counters.reads, limit + 1);
    assert.ok(fake.counters.cancels > 0);
  }
  const bytes = Buffer.from(JSON.stringify(completion()));
  const sparse = response(
    {},
    {
      length: null,
      chunks: [Buffer.alloc(0), bytes.subarray(0, 20), Buffer.alloc(0), bytes.subarray(20)],
    },
  );
  assert.equal(
    (await fixture(async () => sparse.result).adapter.complete(payload())).content,
    content,
  );
});

test('expired elapsed time at end of body prevents successful acceptance', async () => {
  let atEnd = false,
    afterEnd = 0,
    sent = false;
  const bytes = Buffer.from(JSON.stringify(completion()));
  const fake = response(
    {},
    {
      length: null,
      read: async () => {
        if (!sent) {
          sent = true;
          return { done: false, value: bytes };
        }
        atEnd = true;
        return { done: true };
      },
    },
  );
  const f = fixture(async () => fake.result, {
    timeoutMs: 50,
    now: () => (atEnd ? (++afterEnd === 1 ? 49 : 50) : 0),
  });
  await assert.rejects(f.adapter.complete(payload()), code('TIMEOUT'));
  assert.equal(f.calls.length, 1);
});

test('unreadable or backwards monotonic clocks fail without extending the deadline', async () => {
  const invalid = fixture(undefined, { now: () => NaN });
  await assert.rejects(invalid.adapter.complete(payload()), code('CONFIGURATION'));
  assert.equal(invalid.calls.length, 0);
  let time = 10;
  const f = fixture(
    async () => {
      time = 9;
      return response().result;
    },
    { now: () => time },
  );
  await assert.rejects(f.adapter.complete(payload()), code('TIMEOUT'));
  assert.equal(f.calls.length, 1);
});

test('close cancels pending work and rejects later calls; pre-aborted requests never dispatch', async () => {
  const f = fixture(async () => new Promise(() => {}));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    f.adapter.complete(payload(), { signal: aborted.signal }),
    code('CANCELLED'),
  );
  assert.equal(f.calls.length, 0);
  const pending = f.adapter.complete(payload());
  await flush();
  f.adapter.close();
  await assert.rejects(pending, code('CANCELLED'));
  await assert.rejects(f.adapter.complete(payload()), code('CANCELLED'));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.adapter.status(), { busy: true, closed: true });
});

test('transport exceptions never expose raw diagnostics, selected facts or credentials', async () => {
  const f = fixture(async () => {
    throw Error(PRIVATE_TEST_KEY + ' private input');
  });
  await assert.rejects(f.adapter.complete(payload()), code('NETWORK'));
  assert.equal(f.calls.length, 1);
});

test('the financial ledger is unchanged and existing semantic assessment remains a separate required gate', async () => {
  const ledger = model.createEmptyLedger();
  const before = JSON.stringify(ledger);
  const selected = grounding.buildAssistantContext(ledger, {
    startDate: '2026-10-01',
    endDate: '2026-10-31',
  });
  const writeClaim = JSON.stringify({
    answer: 'I have saved a new transaction.',
    factIds: ['income'],
  });
  const f = fixture(
    async () =>
      response(
        completion({
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: writeClaim },
            },
          ],
        }),
      ).result,
  );
  const output = await f.adapter.complete(
    grounding.buildAssistantRequest(selected, 'Explain these facts.'),
  );
  assert.equal(JSON.stringify(ledger), before);
  assert.equal(grounding.assessAnswer(selected, output.content).accepted, false);
  assert.equal(grounding.assessAnswer(selected, output.content).code, 'WRITE_CLAIM');
});

test('a valid 180-word answer remains inside the expanded grounded response contract', async () => {
  const answer = { answer: 'word '.repeat(180).trim(), factIds: ['income'] };
  const f = fixture(
    async () =>
      response(
        completion({
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: JSON.stringify(answer) },
            },
          ],
        }),
      ).result,
  );
  const output = await f.adapter.complete(payload());
  assert.equal(JSON.parse(output.content).answer.split(/\s+/).length, 180);
});
