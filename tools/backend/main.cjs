// Explicit executable entry; importing this module starts no listener and reads no credential.
const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  https = require('node:https'),
  { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createFirebaseVerifier } = require('./firebaseAuth.cjs'),
  { createQuotaStore } = require('./quota.cjs'),
  { createServiceHandler } = require('./server.cjs');
const { createOpenAIAdapter } = require('../../scripts/companion/assistant/openaiAdapter.cjs');
const { createGoogleVisionWorker } = require('../../scripts/companion/ocr/googleVisionWorker.cjs');
const { inspectImageHeader } = require('../../src/attachments/imageHeader');
const assistantProtocol = require('../../src/assistant/protocol');
const { validateHostedProviders } = require('../../src/companion/providerContract');
const { validProjectId } = require('../../src/services/contract');
function configuration(env) {
  const projectId = env.FIREBASE_PROJECT_ID,
    serviceId = env.SERVICE_ID,
    mode = env.BACKEND_MODE || 'hosted',
    host = env.LISTEN_HOST || '127.0.0.1',
    port = Number(env.PORT || 8080);
  if (
    !validProjectId(projectId) ||
    !serviceId ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(serviceId) ||
    !['hosted', 'emulator'].includes(mode) ||
    !['127.0.0.1', '0.0.0.0', '::1'].includes(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw Error('Invalid backend configuration.');
  if (
    mode === 'emulator' &&
    (!projectId.startsWith('demo-') || !['127.0.0.1', '::1'].includes(host))
  )
    throw Error('Emulator configuration must remain private and local.');
  const optionalKey = (value) => (value === '' || value === undefined ? undefined : value);
  const openaiKey = optionalKey(env.OPENAI_API_KEY),
    visionKey = optionalKey(env.GOOGLE_VISION_API_KEY);
  const providers = {
    assistant: openaiKey
      ? { engine: 'openai', processing: 'cloud', model: env.OPENAI_MODEL }
      : null,
    ocr: visionKey
      ? { engine: 'google-cloud-vision', processing: 'cloud', maxImageBytes: 6291456 }
      : null,
    forecast:
      env.ENABLE_PROPHET === '1'
        ? {
            engine: 'prophet',
            processing: 'cloud',
            version: 'recorded-expense-prophet-v1',
            maxHistoryMonths: 120,
          }
        : null,
  };
  validateHostedProviders(providers);
  for (const key of [openaiKey, visionKey])
    if (key !== undefined && (typeof key !== 'string' || !/^[\x21-\x7e]{20,512}$/.test(key)))
      throw Error('Invalid private provider credential.');
  if (providers.forecast && (!env.PROPHET_PYTHON || !path.isAbsolute(env.PROPHET_PYTHON)))
    throw Error('Choose an installed Python environment.');
  if (!env.BACKEND_DATA_DIR || !path.isAbsolute(env.BACKEND_DATA_DIR))
    throw Error('Choose an absolute private data directory.');
  const trustTlsProxy = env.TRUSTED_TLS_PROXY === '1';
  const trustedProxyPeers = (env.TRUSTED_PROXY_PEERS || '127.0.0.1,::1,::ffff:127.0.0.1').split(
    ',',
  );
  if (
    trustedProxyPeers.some((peer) => !require('node:net').isIP(peer)) ||
    trustedProxyPeers.length > 16
  )
    throw Error('List exact trusted proxy peer IP addresses.');
  if (mode === 'hosted' && !trustTlsProxy && !(env.TLS_KEY_FILE && env.TLS_CERT_FILE))
    throw Error('Hosted mode requires TLS or an explicitly trusted TLS ingress.');
  if (Boolean(env.TLS_KEY_FILE) !== Boolean(env.TLS_CERT_FILE))
    throw Error('Both TLS files are required.');
  return {
    projectId,
    serviceId,
    mode,
    host,
    port,
    providers,
    trustTlsProxy,
    trustedProxyPeers,
    dataDir: path.resolve(env.BACKEND_DATA_DIR),
    python: env.PROPHET_PYTHON,
    keys: { openai: openaiKey, vision: visionKey },
    tls: env.TLS_KEY_FILE ? { key: env.TLS_KEY_FILE, cert: env.TLS_CERT_FILE } : null,
  };
}
async function main(env = process.env) {
  const config = configuration(env);
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(config.dataDir, 'quotas.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
  let model = null,
    server = null,
    handler = null,
    closing = null;
  const standalone = require.main === module;
  const failureExit = () => {
    if (standalone) process.exit(1);
    else process.exitCode = 1;
  };
  const close = () =>
    closing ||
    (closing = (async () => {
      const listenerClosed = server
        ? new Promise((resolve) => server.close(resolve))
        : Promise.resolve();
      let failure = null;
      try {
        await handler?.close();
      } catch (error) {
        failure = error;
      }
      try {
        if (model) await model.close();
      } catch (error) {
        failure = error;
      }
      server?.closeAllConnections();
      await listenerClosed;
      db.close();
      if (failure) throw failure;
    })());
  try {
    if (config.providers.forecast) {
      const { startPortableForecast } = require('./prophetProcess.cjs');
      model = await startPortableForecast({
        python: config.python,
        runtimeDirectory: path.join(config.dataDir, 'forecast-' + randomBytes(8).toString('hex')),
        onUnexpectedExit: () => {
          void close().then(failureExit, failureExit);
        },
      });
    }
    const verifier = createFirebaseVerifier({
      projectId: config.projectId,
      mode: config.mode,
      listenHost: config.host,
    });
    handler = createServiceHandler({
      projectId: config.projectId,
      serviceId: config.serviceId,
      providers: config.providers,
      mode: config.mode,
      trustTlsProxy: config.trustTlsProxy,
      trustedProxyPeers: config.trustedProxyPeers,
      verifyToken: verifier,
      quota: createQuotaStore(db),
      providerFactory: (cap) => {
        if (cap === 'assistant')
          return createOpenAIAdapter({
            apiKey: config.keys.openai,
            model: config.providers.assistant.model,
            requestContract: assistantProtocol,
          });
        if (cap === 'ocr')
          return createGoogleVisionWorker({ apiKey: config.keys.vision, inspectImageHeader });
        if (cap === 'forecast' && model) return model.createAdapter();
        throw Error('Provider unavailable.');
      },
    });
    const listener = (req, res) => {
      void handler.handle(req, res).catch(() => {
        res.destroy();
        void close().then(failureExit, failureExit);
      });
    };
    if (config.tls) {
      const key = fs.readFileSync(config.tls.key),
        cert = fs.readFileSync(config.tls.cert);
      if (key.length > 32768 || cert.length > 131072) throw Error('TLS files exceed their bound.');
      server = https.createServer({ key, cert, maxHeaderSize: 24576 }, listener);
    } else server = http.createServer({ maxHeaderSize: 24576 }, listener);
    server.maxHeadersCount = 40;
    server.headersTimeout = 10000;
    server.requestTimeout = 90000;
    server.keepAliveTimeout = 5000;
    server.maxConnections = 64;
    server.on('clientError', (_, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, resolve);
    });
    const stop = () => {
      const ceiling = setTimeout(failureExit, 45000);
      void close().then(
        () => {
          clearTimeout(ceiling);
          if (standalone) process.exit(0);
        },
        () => {
          clearTimeout(ceiling);
          failureExit();
        },
      );
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    console.log(
      'Authenticated financial services are ready. Provider requests require explicit user actions.',
    );
    return { close, server };
  } catch {
    try {
      await close();
    } catch {}
    throw Error('Backend startup or cleanup failed.');
  }
}
module.exports = { configuration, main };
if (require.main === module)
  main().catch(() => {
    console.error(
      'Backend could not start or stop safely. Check private configuration and installed prerequisites.',
    );
    process.exit(1);
  });
