// Explicit owned loopback smoke. Real HTTP/auth/mobile code; OpenAI upstream is injected.
const http = require('node:http'),
  net = require('node:net'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  { DatabaseSync } = require('node:sqlite');
const { createServiceHandler } = require('./server.cjs'),
  { createQuotaStore } = require('./quota.cjs'),
  { createFirebaseVerifier } = require('./firebaseAuth.cjs');
const {
  createOpenAIAdapter,
  OPENAI_ENDPOINT,
} = require('../../scripts/companion/assistant/openaiAdapter.cjs');
const { createHostedSession } = require('../../src/services/client'),
  protocol = require('../../src/assistant/protocol');
const { createEmptyLedger } = require('../../src/core/model'),
  {
    buildAssistantContext,
    buildAssistantRequest,
    assessAnswer,
  } = require('../../src/assistant/grounding');
async function verify() {
  const projectId = 'demo-backend-reference',
    uid = 'synthetic-owner',
    model = 'offline-compatible-model',
    providers = {
      assistant: { engine: 'openai', processing: 'cloud', model },
      ocr: null,
      forecast: null,
    };
  const db = new DatabaseSync(':memory:');
  let server = null,
    service = null,
    session = null,
    port = null,
    upstreamCalls = 0,
    aborted = 0,
    blocked = 0,
    delayNext = false,
    entered = null;
  const original = net.Socket.prototype.connect;
  const guarded = function (...args) {
    let first = args[0];
    if (Array.isArray(first)) first = first[0];
    const host = typeof first === 'object' ? first.host : args[1],
      target = typeof first === 'object' ? first.port : first;
    if (host !== '127.0.0.1' || Number(target) !== port) {
      blocked++;
      throw Error('Only the owned loopback listener is allowed.');
    }
    return original.apply(this, args);
  };
  const upstream = async (url, options) => {
    assert.equal(url, OPENAI_ENDPOINT);
    upstreamCalls++;
    const body = JSON.parse(options.body);
    assert.equal(body.model, model);
    assert.equal(body.messages.length, 3);
    if (delayNext) {
      delayNext = false;
      entered?.();
      await new Promise((_, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            aborted++;
            reject(Error('cancelled'));
          },
          { once: true },
        );
      });
    }
    const value = {
      object: 'chat.completion',
      model,
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: JSON.stringify({
              answer: 'No expenses were recorded in the selected period.',
              factIds: ['expense'],
            }),
          },
        },
      ],
    };
    const response = new Response(JSON.stringify(value), {
      headers: { 'content-type': 'application/json' },
    });
    Object.defineProperty(response, 'url', { value: OPENAI_ENDPOINT });
    return response;
  };
  try {
    service = createServiceHandler({
      projectId,
      serviceId: 'loopback-verification',
      providers,
      mode: 'emulator',
      verifyToken: createFirebaseVerifier({
        projectId,
        mode: 'emulator',
        listenHost: '127.0.0.1',
        fetch: () => {
          throw Error('No certificate fetch in explicit emulator mode');
        },
      }),
      quota: createQuotaStore(db),
      providerFactory: () =>
        createOpenAIAdapter({
          apiKey: 'synthetic-placeholder-never-sent-to-a-provider',
          model,
          requestContract: protocol,
          fetch: upstream,
        }),
    });
    server = http.createServer((req, res) => {
      void service.handle(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    net.Socket.prototype.connect = guarded;
    const now = Math.floor(Date.now() / 1000),
      token =
        Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') +
        '.' +
        Buffer.from(
          JSON.stringify({
            aud: projectId,
            iss: 'https://securetoken.google.com/' + projectId,
            sub: uid,
            iat: now,
            auth_time: now,
            exp: now + 3600,
            firebase: { sign_in_provider: 'password' },
          }),
        ).toString('base64url') +
        '.';
    session = createHostedSession({
      configuration: {
        version: 1,
        mode: 'emulator',
        origin: 'http://127.0.0.1:' + port,
        projectId,
      },
      auth: {
        projectId,
        uid,
        ownerToken: 'synthetic-owner-binding',
        viewToken: {},
        getIdToken: async () => token,
        isCurrent: () => true,
      },
    });
    const metadata = await session.connect();
    assert.equal(metadata.uid, uid);
    assert.equal(metadata.providers.assistant.engine, 'openai');
    const ledger = createEmptyLedger(),
      originalLedger = JSON.stringify(ledger),
      context = buildAssistantContext(ledger, { startDate: '2026-10-01', endDate: '2026-10-31' }),
      payload = buildAssistantRequest(context, 'Explain my expenses.');
    const first = await session.assistant(payload, { signal: new AbortController().signal });
    assert.equal(assessAnswer(context, first.content).accepted, true);
    delayNext = true;
    const started = new Promise((resolve) => {
        entered = resolve;
      }),
      abort = new AbortController(),
      cancelled = session.assistant(payload, { signal: abort.signal });
    await started;
    abort.abort();
    await assert.rejects(cancelled);
    const until = Date.now() + 5000;
    while (service.activeCount && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(service.activeCount, 0);
    const final = await session.assistant(payload, { signal: new AbortController().signal });
    assert.equal(assessAnswer(context, final.content).accepted, true);
    assert.equal(JSON.stringify(ledger), originalLedger);
    assert.equal(blocked, 0);
    assert.equal(upstreamCalls, 3);
    assert.ok(aborted >= 1);
    return {
      passed: true,
      actualLoopbackHttp: true,
      explicitAuthEmulatorMode: true,
      injectedOpenAIUpstream: true,
      liveProviderRequests: 0,
      metadataOwnerMatched: true,
      acceptedAnswers: 2,
      cancelThenRetry: true,
      upstreamCalls,
      abortedRequests: aborted,
      blockedNetworkAttempts: blocked,
      ledgerUnchanged: true,
    };
  } finally {
    session?.close();
    await service?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    db.close();
    if (net.Socket.prototype.connect === guarded) net.Socket.prototype.connect = original;
  }
}
module.exports = { verify };
if (require.main === module)
  verify()
    .then(async (proof) => {
      const directory = path.resolve(__dirname, '../../.runtime/backend-verification');
      await fs.mkdir(directory, { recursive: true });
      const file = path.join(directory, 'http-' + Date.now() + '.json');
      await fs.writeFile(
        file,
        JSON.stringify({ ...proof, ownedListenerStopped: true }, null, 2) + '\n',
        { flag: 'wx' },
      );
      console.log(JSON.stringify({ ...proof, ownedListenerStopped: true }));
    })
    .catch(() => {
      console.error(
        'Owned local backend verification failed; no credentials or request content were printed.',
      );
      process.exitCode = 1;
    });
