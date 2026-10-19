// Explicit real-model verification with synthetic history and owned loopback listeners only.
const http = require('node:http'),
  net = require('node:net'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  { randomBytes, createHash } = require('node:crypto'),
  { DatabaseSync } = require('node:sqlite');
const { startPortableForecast } = require('./prophetProcess.cjs'),
  { createServiceHandler } = require('./server.cjs'),
  { createQuotaStore } = require('./quota.cjs'),
  { createFirebaseVerifier } = require('./firebaseAuth.cjs');
const { createHostedSession } = require('../../src/services/client'),
  { hostedProviderBinding, HOSTED_PROVIDER_HEADER } = require('../../src/services/contract');
const forecast = require('../../src/forecast/protocol');
async function verify(python) {
  assert.ok(path.isAbsolute(python));
  const projectId = 'demo-backend-prophet',
    uid = 'synthetic-owner',
    provider = {
      engine: 'prophet',
      processing: 'cloud',
      version: 'recorded-expense-prophet-v1',
      maxHistoryMonths: 120,
    },
    providers = { assistant: null, ocr: null, forecast: provider };
  const db = new DatabaseSync(':memory:'),
    allowed = new Set();
  let model = null,
    service = null,
    server = null,
    session = null,
    blocked = 0,
    closed = false;
  const originalConnect = net.Socket.prototype.connect,
    realFetch = globalThis.fetch;
  const guarded = function (...args) {
    let first = args[0];
    if (Array.isArray(first)) first = first[0];
    const host = typeof first === 'object' ? first.host : args[1],
      port = Number(typeof first === 'object' ? first.port : first);
    if (host !== '127.0.0.1' || !allowed.has(port)) {
      blocked++;
      throw Error('Unowned network destination');
    }
    return originalConnect.apply(this, args);
  };
  net.Socket.prototype.connect = guarded;
  const localFetch = (url, options) => {
    const value = new URL(url);
    assert.equal(value.protocol, 'http:');
    assert.equal(value.hostname, '127.0.0.1');
    if (value.pathname === '/health' && allowed.size === 0) allowed.add(Number(value.port));
    assert.ok(allowed.has(Number(value.port)));
    return realFetch(url, options);
  };
  const parent = path.resolve(__dirname, '../../.runtime/backend-verification');
  await fs.mkdir(parent, { recursive: true });
  const runtime = path.join(parent, 'prophet-' + randomBytes(6).toString('hex'));
  let proof;
  try {
    model = await startPortableForecast({ python, runtimeDirectory: runtime, fetch: localFetch });
    assert.ok(allowed.has(model.port));
    service = createServiceHandler({
      projectId,
      serviceId: 'real-prophet-check',
      providers,
      mode: 'emulator',
      quota: createQuotaStore(db),
      verifyToken: createFirebaseVerifier({
        projectId,
        mode: 'emulator',
        listenHost: '127.0.0.1',
        fetch: () => {
          throw Error('No external auth fetch');
        },
      }),
      providerFactory: (cap) => {
        assert.equal(cap, 'forecast');
        return model.createAdapter();
      },
    });
    server = http.createServer((req, res) => {
      void service.handle(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    allowed.add(port);
    const origin = 'http://127.0.0.1:' + port;
    const makeToken = (owner) => {
      const at = Math.floor(Date.now() / 1000);
      return (
        Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url') +
        '.' +
        Buffer.from(
          JSON.stringify({
            aud: projectId,
            iss: 'https://securetoken.google.com/' + projectId,
            sub: owner,
            iat: at,
            auth_time: at,
            exp: at + 3600,
            firebase: { sign_in_provider: 'password' },
          }),
        ).toString('base64url') +
        '.'
      );
    };
    const token = makeToken(uid),
      auth = {
        projectId,
        uid,
        ownerToken: 'synthetic-owner-token',
        viewToken: 'synthetic-view-token',
        getIdToken: async () => token,
        isCurrent: () => true,
      };
    session = createHostedSession({
      configuration: { version: 1, mode: 'emulator', origin, projectId },
      auth,
      fetch: localFetch,
    });
    const metadata = await session.connect();
    assert.deepEqual(metadata.providers.forecast, provider);
    const input = forecast.validateInput({
      version: forecast.VERSION,
      currency: 'MYR',
      asOfDate: '2026-10-18',
      history: Array.from({ length: 18 }, (_, i) => {
        const ordinal = 2025 * 12 + 3 + i;
        return {
          month: Math.floor(ordinal / 12) + '-' + String((ordinal % 12) + 1).padStart(2, '0'),
          expenseMinor: 125000 + i * 1500,
        };
      }),
      targetMonths: ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04'],
    });
    const before = JSON.stringify(input);
    const unauth = await localFetch(origin + '/v1/services');
    assert.equal(unauth.status, 401);
    await unauth.arrayBuffer();
    const wrong = await localFetch(origin + '/v1/forecast', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + makeToken('other-owner'),
        'Content-Type': 'application/json',
        [HOSTED_PROVIDER_HEADER]: hostedProviderBinding(metadata, 'forecast'),
      },
      body: JSON.stringify({ ...input, requestId: 'wrong-owner-request-0001' }),
    });
    assert.equal(wrong.status, 409);
    await wrong.arrayBuffer();
    const first = await session.forecast(input, { signal: new AbortController().signal });
    let status = await model.inspect();
    assert.equal(status.idle, true);
    assert.equal(status.lastRun.stoppedConfirmed, true);
    const firstWorker = status.lastRun.pid;
    const abort = new AbortController(),
      cancelled = session.forecast(input, { signal: abort.signal });
    cancelled.catch(() => {});
    let active;
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      status = await model.inspect();
      if (
        !status.idle &&
        status.lastRun.pid &&
        status.lastRun.pid !== firstWorker &&
        status.lastRun.assignedBeforeResume === true
      ) {
        active = status;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(active, 'A new owned Windows worker was not observed before cancellation');
    abort.abort();
    await assert.rejects(cancelled);
    const cancelUntil = Date.now() + 15000;
    while (Date.now() < cancelUntil) {
      status = await model.inspect();
      if (
        status.idle &&
        status.lastRun.pid === active.lastRun.pid &&
        status.lastRun.stoppedConfirmed
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(status.idle, true);
    assert.equal(status.lastRun.pid, active.lastRun.pid);
    assert.equal(status.lastRun.stoppedConfirmed, true);
    assert.equal(status.blocked, false);
    while (service.activeCount) await new Promise((resolve) => setTimeout(resolve, 10));
    const again = await session.forecast(input, { signal: new AbortController().signal });
    assert.deepEqual(again.forecast, first.forecast);
    assert.equal(JSON.stringify(input), before);
    status = await model.inspect();
    assert.equal(status.lastRun.stoppedConfirmed, true);
    assert.equal(blocked, 0);
    proof = {
      passed: true,
      realFlaskProphet: true,
      actualHostedProtocolOverLoopback: true,
      explicitDemoAuthentication: true,
      unauthenticatedRequestDenied: true,
      otherOwnerBindingDenied: true,
      trainingMonths: first.trainingMonths,
      forecast: first.forecast,
      repeatFitMatched: true,
      workerObservedAssignedBeforeCancel: true,
      cancelledWorkerStoppedConfirmed: true,
      finalWorkerStoppedConfirmed: true,
      inputUnchanged: true,
      blockedNetworkAttempts: blocked,
      liveCloudCalls: 0,
    };
  } finally {
    session?.close();
    if (service) await service.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (model) await model.close();
    db.close();
    closed = true;
    if (net.Socket.prototype.connect === guarded) net.Socket.prototype.connect = originalConnect;
  }
  proof.ownedServicesStopped = closed;
  await fs.writeFile(
    path.join(runtime, 'verification.json'),
    JSON.stringify(proof, null, 2) + '\n',
    { flag: 'wx' },
  );
  return proof;
}
module.exports = { verify };
if (require.main === module)
  verify(process.argv[2])
    .then((proof) => console.log(JSON.stringify(proof)))
    .catch(() => {
      console.error(
        'Owned real Prophet verification failed; no private request or credential was printed.',
      );
      process.exitCode = 1;
    });
