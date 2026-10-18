const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const {
  launchProjectApp,
  PROJECT_PACKAGE,
  PROJECT_ACTIVITY,
  METRO_START_TIMEOUT_MS,
  verifyDebuggablePackage,
} = require('../scripts/project-app-launch.cjs');
const project = path.resolve(__dirname, '..');
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const refused = () => Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
const response = (text = 'packager-status:running') => ({
  ok: true,
  text: async () => text,
});
const manifest = (changes = {}) => ({
  extra: {
    expoClient: {
      slug: 'my-money-management',
      android: { package: PROJECT_PACKAGE },
    },
    expoGo: { developer: { projectRoot: project } },
  },
  ...changes,
});

function fixture(options = {}) {
  let time = 0,
    statusCalls = 0,
    manifestCalls = 0;
  const calls = [],
    deviceCalls = [],
    spawns = [],
    requests = [],
    messages = [],
    kills = [],
    listeners = {};
  const child = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    on(event, callback) {
      listeners[event] = callback;
      return child;
    },
    kill() {
      kills.push('owned-metro');
      return true;
    },
  };
  const parentStdout = new PassThrough();
  const parentStderr = new PassThrough();
  const stdoutChunks = [],
    stderrChunks = [];
  parentStdout.on('data', (chunk) => stdoutChunks.push(chunk.toString()));
  parentStderr.on('data', (chunk) => stderrChunks.push(chunk.toString()));
  const context = {
    adbRun(args, settings) {
      if (args.includes('run-as') || args.includes('getprop') || args[0] === 'exec-out') {
        deviceCalls.push({ args: [...args], settings });
        if (options.device) return options.device(args, settings, deviceCalls.length);
        if (args.includes('run-as')) return ok('<map/>');
        if (args.includes('getprop'))
          return ok(args.at(-1) === 'metro.host' ? '' : 'google/sdk_gphone64_x86_64');
        return ok('HTTP/1.0 200 OK\r\nContent-Length: 23\r\n\r\npackager-status:running');
      }
      calls.push([...args]);
      return args.includes('pm')
        ? (options.packageResult ?? ok('package:/data/app/project/base.apk\n'))
        : args.includes('dumpsys')
          ? (options.debugResult ??
            ok(
              `Packages:\n  Package [${PROJECT_PACKAGE}] (abcd):\n    flags=[ DEBUGGABLE HAS_CODE ALLOW_CLEAR_USER_DATA ]\n`,
            ))
          : args.includes('reverse')
            ? (options.reverseResult ?? ok())
            : (options.openResult ?? ok('Starting: Intent\nStatus: ok\n'));
    },
    spawn(command, args, settings) {
      spawns.push({ command, args: [...args], settings });
      return child;
    },
    async fetch(url, settings) {
      requests.push({ url, settings });
      if (url.endsWith('/status')) {
        statusCalls++;
        if (options.status) return options.status(statusCalls);
        return response();
      }
      if (options.readManifest)
        return options.readManifest(++manifestCalls, {
          settings,
          listeners,
          advance(milliseconds) {
            time += milliseconds;
          },
        });
      return { ok: true, json: async () => options.manifest ?? manifest() };
    },
    signalTimeout: (milliseconds) => ({ timeout: milliseconds }),
    project,
    cli: 'synthetic-expo-cli',
    node: 'synthetic-node',
    sdk: 'synthetic-sdk',
    serial: 'emulator-5580',
    env: { SYNTHETIC: 'preserved', ...options.env },
    now: () => time,
    async pause(ms) {
      time += ms;
      options.pause?.({ listeners, time });
    },
    log: (message) => messages.push(message),
    stdout: parentStdout,
    stderr: parentStderr,
    onMetroError() {},
    onMetroExit() {},
  };
  return {
    context,
    calls,
    deviceCalls,
    spawns,
    requests,
    messages,
    kills,
    listeners,
    child,
    parentStdout,
    parentStderr,
    stdoutChunks,
    stderrChunks,
    time: () => time,
  };
}

test('verified existing server launches installed MainActivity without starting or stopping any process', async () => {
  const f = fixture();
  const result = await launchProjectApp(f.context);
  assert.deepEqual(result, { startedMetro: false });
  assert.equal(f.spawns.length, 0);
  assert.equal(f.kills.length, 0);
  assert.deepEqual(f.calls[0], ['shell', 'pm', 'path', PROJECT_PACKAGE]);
  assert.deepEqual(f.calls[1], ['shell', 'dumpsys', 'package', PROJECT_PACKAGE]);
  assert.deepEqual(f.calls[2], ['reverse', 'tcp:8081', 'tcp:8081']);
  assert.deepEqual(f.calls[3], [
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.MAIN',
    '-c',
    'android.intent.category.LAUNCHER',
    '-n',
    PROJECT_ACTIVITY,
  ]);
});

test('missing or unconfirmed package stops before network and cannot fall back, install or reset', async () => {
  for (const packageResult of [
    ok(''),
    { status: 1, stderr: 'not available' },
    { status: null, error: Error('timeout') },
  ]) {
    const f = fixture({ packageResult });
    await assert.rejects(() => launchProjectApp(f.context), /not installed|Could not verify/);
    assert.equal(f.requests.length, 0);
    assert.equal(f.spawns.length, 0);
    assert.equal(f.calls.length, 1);
    assert.equal(f.kills.length, 0);
  }
});

test('only direct public flags from the exact installed package can establish a debug build', () => {
  for (const output of [
    `Packages:\n  Package [${PROJECT_PACKAGE}] (abcd):\n    flags=[ DEBUGGABLE HAS_CODE ALLOW_BACKUP ]\n    privateFlags=[ PRIVATE_FLAG_ALLOW_NATIVE_HEAP_POINTER_TAGGING ]\n    pkgFlags=[ ALLOW_BACKUP HAS_CODE DEBUGGABLE ]\n    User 0: installed=true\n`,
    `Packages:\n  Package [${PROJECT_PACKAGE}] (abcd):\n    flags=[ DEBUGGABLE HAS_CODE ALLOW_CLEAR_USER_DATA ]\n    privateFlags=[ PRIVATE_FLAG_ACTIVITIES_RESIZE_MODE_RESIZEABLE ]\n`,
    `Packages:\r\n  Package [${PROJECT_PACKAGE}] (abcd):\r\n    pkgFlags=[ HAS_CODE\r\n      DEBUGGABLE ALLOW_CLEAR_USER_DATA ]\r\n    User 0:\r\n      flags=[ NONE ]\r\n`,
    `Packages:\n  Package [other.package] (aaaa):\n    flags=[ HAS_CODE ]\n  Package [${PROJECT_PACKAGE}] (bbbb):\n    flags=[ HAS_CODE DEBUGGABLE ]\n  Package [third.package] (cccc):\n    flags=[ HAS_CODE ]\n`,
  ])
    assert.doesNotThrow(() => verifyDebuggablePackage(ok(output)));
});

test('release, absent, misleading, ambiguous or failed debug metadata stops before network and forwarding', async () => {
  const header = `Packages:\n  Package [${PROJECT_PACKAGE}] (abcd):\n`;
  for (const debugResult of [
    ok(`${header}    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ALLOW_BACKUP ]\n`),
    ok(''),
    ok('Packages:\n  Package [other.package] (abcd):\n    flags=[ DEBUGGABLE ]\n'),
    ok(`${header}    privateFlags=[ DEBUGGABLE ]\n`),
    ok(`${header}    flags=[ HAS_CODE\n    privateFlags=[ DEBUGGABLE ]\n`),
    ok(`${header}    userId=10123\nShared users:\n    flags=[ DEBUGGABLE ]\n`),
    ok(`${header}    flags=[ NOT_DEBUGGABLE DEBUGGABLE_EXTRA ]\n`),
    ok(`${header}    flags=[ HAS_CODE ]\n    User 0:\n      flags=[ DEBUGGABLE ]\n`),
    ok(`${header}    User 0:\n      flags=[ DEBUGGABLE ]\n`),
    ok(`${header}    flags=[ DEBUGGABLE ]\n    pkgFlags=[ HAS_CODE ]\n`),
    ok(`${header}    flags=[ DEBUGGABLE ]\n    flags=[ DEBUGGABLE ]\n`),
    ok(`${header}    flags=[ DEBUGGABLE ]\n${header}    flags=[ DEBUGGABLE ]\n`),
    {
      status: 1,
      stdout: `${header}    flags=[ DEBUGGABLE ]\n`,
      stderr: 'error',
    },
    { status: null, error: Error('timeout') },
  ]) {
    const f = fixture({ debugResult });
    await assert.rejects(() => launchProjectApp(f.context), /debuggable|debug APK/i);
    assert.deepEqual(f.calls, [
      ['shell', 'pm', 'path', PROJECT_PACKAGE],
      ['shell', 'dumpsys', 'package', PROJECT_PACKAGE],
    ]);
    assert.equal(f.requests.length, 0);
    assert.equal(f.spawns.length, 0);
    assert.equal(f.kills.length, 0);
  }
});

test('new server uses localhost fixed port without any client-opening flag and waits before activity launch', async () => {
  const f = fixture({
    status: (count) => {
      if (count <= 3) throw refused();
      return response();
    },
  });
  assert.deepEqual(await launchProjectApp(f.context), { startedMetro: true });
  assert.equal(f.spawns.length, 1);
  assert.deepEqual(f.spawns[0].args, [
    'synthetic-expo-cli',
    'start',
    '--localhost',
    '--port',
    '8081',
    '--max-workers',
    '2',
  ]);
  assert.equal(f.spawns[0].settings.windowsHide, true);
  assert.equal(f.spawns[0].settings.cwd, project);
  assert.equal(Object.hasOwn(f.spawns[0].settings.env, 'CI'), false);
  assert.deepEqual(f.spawns[0].settings.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(f.spawns[0].settings.env.SYNTHETIC, 'preserved');
  assert.equal(f.spawns[0].settings.env.ANDROID_SERIAL, 'emulator-5580');
  assert.equal(f.time(), 3000);
  assert.equal(f.calls.length, 4);
  assert.equal(f.kills.length, 0);
});

const coldStatus = (count) => {
  if (count === 1) throw refused();
  return response();
};
const timedOut = (name = 'TimeoutError') =>
  Object.assign(Error('synthetic slow manifest'), { name });

test('cold owned Metro retries only transient manifest fetch failures then opens after exact verification', async () => {
  for (const failure of [timedOut(), timedOut('AbortError'), refused()]) {
    let attempts = 0;
    const f = fixture({
      status: coldStatus,
      readManifest(count, context) {
        attempts++;
        if (count === 1) {
          context.advance(5000);
          throw failure;
        }
        assert.equal(f.calls.length, 2); // Package checks only; no forwarding/open before manifest.
        return { ok: true, json: async () => manifest() };
      },
    });
    assert.deepEqual(await launchProjectApp(f.context), { startedMetro: true });
    assert.equal(attempts, 2);
    assert.equal(f.spawns.length, 1);
    assert.equal(f.kills.length, 0);
    assert.equal(f.time(), 7000);
    assert.equal(f.calls.length, 4);
  }
});

test('cold owned Metro retries a timed-out manifest body without treating it as invalid JSON', async () => {
  let attempts = 0;
  const f = fixture({
    status: coldStatus,
    readManifest(count, context) {
      attempts++;
      return {
        ok: true,
        json: async () => {
          if (count === 1) {
            context.advance(5000);
            throw timedOut('AbortError');
          }
          return manifest();
        },
      };
    },
  });
  await launchProjectApp(f.context);
  assert.equal(attempts, 2);
  assert.equal(f.kills.length, 0);
  assert.equal(f.calls.length, 4);
});

test('existing-server manifest fetch or body timeout is friendly and never retries, spawns or kills', async () => {
  for (const body of [false, true]) {
    let attempts = 0;
    const f = fixture({
      readManifest() {
        attempts++;
        if (!body) throw timedOut();
        return {
          ok: true,
          json: async () => {
            throw timedOut('AbortError');
          },
        };
      },
    });
    await assert.rejects(
      launchProjectApp(f.context),
      /existing Metro server manifest check timed out/,
    );
    assert.equal(attempts, 1);
    assert.equal(f.spawns.length, 0);
    assert.equal(f.kills.length, 0);
    assert.equal(f.calls.length, 2);
  }
});

test('status and manifest share one120-second owned startup deadline with each request capped to remaining time', async () => {
  const timeouts = [];
  const f = fixture({
    status(count) {
      if (count <= 100) throw refused();
      return response();
    },
    readManifest(count, context) {
      timeouts.push(context.settings.signal.timeout);
      context.advance(context.settings.signal.timeout);
      throw timedOut();
    },
  });
  await assert.rejects(launchProjectApp(f.context), /verified project manifest within 120 seconds/);
  assert.equal(f.time(), METRO_START_TIMEOUT_MS);
  assert.ok(timeouts.length > 1 && timeouts.length < 5);
  assert.ok(timeouts.every((value) => value > 0 && value <= 5000));
  assert.ok(timeouts.at(-1) < 5000);
  assert.deepEqual(f.kills, ['owned-metro']);
  assert.equal(f.calls.length, 2);
});

test('owned child exit or error during a manifest retry prevents forwarding and activity launch', async () => {
  for (const event of ['exit', 'error']) {
    let attempts = 0;
    const f = fixture({
      status: coldStatus,
      readManifest(count, context) {
        attempts++;
        return {
          ok: true,
          json: async () => {
            if (event === 'exit') context.listeners.exit(1, null);
            else context.listeners.error(Error('synthetic child error'));
            throw timedOut();
          },
        };
      },
    });
    await assert.rejects(launchProjectApp(f.context), /Metro exited|Metro could not start/);
    assert.equal(attempts, 1);
    assert.equal(f.calls.length, 2);
    assert.equal(f.kills.length, event === 'exit' ? 0 : 1);
  }
});

test('HTTP errors, invalid JSON and other network failures fail closed without cold-start retries', async () => {
  for (const readManifest of [
    () => ({ ok: false, json: async () => manifest() }),
    () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('synthetic invalid JSON');
      },
    }),
    () => {
      throw Object.assign(Error('reset'), { code: 'ECONNRESET' });
    },
  ]) {
    let attempts = 0;
    const f = fixture({
      status: coldStatus,
      readManifest(...args) {
        attempts++;
        return readManifest(...args);
      },
    });
    await assert.rejects(
      launchProjectApp(f.context),
      /manifest.*could not be read|invalid project manifest|manifest could not be read/,
    );
    assert.equal(attempts, 1);
    assert.deepEqual(f.kills, ['owned-metro']);
    assert.equal(f.calls.length, 2);
  }
});

test('a recovered manifest from a foreign checkout is rejected before any forwarding or opening', async () => {
  let attempts = 0;
  const f = fixture({
    status: coldStatus,
    readManifest(count) {
      attempts++;
      if (count === 1) throw timedOut();
      const foreign = manifest();
      foreign.extra.expoGo.developer.projectRoot = path.join(project, 'foreign');
      return { ok: true, json: async () => foreign };
    },
  });
  await assert.rejects(launchProjectApp(f.context), /could not be verified/);
  assert.equal(attempts, 2);
  assert.deepEqual(f.kills, ['owned-metro']);
  assert.equal(f.calls.length, 2);
});

test('uncertain initial status and occupied non-Metro port never start or terminate a process', async () => {
  for (const status of [
    () => {
      throw Object.assign(Error('timeout'), { name: 'TimeoutError' });
    },
    () => ({ ok: false, text: async () => 'error' }),
    () => response('Another HTTP service'),
  ]) {
    const f = fixture({ status });
    await assert.rejects(
      () => launchProjectApp(f.context),
      /could not be checked reliably|occupied/,
    );
    assert.equal(f.spawns.length, 0);
    assert.equal(f.kills.length, 0);
    assert.equal(f.calls.length, 2);
  }
});

test('foreign or unproven checkout identity is rejected even when the app slug matches', async () => {
  for (const bad of [
    {
      extra: {
        expoClient: { slug: 'foreign', android: { package: PROJECT_PACKAGE } },
        expoGo: { developer: { projectRoot: project } },
      },
    },
    {
      extra: {
        expoClient: {
          slug: 'my-money-management',
          android: { package: PROJECT_PACKAGE },
        },
        expoGo: {
          developer: { projectRoot: path.join(project, 'other-checkout') },
        },
      },
    },
    {
      extra: {
        expoClient: {
          slug: 'my-money-management',
          android: { package: 'other.package' },
        },
        expoGo: { developer: { projectRoot: project } },
      },
    },
    {
      extra: {
        expoClient: {
          slug: 'my-money-management',
          android: { package: PROJECT_PACKAGE },
        },
      },
    },
  ]) {
    const f = fixture({ manifest: bad });
    await assert.rejects(() => launchProjectApp(f.context), /could not be verified/);
    assert.equal(f.kills.length, 0);
    assert.equal(f.spawns.length, 0);
    assert.equal(f.calls.length, 2);
  }
});

test('startup timeout stops only the Metro child created by this invocation and never opens an activity', async () => {
  const f = fixture({
    status: () => {
      throw refused();
    },
  });
  await assert.rejects(() => launchProjectApp(f.context), /120 seconds/);
  assert.equal(f.time(), METRO_START_TIMEOUT_MS);
  assert.equal(f.spawns.length, 1);
  assert.deepEqual(f.kills, ['owned-metro']);
  assert.equal(f.calls.length, 2);
});

test('early Metro exit/error is explicit and never starts the app', async () => {
  for (const event of ['error', 'exit']) {
    let fired = false;
    const f = fixture({
      status: () => {
        throw refused();
      },
      pause: ({ listeners }) => {
        if (!fired) {
          fired = true;
          if (event === 'error') listeners.error(Error('spawn failed'));
          else listeners.exit(1, null);
        }
      },
    });
    await assert.rejects(() => launchProjectApp(f.context), /Metro could not start|Metro exited/);
    assert.equal(f.calls.length, 2);
    assert.equal(f.kills.length, event === 'exit' ? 0 : 1);
  }
});

test('activity launch errors including zero-exit Android error text are failures without touching existing Metro', async () => {
  for (const openResult of [
    { status: 1, stdout: '', stderr: 'Failure' },
    ok('Error type 3\nError: Activity class does not exist'),
    ok('Status: timeout'),
    { status: null, error: Error('ADB timeout') },
  ]) {
    const f = fixture({ openResult });
    await assert.rejects(() => launchProjectApp(f.context), /Could not open/);
    assert.equal(f.calls.length, 4);
    assert.equal(f.kills.length, 0);
    assert.equal(f.spawns.length, 0);
  }
});

test('a new-owned server is stopped on identity failure but another already-running server is never killed', async () => {
  const f = fixture({
    status: (count) => {
      if (count === 1) throw refused();
      return response();
    },
    manifest: { extra: { expoClient: { slug: 'foreign' } } },
  });
  await assert.rejects(() => launchProjectApp(f.context), /could not be verified/);
  assert.deepEqual(f.kills, ['owned-metro']);
  assert.equal(f.calls.length, 2);
});

test('forwarding happens only after identity verification and an error never opens the activity', async () => {
  for (const reverseResult of [
    { status: 1, stderr: 'forwarding rejected' },
    { status: null, error: Error('timeout') },
    ok('error: cannot bind socket'),
  ]) {
    const f = fixture({ reverseResult });
    await assert.rejects(() => launchProjectApp(f.context), /Could not connect the verified/);
    assert.deepEqual(f.calls, [
      ['shell', 'pm', 'path', PROJECT_PACKAGE],
      ['shell', 'dumpsys', 'package', PROJECT_PACKAGE],
      ['reverse', 'tcp:8081', 'tcp:8081'],
    ]);
    assert.equal(f.kills.length, 0);
  }
  const own = fixture({
    status: (count) => {
      if (count === 1) throw refused();
      return response();
    },
    reverseResult: { status: 1, stderr: 'forwarding rejected' },
  });
  await assert.rejects(() => launchProjectApp(own.context), /Could not connect the verified/);
  assert.deepEqual(own.kills, ['owned-metro']);
  assert.equal(own.calls.length, 3);
  assert.equal(own.child.stdout.listenerCount('data'), 0);
  assert.equal(own.child.stderr.listenerCount('data'), 0);
});

test('an explicit caller CI setting is preserved while normal startup does not force it', async () => {
  for (const ci of ['1', '0', 'true']) {
    const f = fixture({
      env: { CI: ci },
      status: (count) => {
        if (count === 1) throw refused();
        return response();
      },
    });
    await launchProjectApp(f.context);
    assert.equal(f.spawns[0].settings.env.CI, ci);
    assert.deepEqual(f.spawns[0].settings.stdio, ['ignore', 'pipe', 'pipe']);
  }
});

test('Metro stdout/stderr are forwarded without ending parent streams and detached when the child closes', async () => {
  const f = fixture({
    status: (count) => {
      if (count === 1) throw refused();
      return response();
    },
  });
  await launchProjectApp(f.context);
  f.child.stdout.write('bundler output\n');
  f.child.stderr.write('bundler warning\n');
  assert.deepEqual(f.stdoutChunks, ['bundler output\n']);
  assert.deepEqual(f.stderrChunks, ['bundler warning\n']);
  f.child.stdout.end();
  f.child.stderr.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.parentStdout.writableEnded, false);
  assert.equal(f.parentStderr.writableEnded, false);
  f.listeners.close();
  assert.equal(f.child.stdout.listenerCount('data'), 0);
  assert.equal(f.child.stderr.listenerCount('data'), 0);
});

test('device connection must become ready after forwarding and before MainActivity opens', async () => {
  let probes = 0;
  const f = fixture({
    device(args) {
      assert.equal(
        f.calls.some((call) => call.includes('am')),
        false,
      );
      assert.equal(f.calls.at(-1)[0], 'reverse');
      if (args.includes('run-as')) return ok('<map/>');
      if (args.includes('getprop'))
        return ok(args.at(-1) === 'metro.host' ? '' : 'google/sdk_gphone64_x86_64');
      probes++;
      return probes < 3
        ? ok('nc: connect: Connection refused\n')
        : ok('HTTP/1.0 200 OK\r\nContent-Length: 23\r\n\r\npackager-status:running');
    },
  });
  await launchProjectApp(f.context);
  assert.equal(probes, 3);
  assert.equal(f.time(), 1000);
  assert.equal(f.calls.at(-1)[1], 'am');
  assert.equal(f.calls.filter((call) => call.includes('am')).length, 1);
});

test('failed device readiness never opens the app and stops only an owned Metro child', async () => {
  for (const owned of [false, true]) {
    const f = fixture({
      status: owned ? coldStatus : undefined,
      device(args) {
        if (args.includes('run-as')) return ok('<map/>');
        if (args.includes('getprop'))
          return ok(args.at(-1) === 'metro.host' ? '' : 'google/sdk_gphone64_x86_64');
        return ok('HTTP/1.0 200 OK\r\n\r\nAnother service');
      },
    });
    await assert.rejects(launchProjectApp(f.context), /not the ready Metro/);
    assert.equal(
      f.calls.some((call) => call.includes('am')),
      false,
    );
    assert.deepEqual(f.kills, owned ? ['owned-metro'] : []);
    assert.equal(f.calls.filter((call) => call[0] === 'reverse').length, 1);
  }
});

test('owned Metro exiting during the final host recheck prevents MainActivity launch', async () => {
  let preferenceReads = 0;
  const f = fixture({
    status: coldStatus,
    device(args) {
      if (args.includes('run-as')) {
        if (++preferenceReads === 2) f.listeners.exit(1, null);
        return ok('<map/>');
      }
      if (args.includes('getprop'))
        return ok(args.at(-1) === 'metro.host' ? '' : 'google/sdk_gphone64_x86_64');
      return ok('HTTP/1.0 200 OK\r\nContent-Length: 23\r\n\r\npackager-status:running');
    },
  });
  await assert.rejects(launchProjectApp(f.context), /Metro process.*stopped/);
  assert.equal(
    f.calls.some((call) => call.includes('am')),
    false,
  );
  assert.equal(f.spawns.length, 1);
  assert.equal(f.kills.length, 0);
});
