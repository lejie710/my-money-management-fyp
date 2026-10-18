const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { validateConfig, startOwnedCompanion } = require('../child.cjs');
const { pairAndroid, strictConnection, PRIVATE_FILE } = require('../pair-android.cjs');
const { parseCompanionConnection } = require('../../../src/companion/connection');
const {
  providerRequestBinding,
  LOCAL_MODEL_ID,
} = require('../../../src/companion/providerContract');
const APP_ROOT = path.resolve(__dirname, '../../..');
const runtime = path.join(APP_ROOT, '.runtime', 'companion'),
  runId = 'synthetic-owned',
  runDirectory = path.join(runtime, 'runs', runId),
  token = 'x'.repeat(43);
const OPENAI_KEY = 'synthetic-private-openai-key-canary';
const VISION_KEY = 'synthetic-private-vision-key-canary';
const nativeFetch = globalThis.fetch;
let network = 0;
globalThis.fetch = () => {
  network++;
  throw Error('No network is allowed in provider-selection tests.');
};
after(() => {
  globalThis.fetch = nativeFetch;
  assert.equal(network, 0);
});
const OPENAI = { engine: 'openai', processing: 'cloud', model: 'synthetic-model' };
const VISION = { engine: 'google-cloud-vision', processing: 'cloud', maxImageBytes: 6291456 };
const WINDOWS = { engine: 'windows-media-ocr', processing: 'local', maxImageBytes: 10485760 };
const LOCAL = { engine: 'lemonade', processing: 'local', model: LOCAL_MODEL_ID };
const PROPHET = {
  engine: 'prophet',
  processing: 'local',
  version: 'recorded-expense-prophet-v1',
  maxHistoryMonths: 120,
};
function configuration(providers = { ocr: VISION, assistant: OPENAI, forecast: PROPHET }) {
  return {
    version: 2,
    runId,
    runtimeRoot: runtime,
    runDirectory,
    port: 0,
    providers,
    model:
      providers.assistant?.engine === 'lemonade'
        ? { baseUrl: 'http://127.0.0.1:12345/api/v1', key: 'm'.repeat(43) }
        : null,
    forecast: providers.forecast
      ? { baseUrl: 'http://127.0.0.1:23455', key: 'f'.repeat(43) }
      : null,
    credentials: {
      visionKey: providers.ocr?.engine === 'google-cloud-vision' ? VISION_KEY : null,
      openaiKey: providers.assistant?.engine === 'openai' ? OPENAI_KEY : null,
    },
  };
}
function childFixture(config = configuration(), options = {}) {
  const data = new Map(),
    loaded = [],
    calls = {};
  let closes = 0;
  const io = {
    realpath: async (value) => value,
    async writeFile(file, bytes, settings) {
      assert.equal(settings.flag, 'wx');
      if (data.has(file)) throw Object.assign(Error('exists'), { code: 'EEXIST' });
      if (options.writeFailure) throw Error('synthetic write failure');
      data.set(file, bytes);
    },
    async readFile(file) {
      if (!data.has(file)) throw Object.assign(Error('absent'), { code: 'ENOENT' });
      return data.get(file);
    },
    async unlink(file) {
      data.delete(file);
    },
  };
  const load = (name) => {
    loaded.push(name);
    if (name === './ocr/companion.cjs')
      return {
        createReceiptCompanion(settings) {
          calls.service = settings;
          return {
            async listen() {
              if (options.listenFailure) throw Error('synthetic listen failure');
              return { version: 1, url: 'http://127.0.0.1:23456/v1/recognize', token, pid: 4321 };
            },
            async close() {
              closes++;
              if (options.closeFailure) throw Error('synthetic unconfirmed shutdown');
            },
          };
        },
      };
    if (name === './ocr/googleVisionWorker.cjs')
      return {
        createGoogleVisionWorker(settings) {
          calls.vision = settings;
          return (calls.worker = {
            recognize() {
              throw Error('Do not request OCR during setup.');
            },
          });
        },
      };
    if (name === './ocr/windowsWorker.cjs')
      return {
        createWindowsOcrWorker(settings) {
          calls.windows = settings;
          return (calls.worker = {
            recognize() {
              throw Error('Do not request OCR during setup.');
            },
          });
        },
      };
    if (name === './assistant/openaiAdapter.cjs')
      return {
        createOpenAIAdapter(settings) {
          calls.openai = settings;
          return (calls.assistant = {
            complete() {
              throw Error('Do not ask during setup.');
            },
          });
        },
      };
    if (name === './assistant/lemonadeAdapter.cjs')
      return {
        createLemonadeAdapter(settings) {
          calls.lemonade = settings;
          return (calls.assistant = {
            complete() {
              throw Error('Do not ask during setup.');
            },
          });
        },
      };
    if (name === './assistant/routes.cjs')
      return {
        createAssistantRoutes(settings) {
          calls.assistantRoute = settings;
          return [
            {
              method: 'POST',
              path: '/v1/assistant/explain',
              handle() {
                throw Error('No request expected.');
              },
            },
          ];
        },
      };
    if (name === './forecast/prophetAdapter.cjs')
      return {
        createProphetAdapter(settings) {
          calls.prophet = settings;
          return (calls.forecast = {
            forecast() {
              throw Error('Do not fit during setup.');
            },
          });
        },
      };
    if (name === './forecast/routes.cjs')
      return {
        createForecastRoutes(settings) {
          calls.forecastRoute = settings;
          return [
            {
              method: 'POST',
              path: '/v1/forecast',
              handle() {
                throw Error('No request expected.');
              },
            },
          ];
        },
      };
    throw Error('Unexpected companion factory.');
  };
  return {
    config,
    data,
    loaded,
    calls,
    dependencies: { fs: io, load, appRoot: APP_ROOT },
    get closes() {
      return closes;
    },
  };
}

test('v2 cloud selections receive only their own credentials and expose only canonical non-secret pairing metadata', async () => {
  const f = childFixture(),
    before = JSON.stringify(f.config),
    service = await startOwnedCompanion(f.config, f.dependencies);
  assert.equal(f.calls.vision.apiKey, VISION_KEY);
  assert.equal(typeof f.calls.vision.inspectImageHeader, 'function');
  assert.equal(f.calls.openai.apiKey, OPENAI_KEY);
  assert.equal(f.calls.openai.model, OPENAI.model);
  assert.equal(typeof f.calls.openai.requestContract.wireFromPayload, 'function');
  assert.equal(f.calls.assistantRoute.runtime, f.calls.assistant);
  assert.equal(f.calls.assistantRoute.binding, providerRequestBinding(f.config, 'assistant'));
  assert.equal(f.calls.service.binding, providerRequestBinding(f.config, 'ocr'));
  assert.equal(f.calls.service.worker, f.calls.worker);
  assert.equal(f.calls.prophet, f.config.forecast);
  assert.equal(f.calls.forecastRoute.runtime, f.calls.forecast);
  assert.equal(f.calls.forecastRoute.configuration.runId, runId);
  assert.ok(!f.loaded.includes('./assistant/lemonadeAdapter.cjs'));
  assert.ok(!f.loaded.includes('./ocr/windowsWorker.cjs'));
  const raw = f.data.get(path.join(runDirectory, 'connection.json')),
    record = JSON.parse(raw);
  for (const secret of [OPENAI_KEY, VISION_KEY, f.config.forecast.key])
    assert.ok(!raw.includes(secret));
  assert.deepEqual(record.providers, f.config.providers);
  assert.deepEqual(record.modalities, {
    ocr: 'configured',
    assistant: 'configured',
    forecast: 'configured',
  });
  const paired = strictConnection(record, runId),
    mobile = parseCompanionConnection(Buffer.from(paired.deviceBytes));
  assert.equal(paired.hostPort, 23456);
  assert.equal(mobile.url, 'http://127.0.0.1:8787/v1/recognize');
  for (const capability of ['ocr', 'assistant', 'forecast'])
    assert.equal(
      providerRequestBinding(mobile, capability),
      providerRequestBinding(f.config, capability),
    );
  assert.equal(JSON.stringify(f.config), before);
  assert.equal(network, 0);
  await service.close();
  await service.close();
  assert.equal(f.closes, 1);
  assert.equal(f.data.size, 0);
});

test('v2 local defaults load no cloud factory and preserve the pinned local model', async () => {
  const f = childFixture(configuration({ ocr: WINDOWS, assistant: LOCAL, forecast: null })),
    service = await startOwnedCompanion(f.config, f.dependencies);
  assert.equal(f.calls.lemonade.apiKey, f.config.model.key);
  assert.equal(f.calls.assistantRoute.provider.model, LOCAL_MODEL_ID);
  assert.equal(f.calls.windows.workRoot, path.join(runDirectory, 'ocr-jobs'));
  assert.ok(!f.loaded.some((name) => /openai|googleVision|forecast/.test(name)));
  await service.close();
});

test('disabled OCR and assistant capabilities construct no unrelated factory', async () => {
  for (const providers of [
    { ocr: null, assistant: OPENAI, forecast: null },
    { ocr: null, assistant: null, forecast: PROPHET },
    { ocr: VISION, assistant: null, forecast: null },
  ]) {
    const f = childFixture(configuration(providers)),
      service = await startOwnedCompanion(f.config, f.dependencies);
    assert.equal(Boolean(f.calls.assistantRoute), Boolean(providers.assistant));
    assert.equal(Boolean(f.calls.forecastRoute), Boolean(providers.forecast));
    assert.equal(Boolean(f.calls.worker), Boolean(providers.ocr));
    if (!providers.ocr) {
      assert.equal(f.calls.service.worker, null);
      assert.equal(f.calls.service.provider, null);
      assert.equal(f.calls.service.binding, null);
    }
    const record = JSON.parse(f.data.get(path.join(runDirectory, 'connection.json')));
    for (const capability of ['ocr', 'assistant', 'forecast'])
      assert.equal(
        record.modalities[capability],
        providers[capability] ? 'configured' : 'disabled',
      );
    await service.close();
  }
});

test('wrong selected credentials, endpoints and provider parameters fail before any factory is loaded', async () => {
  for (const alter of [
    (c) => ({ ...c, credentials: { ...c.credentials, openaiKey: null } }),
    (c) => ({ ...c, credentials: { ...c.credentials, extra: 'private' } }),
    (c) => ({ ...c, model: { baseUrl: 'http://127.0.0.1:12345/api/v1', key: 'x'.repeat(43) } }),
    (c) => ({ ...c, forecast: { ...c.forecast, baseUrl: 'https://example.invalid' } }),
    (c) => ({ ...c, providers: { ...c.providers, ocr: { ...VISION, maxImageBytes: 10485760 } } }),
    (c) => ({ ...c, providers: { ...c.providers, assistant: { ...OPENAI, apiKey: OPENAI_KEY } } }),
  ]) {
    const f = childFixture(alter(configuration()));
    await assert.rejects(startOwnedCompanion(f.config, f.dependencies));
    assert.equal(f.loaded.length, 0);
    assert.equal(f.data.size, 0);
  }
});

test('v2 startup/write failure drains its service but preserves a prior connection or uncertain shutdown evidence', async () => {
  for (const options of [{ listenFailure: true }, { writeFailure: true }]) {
    const f = childFixture(configuration(), options);
    await assert.rejects(startOwnedCompanion(f.config, f.dependencies));
    assert.equal(f.closes, 1);
    assert.equal(f.data.size, 0);
  }
  const prior = childFixture(),
    file = path.join(runDirectory, 'connection.json');
  prior.data.set(file, 'previous-owner');
  await assert.rejects(startOwnedCompanion(prior.config, prior.dependencies));
  assert.equal(prior.data.get(file), 'previous-owner');
  assert.equal(prior.closes, 1);
  const uncertain = childFixture(configuration(), { closeFailure: true }),
    running = await startOwnedCompanion(uncertain.config, uncertain.dependencies);
  await assert.rejects(running.close());
  assert.equal(uncertain.data.has(file), true);
  const replaced = childFixture(),
    service = await startOwnedCompanion(replaced.config, replaced.dependencies);
  replaced.data.set(file, 'new-owner');
  await service.close();
  assert.equal(replaced.data.get(file), 'new-owner');
});

test('paired descriptor parsing rejects cloud credentials, unknown providers and legacy cloud upgrades', () => {
  const host = {
    version: 2,
    runId,
    url: 'http://127.0.0.1:23456/v1/recognize',
    token,
    providers: configuration().providers,
  };
  assert.throws(() =>
    strictConnection(
      { ...host, providers: { ...host.providers, assistant: { ...OPENAI, apiKey: OPENAI_KEY } } },
      runId,
    ),
  );
  assert.throws(() => strictConnection({ ...host, version: 1 }, runId));
  const mobile = JSON.parse(strictConnection(host, runId).deviceBytes);
  for (const altered of [
    { ...mobile, credentials: { openaiKey: OPENAI_KEY } },
    { ...mobile, providers: { ...mobile.providers, ocr: { ...VISION, engine: 'unknown' } } },
  ])
    assert.throws(() => parseCompanionConnection(Buffer.from(JSON.stringify(altered))));
});

function pairingFixture(options = {}) {
  const data = new Map([
      [
        path.join(runDirectory, 'connection.json'),
        JSON.stringify({
          version: 1,
          runId,
          pid: 4321,
          url: 'http://127.0.0.1:23456/v1/recognize',
          token,
        }),
      ],
    ]),
    calls = [];
  let mapping = options.mapping ?? null,
    privateBytes = options.privateBytes ?? null,
    temporaryBytes = null;
  const args = {
    action: 'pair',
    '--adb': 'owned-adb.exe',
    '--python': 'owned-python.exe',
    '--serial': 'emulator-5556',
    '--run-name': runId,
    '--runtime-root': runtime,
  };
  const fs = {
    readFileSync: (file) => {
      if (!data.has(file)) throw Error('missing');
      return data.get(file);
    },
    existsSync: (file) => data.has(file),
    writeFileSync(file, bytes, settings) {
      if (settings?.flag === 'wx' && data.has(file)) throw Error('exists');
      data.set(file, bytes);
    },
    unlinkSync: (file) => data.delete(file),
  };
  const run = (binary, command, settings) => {
    calls.push({ binary, command, input: settings.input });
    assert.equal(settings.windowsHide, true);
    assert.ok(!command.join(' ').includes(token));
    const result = (stdout) => ({ status: 0, stdout });
    if (binary === 'owned-python.exe') {
      if (options.stoppedRun && command[1] === 'verify') return { status: 1, stdout: '' };
      if (command[1] === 'verify-stopped' && options.uncertainStop)
        return { status: 1, stdout: '' };
      return result(
        JSON.stringify({
          valid: !options.invalidOwner,
          stopped: command[1] === 'verify-stopped',
          runId,
          companionPid: 4321,
        }),
      );
    }
    const tail = command.slice(2),
      line = tail.join(' ');
    if (line === 'get-state') return result('device\n');
    if (line === 'shell getprop ro.kernel.qemu') return result('1\n');
    if (line.startsWith('shell pm path')) return result('package:/data/app/synthetic/base.apk\n');
    if (line.startsWith('shell dumpsys package'))
      return result(
        'Packages:\n  Package [com.lejie710.mymoneymanagement] (synthetic):\n    flags=[ HAS_CODE DEBUGGABLE ]\n',
      );
    if (line === 'reverse --list')
      return result(mapping === null ? '' : `emulator-5556 tcp:8787 tcp:${mapping}\n`);
    if (tail[0] === 'reverse' && tail[1] === '--no-rebind') {
      if (mapping !== null) return { status: 1 };
      mapping = 23456;
      return result('');
    }
    if (tail[0] === 'reverse' && tail[1] === '--remove') {
      mapping = null;
      return result('');
    }
    if (line.includes('if [ -f'))
      return result(
        (line.includes('.pending.json') ? temporaryBytes : privateBytes) ??
          '__FYP_COMPANION_ABSENT__',
      );
    if (line.includes('umask 077')) {
      if (options.failDelivery) return { status: 1, stdout: '' };
      temporaryBytes = options.partialDelivery ? settings.input.slice(0, 17) : settings.input;
      return {
        status: options.partialDelivery ? 1 : 0,
        stdout: options.unconfirmedCreation ? '' : '__FYP_COMPANION_TEMP_CREATED__',
      };
    }
    if (tail.includes('mv')) {
      assert.equal(privateBytes, null);
      privateBytes = temporaryBytes;
      temporaryBytes = null;
      return result('');
    }
    if (tail.includes('rm') && tail.at(-1) === PRIVATE_FILE) {
      privateBytes = null;
      return result('');
    }
    if (tail.includes('rm') && tail.at(-1).endsWith('.pending.json')) {
      temporaryBytes = null;
      return result('');
    }
    throw Error('Unexpected ADB command');
  };
  return {
    args,
    data,
    calls,
    dependencies: { fs, run, appRoot: APP_ROOT },
    get mapping() {
      return mapping;
    },
    get privateBytes() {
      return privateBytes;
    },
    get temporaryBytes() {
      return temporaryBytes;
    },
  };
}

test('actual v2 pairing state machine delivers only public descriptors through stdin and clears its exact owned record', () => {
  const f = pairingFixture();
  const host = {
    version: 2,
    runId,
    pid: 4321,
    url: 'http://127.0.0.1:23456/v1/recognize',
    token,
    providers: configuration().providers,
  };
  f.data.set(path.join(runDirectory, 'connection.json'), JSON.stringify(host));
  assert.equal(pairAndroid(f.args, f.dependencies).status, 'paired');
  const mobile = parseCompanionConnection(Buffer.from(f.privateBytes));
  assert.deepEqual(mobile.providers, host.providers);
  for (const capability of ['ocr', 'assistant', 'forecast'])
    assert.equal(
      providerRequestBinding(mobile, capability),
      providerRequestBinding(configuration(), capability),
    );
  for (const call of f.calls) {
    assert.ok(!call.command.join(' ').includes(token));
    assert.ok(!JSON.stringify(call).includes(OPENAI_KEY));
    assert.ok(!JSON.stringify(call).includes(VISION_KEY));
  }
  assert.equal(pairAndroid(f.args, f.dependencies).status, 'already-paired');
  assert.equal(pairAndroid({ ...f.args, action: 'clear' }, f.dependencies).status, 'cleared');
  assert.equal(f.privateBytes, null);
  assert.equal(f.mapping, null);
});

test('changed v2 provider metadata cannot silently reuse or clear an older paired configuration', () => {
  const f = pairingFixture(),
    file = path.join(runDirectory, 'connection.json');
  const host = {
    version: 2,
    runId,
    pid: 4321,
    url: 'http://127.0.0.1:23456/v1/recognize',
    token,
    providers: configuration().providers,
  };
  f.data.set(file, JSON.stringify(host));
  pairAndroid(f.args, f.dependencies);
  const saved = f.privateBytes,
    before = f.calls.length;
  f.data.set(
    file,
    JSON.stringify({
      ...host,
      providers: { ...host.providers, assistant: { ...OPENAI, model: 'other-model' } },
    }),
  );
  assert.throws(() => pairAndroid(f.args, f.dependencies));
  assert.throws(() => pairAndroid({ ...f.args, action: 'clear' }, f.dependencies));
  assert.equal(f.privateBytes, saved);
  assert.equal(f.mapping, 23456);
  assert.ok(
    !f.calls
      .slice(before)
      .some(
        (call) => call.command.includes('--remove') || call.command.includes('rm') || call.input,
      ),
  );
});
