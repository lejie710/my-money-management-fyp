const test = require('node:test'),
  assert = require('node:assert/strict');
const { createHostedSession } = require('../../../src/services/client');
const {
  validateServiceConfiguration,
  hostedProviderBinding,
  HOSTED_PROVIDER_HEADER,
} = require('../../../src/services/contract');
const {
  validateProviders,
  validateHostedProviders,
} = require('../../../src/companion/providerContract');
const { createEmptyLedger } = require('../../../src/core/model'),
  { buildAssistantContext, buildAssistantRequest } = require('../../../src/assistant/grounding');
const configuration = {
  version: 1,
  mode: 'hosted',
  origin: 'https://finance.example.invalid',
  projectId: 'project-finance-reference',
};
const provider = { engine: 'openai', processing: 'cloud', model: 'compatible-model' },
  providers = { assistant: provider, ocr: null, forecast: null };
const metadata = {
  version: 1,
  serviceId: 'reference-backend',
  projectId: configuration.projectId,
  uid: 'owner-a',
  providers,
};
const payload = () =>
  buildAssistantRequest(
    buildAssistantContext(createEmptyLedger(), { startDate: '2026-10-01', endDate: '2026-10-31' }),
    'Explain my expenses.',
  );
function reply(url, value, status = 200) {
  const res = new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(JSON.stringify(value))),
    },
  });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}
function owner() {
  let valid = true;
  return {
    binding: {
      projectId: configuration.projectId,
      uid: 'owner-a',
      ownerToken: 'owner-token-a',
      viewToken: {},
      getIdToken: async () => 'synthetic-firebase-token-placeholder',
      isCurrent: () => valid,
    },
    retire() {
      valid = false;
    },
  };
}
const response = (wire) => ({
  version: 1,
  requestId: wire.requestId,
  providerBinding: hostedProviderBinding(metadata, 'assistant'),
  provider: { ...provider, requestedModel: provider.model },
  result: {
    content: JSON.stringify({
      answer: 'The selected period has no recorded expenses.',
      factIds: ['expense'],
    }),
    finishReason: 'stop',
  },
});
test('hosted configuration rejects HTTP/arbitrary paths and emulator bypass outside explicit loopback demo', () => {
  assert.deepEqual(validateServiceConfiguration(configuration), configuration);
  for (const change of [
    { origin: 'http://finance.example.invalid' },
    { origin: configuration.origin + '/api' },
    { origin: 'https://user:password@finance.example.invalid' },
    { mode: 'emulator' },
    { origin: 'http://127.0.0.1:8080' },
  ])
    assert.throws(() => validateServiceConfiguration({ ...configuration, ...change }));
  assert.equal(
    validateServiceConfiguration({
      version: 1,
      mode: 'emulator',
      origin: 'http://127.0.0.1:8080',
      projectId: 'demo-money-backup',
    }).mode,
    'emulator',
  );
});
test('cloud Prophet has its own descriptor validator without weakening companion metadata', () => {
  const value = {
    assistant: null,
    ocr: null,
    forecast: {
      engine: 'prophet',
      processing: 'cloud',
      version: 'recorded-expense-prophet-v1',
      maxHistoryMonths: 120,
    },
  };
  assert.equal(validateHostedProviders(value).forecast.processing, 'cloud');
  assert.throws(() => validateProviders(value));
  assert.throws(() =>
    validateHostedProviders({
      ...providers,
      assistant: { engine: 'lemonade', processing: 'local', model: 'Qwen3-4B-Instruct-2507-GGUF' },
    }),
  );
});
test('mobile hosted assistant gets current token per request, sends canonical facts and accepts matching provenance', async () => {
  const a = owner();
  let tokens = 0;
  const calls = [];
  a.binding.getIdToken = async () => {
    tokens++;
    return 'synthetic-firebase-token-placeholder';
  };
  const session = createHostedSession({
    configuration,
    auth: a.binding,
    createRequestId: () => 'request-mobile-0001',
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/services')) return reply(url, metadata);
      const wire = JSON.parse(options.body);
      assert.equal(wire.question, 'Explain my expenses.');
      assert.equal(
        options.headers[HOSTED_PROVIDER_HEADER],
        hostedProviderBinding(metadata, 'assistant'),
      );
      return reply(url, response(wire));
    },
  });
  await session.connect();
  const answer = await session.assistant(payload(), { signal: new AbortController().signal });
  assert.equal(answer.provider.engine, 'openai');
  assert.equal(tokens, 2);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.url.startsWith(configuration.origin + '/v1/')));
  session.close();
});
test('foreign project metadata never constructs a usable cloud session', async () => {
  const a = owner(),
    session = createHostedSession({
      configuration,
      auth: a.binding,
      fetch: async (url) => reply(url, { ...metadata, projectId: 'different-project' }),
    });
  await assert.rejects(session.connect());
  await assert.rejects(session.assistant(payload(), { signal: new AbortController().signal }));
  session.close();
});
test('identity retirement during token acquisition prevents dispatch and close rejects immediately', async () => {
  const a = owner();
  let release,
    calls = 0;
  a.binding.getIdToken = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const session = createHostedSession({
    configuration,
    auth: a.binding,
    fetch: async () => {
      calls++;
      throw Error('No request expected');
    },
  });
  const result = session.connect();
  await Promise.resolve();
  a.retire();
  session.close();
  await assert.rejects(result, (e) => e.code === 'CANCELLED');
  release('synthetic-firebase-token-placeholder');
  await Promise.resolve();
  assert.equal(calls, 0);
});
test('late response after account retirement is not accepted and no local fallback is attempted', async () => {
  const a = owner();
  let release,
    calls = 0;
  const session = createHostedSession({
    configuration,
    auth: a.binding,
    createRequestId: () => 'request-mobile-0002',
    fetch: async (url, options) => {
      calls++;
      if (url.endsWith('/services')) return reply(url, metadata);
      return new Promise((resolve) => {
        release = () => resolve(reply(url, response(JSON.parse(options.body))));
      });
    },
  });
  await session.connect();
  const work = session.assistant(payload(), { signal: new AbortController().signal });
  while (!release) await Promise.resolve();
  a.retire();
  release();
  await assert.rejects(work, (e) => e.code === 'CANCELLED');
  assert.equal(calls, 2);
  session.close();
});
test('changed provider binding and deliberate rate errors stay visible instead of falling back', async () => {
  for (const kind of ['binding', 'rate']) {
    const a = owner(),
      session = createHostedSession({
        configuration,
        auth: a.binding,
        createRequestId: () => 'request-mobile-0003',
        fetch: async (url, options) => {
          if (url.endsWith('/services')) return reply(url, metadata);
          return kind === 'rate'
            ? reply(url, { error: { code: 'RATE_LIMITED' } }, 429)
            : reply(url, { ...response(JSON.parse(options.body)), providerBinding: 'different' });
        },
      });
    await session.connect();
    await assert.rejects(
      session.assistant(payload(), { signal: new AbortController().signal }),
      (e) => e.code === (kind === 'rate' ? 'RATE_LIMITED' : 'PROVIDER_MISMATCH'),
    );
    session.close();
  }
});
test('unresponsive hosted transport is bounded independently of an ignored abort signal', async () => {
  const a = owner(),
    session = createHostedSession({
      configuration,
      auth: a.binding,
      timeoutMs: 50,
      fetch: async (url) =>
        url.endsWith('/services') ? reply(url, metadata) : new Promise(() => {}),
    });
  await session.connect();
  await assert.rejects(
    session.assistant(payload(), { signal: new AbortController().signal }),
    (e) => e.code === 'TIMEOUT',
  );
  session.close();
});
