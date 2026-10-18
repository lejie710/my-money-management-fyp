// Owned companion. Importing this module starts no server or provider.
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const {
  validateProviders,
  providerRequestBinding,
} = require('../../src/companion/providerContract');
const APP_ROOT = path.resolve(__dirname, '../..');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const key = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{8,512}$/.test(value);
function localEndpoint(value, suffix) {
  if (
    !exact(value, ['baseUrl', 'key']) ||
    typeof value.baseUrl !== 'string' ||
    typeof value.key !== 'string' ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(value.key)
  )
    return false;
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(.*)$/.exec(value.baseUrl);
  return Boolean(match && Number(match[1]) <= 65535 && match[2] === suffix);
}
function validateConfig(value, appRoot = APP_ROOT) {
  if (
    !object(value) ||
    ![1, 2].includes(value.version) ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.runId || '') ||
    !Number.isInteger(value.port) ||
    value.port < 0 ||
    value.port > 65535
  )
    throw Error('Invalid run configuration.');
  const runtime = path.resolve(value.runtimeRoot || ''),
    directory = path.resolve(value.runDirectory || '');
  const allowed = path.resolve(appRoot, '.runtime');
  if (
    !runtime.startsWith(allowed + path.sep) ||
    directory !== path.join(runtime, 'runs', value.runId)
  )
    throw Error('Run paths must stay inside the ignored runtime directory.');
  if (value.version === 1) {
    if (
      !['ocr', 'assistant'].includes(value.mode) ||
      (value.mode === 'assistant' && !localEndpoint(value.model, '/api/v1')) ||
      (value.mode === 'ocr' && value.model !== null)
    )
      throw Error('Invalid legacy provider configuration.');
    return { ...value, runtimeRoot: runtime, runDirectory: directory };
  }
  if (
    !exact(value, [
      'version',
      'runId',
      'runtimeRoot',
      'runDirectory',
      'port',
      'providers',
      'model',
      'forecast',
      'credentials',
    ])
  )
    throw Error('Invalid provider configuration shape.');
  const providers = validateProviders(value.providers);
  if (!exact(value.credentials, ['visionKey', 'openaiKey']))
    throw Error('Invalid private credentials.');
  const lemonade = providers.assistant?.engine === 'lemonade';
  const openai = providers.assistant?.engine === 'openai';
  const vision = providers.ocr?.engine === 'google-cloud-vision';
  if (
    (lemonade ? !localEndpoint(value.model, '/api/v1') : value.model !== null) ||
    (providers.forecast ? !localEndpoint(value.forecast, '') : value.forecast !== null) ||
    (openai ? !key(value.credentials.openaiKey) : value.credentials.openaiKey !== null) ||
    (vision ? !key(value.credentials.visionKey) : value.credentials.visionKey !== null)
  )
    throw Error('The selected private provider configuration is incomplete.');
  return {
    ...value,
    providers,
    credentials: { ...value.credentials },
    runtimeRoot: runtime,
    runDirectory: directory,
  };
}
async function startOwnedCompanion(value, dependencies = {}) {
  const config = validateConfig(value, dependencies.appRoot || APP_ROOT);
  const file = path.join(config.runDirectory, 'connection.json');
  const io = dependencies.fs || fs;
  const realRuntime = await io.realpath(config.runtimeRoot),
    realDirectory = await io.realpath(config.runDirectory);
  if (
    !realDirectory.startsWith(realRuntime + path.sep) ||
    realDirectory !== path.join(realRuntime, 'runs', config.runId)
  )
    throw Error('Run path ownership could not be verified.');
  const load = dependencies.load || require;
  const { createReceiptCompanion } = load('./ocr/companion.cjs');
  let worker = null,
    routes = [];
  if (config.version === 1 || config.providers.ocr?.engine === 'windows-media-ocr') {
    const { createWindowsOcrWorker } = load('./ocr/windowsWorker.cjs');
    worker = createWindowsOcrWorker({ workRoot: path.join(config.runDirectory, 'ocr-jobs') });
  } else if (config.providers.ocr?.engine === 'google-cloud-vision') {
    const { createGoogleVisionWorker } = load('./ocr/googleVisionWorker.cjs');
    worker = createGoogleVisionWorker({
      apiKey: config.credentials.visionKey,
      inspectImageHeader: require('../../src/attachments/imageHeader').inspectImageHeader,
    });
  }
  const assistantProvider = config.version === 1 ? null : config.providers.assistant;
  if ((config.version === 1 && config.mode === 'assistant') || assistantProvider) {
    const { createAssistantRoutes } = load('./assistant/routes.cjs');
    let runtime;
    if (assistantProvider?.engine === 'openai') {
      const { createOpenAIAdapter } = load('./assistant/openaiAdapter.cjs');
      runtime = createOpenAIAdapter({
        apiKey: config.credentials.openaiKey,
        model: assistantProvider.model,
        requestContract: require('../../src/assistant/protocol'),
      });
    } else {
      const { createLemonadeAdapter } = load('./assistant/lemonadeAdapter.cjs');
      runtime = createLemonadeAdapter({ baseUrl: config.model.baseUrl, apiKey: config.model.key });
    }
    routes.push(
      ...createAssistantRoutes({
        runtime,
        ...(config.version === 2
          ? { provider: assistantProvider, binding: providerRequestBinding(config, 'assistant') }
          : {}),
      }),
    );
  }
  if (config.version === 2 && config.providers.forecast) {
    const { createProphetAdapter } = load('./forecast/prophetAdapter.cjs');
    const { createForecastRoutes } = load('./forecast/routes.cjs');
    routes.push(
      ...createForecastRoutes({
        runtime: createProphetAdapter(config.forecast),
        configuration: config,
      }),
    );
  }
  const service = createReceiptCompanion({
    worker,
    routes,
    ...(config.version === 2
      ? {
          provider: config.providers.ocr,
          binding: config.providers.ocr ? providerRequestBinding(config, 'ocr') : null,
        }
      : {}),
  });
  let record = null,
    stopping = null;
  const close = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      await service.close();
      if (record !== null) {
        try {
          if ((await io.readFile(file, 'utf8')) === record) await io.unlink(file);
        } catch (error) {
          if (error?.code !== 'ENOENT')
            throw Error('Owned connection cleanup could not be confirmed.');
        }
      }
    })();
    return stopping;
  };
  try {
    const endpoint = await service.listen(config.port);
    record = JSON.stringify(
      config.version === 1
        ? {
            ...endpoint,
            runId: config.runId,
            modalities: {
              ocr: 'configured',
              assistant: config.mode === 'assistant' ? 'configured' : 'disabled',
            },
          }
        : {
            ...endpoint,
            version: 2,
            runId: config.runId,
            providers: config.providers,
            modalities: {
              ocr: config.providers.ocr ? 'configured' : 'disabled',
              assistant: config.providers.assistant ? 'configured' : 'disabled',
              forecast: config.providers.forecast ? 'configured' : 'disabled',
            },
          },
    );
    await io.writeFile(file, record, { flag: 'wx', mode: 0o600 });
    return { close, port: Number(new URL(endpoint.url).port), pid: endpoint.pid };
  } catch (error) {
    record = null;
    await close();
    throw error;
  }
}
async function main() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator](),
    first = await lines.next();
  if (first.done || Buffer.byteLength(first.value, 'utf8') > 4096)
    throw Error('Missing bounded runtime configuration.');
  const service = await startOwnedCompanion(JSON.parse(first.value));
  console.info(JSON.stringify({ stage: 'companion-ready', pid: service.pid, port: service.port }));
  try {
    for await (const line of lines) {
      if (line === 'stop') break;
    }
  } finally {
    await service.close();
    input.close();
  }
}
if (require.main === module)
  main().catch(() => {
    console.error(
      'Companion failed. Owned metadata was retained; no credentials or request content were logged.',
    );
    process.exitCode = 1;
  });
module.exports = { validateConfig, startOwnedCompanion };
