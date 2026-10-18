const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const { validateConfig, startOwnedCompanion } = require('../child.cjs');
const {
  pairAndroid,
  strictConnection,
  reversePort,
  parseArguments,
  PRIVATE_FILE,
} = require('../pair-android.cjs');
const APP_ROOT = path.resolve(__dirname, '../../..'),
  runtime = path.join(APP_ROOT, '.runtime', 'companion'),
  runId = 'synthetic-owned',
  runDirectory = path.join(runtime, 'runs', runId),
  token = 'x'.repeat(43);
function childFixture({ mode = 'ocr', closeError = false } = {}) {
  const data = new Map(),
    loaded = [],
    calls = [];
  const config = {
    version: 1,
    mode,
    runId,
    runtimeRoot: runtime,
    runDirectory,
    port: 0,
    model:
      mode === 'ocr' ? null : { baseUrl: 'http://127.0.0.1:12345/api/v1', key: 'y'.repeat(43) },
  };
  const fs = {
    async realpath(value) {
      return value;
    },
    async writeFile(file, bytes, options) {
      assert.equal(options.flag, 'wx');
      if (data.has(file)) throw Object.assign(Error('exists'), { code: 'EEXIST' });
      data.set(file, bytes);
    },
    async readFile(file) {
      if (!data.has(file)) throw Object.assign(Error('missing'), { code: 'ENOENT' });
      return data.get(file);
    },
    async unlink(file) {
      data.delete(file);
    },
  };
  const load = (name) => {
    loaded.push(name);
    if (name === './ocr/windowsWorker.cjs')
      return {
        createWindowsOcrWorker(options) {
          assert.equal(options.workRoot, path.join(runDirectory, 'ocr-jobs'));
          return {};
        },
      };
    if (name === './ocr/companion.cjs')
      return {
        createReceiptCompanion(options) {
          calls.push(options);
          return {
            async listen() {
              return { version: 1, url: 'http://127.0.0.1:23456/v1/recognize', token, pid: 4321 };
            },
            async close() {
              calls.push('closed');
              if (closeError) throw Error('unconfirmed');
            },
          };
        },
      };
    if (name === './assistant/lemonadeAdapter.cjs') return { createLemonadeAdapter: () => ({}) };
    if (name === './assistant/routes.cjs')
      return { createAssistantRoutes: () => ['assistant-route'] };
    throw Error('Unexpected public dependency');
  };
  return { config, data, loaded, calls, dependencies: { fs, load, appRoot: APP_ROOT } };
}
test('OCR-only child starts through injected public OCR modules without importing a model, and removes only its own connection', async () => {
  const f = childFixture(),
    service = await startOwnedCompanion(f.config, f.dependencies);
  assert.deepEqual(f.loaded, ['./ocr/companion.cjs', './ocr/windowsWorker.cjs']);
  assert.deepEqual(f.calls[0].routes, []);
  const file = path.join(runDirectory, 'connection.json'),
    record = JSON.parse(f.data.get(file));
  assert.equal(record.modalities.assistant, 'disabled');
  assert.equal(record.token, token);
  await service.close();
  assert.equal(f.data.has(file), false);
});
test('assistant uses the same receipt service/token and never persists its private model key', async () => {
  const f = childFixture({ mode: 'assistant' }),
    service = await startOwnedCompanion(f.config, f.dependencies),
    record = f.data.get(path.join(runDirectory, 'connection.json'));
  assert.ok(f.loaded.includes('./assistant/routes.cjs'));
  assert.deepEqual(f.calls[0].routes, ['assistant-route']);
  assert.ok(!record.includes(f.config.model.key));
  await service.close();
});
test('failed child shutdown retains its connection and invalid runtime paths cannot start a service', async () => {
  const f = childFixture({ closeError: true }),
    service = await startOwnedCompanion(f.config, f.dependencies);
  await assert.rejects(service.close());
  assert.equal(f.data.has(path.join(runDirectory, 'connection.json')), true);
  assert.throws(() =>
    validateConfig({ ...f.config, runtimeRoot: path.resolve(APP_ROOT, 'source') }, APP_ROOT),
  );
  assert.throws(() => validateConfig({ ...f.config, runId: '../outside' }, APP_ROOT));
  assert.throws(() => validateConfig({ ...f.config, model: { key: 'unexpected' } }, APP_ROOT));
});
test('existing connection file is never removed after exclusive creation refuses to replace it', async () => {
  const f = childFixture(),
    file = path.join(runDirectory, 'connection.json');
  f.data.set(file, 'prior-owner');
  await assert.rejects(startOwnedCompanion(f.config, f.dependencies));
  assert.equal(f.data.get(file), 'prior-owner');
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
test('pairing verifies live ownership/debug app and sends one private loopback config only through stdin', () => {
  const f = pairingFixture();
  assert.equal(pairAndroid(f.args, f.dependencies).status, 'paired');
  assert.equal(f.mapping, 23456);
  const config = JSON.parse(f.privateBytes);
  assert.equal(config.url, 'http://127.0.0.1:8787/v1/recognize');
  assert.equal(config.token, token);
  assert.equal(pairAndroid(f.args, f.dependencies).status, 'already-paired');
  assert.equal(pairAndroid({ ...f.args, action: 'clear' }, f.dependencies).status, 'cleared');
  assert.equal(f.mapping, null);
  assert.equal(f.privateBytes, null);
  assert.equal(f.data.has(path.join(runDirectory, 'pairing.json')), false);
});
test('pairing refuses unrelated mappings, existing private connection and stale owner before any mutation', () => {
  for (const options of [
    { mapping: 23456 },
    { privateBytes: 'another-run' },
    { invalidOwner: true },
  ]) {
    const f = pairingFixture(options);
    assert.throws(() => pairAndroid(f.args, f.dependencies));
    assert.ok(!f.calls.some((call) => call.command.includes('--no-rebind') || call.input));
  }
});
test('failed private delivery keeps confirmed mapping intent for a deliberate clear, without a token in that intent', () => {
  const f = pairingFixture({ failDelivery: true });
  assert.throws(() => pairAndroid(f.args, f.dependencies));
  const record = f.data.get(path.join(runDirectory, 'pairing.json'));
  assert.ok(record);
  assert.ok(!record.includes(token));
  assert.equal(JSON.parse(record).mappingOwned, true);
  assert.equal(pairAndroid({ ...f.args, action: 'clear' }, f.dependencies).status, 'cleared');
});

test('partial stdin delivery stays out of the final config and its proven-owned temporary file can be cleared', () => {
  const f = pairingFixture({ partialDelivery: true });
  assert.throws(() => pairAndroid(f.args, f.dependencies));
  assert.equal(f.privateBytes, null);
  assert.ok(f.temporaryBytes);
  assert.equal(
    JSON.parse(f.data.get(path.join(runDirectory, 'pairing.json'))).temporaryOwned,
    true,
  );
  assert.equal(pairAndroid({ ...f.args, action: 'clear' }, f.dependencies).status, 'cleared');
  assert.equal(f.temporaryBytes, null);
  assert.equal(f.mapping, null);
});

test('missing temporary creation proof retains the file rather than guessing ownership during clear', () => {
  const f = pairingFixture({ unconfirmedCreation: true });
  assert.throws(() => pairAndroid(f.args, f.dependencies));
  assert.equal(f.privateBytes, null);
  assert.throws(() => pairAndroid({ ...f.args, action: 'clear' }, f.dependencies));
  assert.ok(f.temporaryBytes);
  assert.equal(f.mapping, 23456);
});

test('malformed pairing ownership flags and unknown phases cannot authorize device cleanup', () => {
  for (const patch of [
    { mappingOwned: 'false' },
    { temporaryOwned: 'true' },
    { phase: 'unknown' },
    { extra: true },
  ]) {
    const f = pairingFixture();
    pairAndroid(f.args, f.dependencies);
    const file = path.join(runDirectory, 'pairing.json');
    f.data.set(file, JSON.stringify({ ...JSON.parse(f.data.get(file)), ...patch }));
    const before = f.calls.length;
    assert.throws(() => pairAndroid({ ...f.args, action: 'clear' }, f.dependencies));
    assert.equal(f.privateBytes !== null, true);
    assert.equal(f.mapping, 23456);
    assert.ok(
      !f.calls
        .slice(before)
        .some((call) => call.command.includes('rm') || call.command.includes('--remove')),
    );
  }
});
test('connection and reverse parsers reject remote destinations and isolate the local8787 mapping', () => {
  assert.throws(() =>
    strictConnection({ version: 1, runId, url: 'https://example.test', token }, runId),
  );
  assert.equal(reversePort('emulator-5556 tcp:8081 tcp:8787\n'), null);
  assert.equal(reversePort('emulator-5556 tcp:8787 tcp:12345\n'), 12345);
  assert.throws(() => reversePort('x tcp:8787 tcp:1\ny tcp:8787 tcp:2'));
  assert.throws(() =>
    parseArguments([
      'pair',
      '--adb',
      'adb',
      '--python',
      'python',
      '--serial',
      'physical-device',
      '--run-name',
      'run',
    ]),
  );
});

test('confirmed owned stop permits exact stale pairing clear without live connection or process killing', () => {
  const options = {},
    f = pairingFixture(options);
  pairAndroid(f.args, f.dependencies);
  assert.ok(f.data.has(path.join(runDirectory, 'pairing-connection.json')));
  options.stoppedRun = true;
  f.data.delete(path.join(runDirectory, 'connection.json'));
  const before = f.calls.length;
  assert.equal(pairAndroid({ ...f.args, action: 'clear' }, f.dependencies).status, 'cleared');
  assert.equal(f.mapping, null);
  assert.equal(f.privateBytes, null);
  assert.equal(f.data.has(path.join(runDirectory, 'pairing-connection.json')), false);
  assert.ok(f.calls.slice(before).some((call) => call.command[1] === 'verify-stopped'));
  assert.ok(!f.calls.some((call) => call.command.includes('stop')));
});

test('uncertain stop or altered private pairing proof cannot authorize a post-stop mutation', () => {
  for (const corrupt of [false, true]) {
    const options = {},
      f = pairingFixture(options);
    pairAndroid(f.args, f.dependencies);
    options.stoppedRun = true;
    options.uncertainStop = !corrupt;
    f.data.delete(path.join(runDirectory, 'connection.json'));
    if (corrupt) {
      const file = path.join(runDirectory, 'pairing-connection.json');
      f.data.set(file, JSON.stringify({ ...JSON.parse(f.data.get(file)), token: 'y'.repeat(43) }));
    }
    const before = f.calls.length;
    assert.throws(() => pairAndroid({ ...f.args, action: 'clear' }, f.dependencies));
    assert.equal(f.mapping, 23456);
    assert.ok(f.privateBytes);
    assert.ok(
      !f.calls
        .slice(before)
        .some((call) => call.command.includes('rm') || call.command.includes('--remove')),
    );
  }
});

test('new pairing never falls back to post-stop ownership', () => {
  const f = pairingFixture({ stoppedRun: true });
  assert.throws(() => pairAndroid(f.args, f.dependencies));
  assert.ok(!f.calls.some((call) => call.command[1] === 'verify-stopped'));
  assert.equal(f.mapping, null);
});
