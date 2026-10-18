// Public companion child. Importing this module starts no server or provider.
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const APP_ROOT = path.resolve(__dirname, '../..');
function validateConfig(value, appRoot = APP_ROOT) {
  if (
    !value ||
    value.version !== 1 ||
    !['ocr', 'assistant'].includes(value.mode) ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.runId) ||
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
  if (
    value.mode === 'assistant' &&
    (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/api\/v1$/.test(value.model?.baseUrl) ||
      typeof value.model?.key !== 'string' ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(value.model.key))
  )
    throw Error('Invalid private model configuration.');
  if (value.mode === 'ocr' && value.model !== null)
    throw Error('OCR-only mode does not accept model configuration.');
  return { ...value, runtimeRoot: runtime, runDirectory: directory };
}
async function startOwnedCompanion(value, dependencies = {}) {
  const config = validateConfig(value, dependencies.appRoot || APP_ROOT),
    file = path.join(config.runDirectory, 'connection.json');
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
  const { createWindowsOcrWorker } = load('./ocr/windowsWorker.cjs');
  let routes = [];
  if (config.mode === 'assistant') {
    const { createAssistantRoutes } = load('./assistant/routes.cjs');
    const { createLemonadeAdapter } = load('./assistant/lemonadeAdapter.cjs');
    routes = createAssistantRoutes({
      runtime: createLemonadeAdapter({ baseUrl: config.model.baseUrl, apiKey: config.model.key }),
    });
  }
  const service = createReceiptCompanion({
    worker: createWindowsOcrWorker({ workRoot: path.join(config.runDirectory, 'ocr-jobs') }),
    routes,
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
    record = JSON.stringify({
      ...endpoint,
      runId: config.runId,
      modalities: {
        ocr: 'configured',
        assistant: config.mode === 'assistant' ? 'configured' : 'disabled',
      },
    });
    await io.writeFile(file, record, { flag: 'wx', mode: 0o600 });
    return { close, port: Number(new URL(endpoint.url).port), pid: endpoint.pid };
  } catch (error) {
    // Never unlink an existing file merely because exclusive creation failed.
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
      'Local companion failed. Owned runtime metadata was retained; no credentials or request content were logged.',
    );
    process.exitCode = 1;
  });
module.exports = { validateConfig, startOwnedCompanion };
