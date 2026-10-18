const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const launcherPath = path.resolve(__dirname, '../scripts/start-android.cjs');
const launcherSource = fs.readFileSync(launcherPath, 'utf8');
const success = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const deviceList = (rows = '') => success(`List of devices attached\n${rows}\n`);

// Execute the real launcher's decisions with every process, network, and filesystem
// operation stubbed. These tests cannot contact ADB or launch a virtual phone.
async function runLauncher(options = {}) {
  const calls = [];
  const launches = [];
  const errors = [];
  const messages = [];
  const pauses = [];
  let virtualTime = 0;
  const childProcess = {
    spawnSync(command, args, spawnOptions) {
      calls.push({ command, args: Array.from(args), options: spawnOptions });
      if (args[0] === 'devices') return options.discovery ?? deviceList();
      if (args[0] === 'connect') {
        return (
          options.reconnect ?? {
            status: 1,
            stdout: 'cannot connect to 127.0.0.1:5581: connection refused',
            stderr: '',
          }
        );
      }
      if (args[0] === '-accel-check')
        return options.acceleration ?? success('WHPX is installed and usable');
      if (args[0] === '-list-avds') return success('FYP_API35\n');
      if (args.includes('ro.boot.qemu.avd_name'))
        return success(`${options.avdName ?? 'FYP_API35'}\n`);
      if (args.includes('sys.boot_completed'))
        return success(virtualTime >= (options.bootReadyAfterMs ?? 0) ? '1\n' : '');
      if (
        args.includes('run-as') &&
        args.includes('shared_prefs/com.lejie710.mymoneymanagement_preferences.xml')
      )
        return options.debugPreferences ?? success('<map />');
      if (args.includes('metro.host')) return success('');
      if (args.includes('ro.build.fingerprint')) return success('google/sdk_gphone64_x86_64');
      if (args[2] === 'exec-out')
        return (
          options.deviceStatus ??
          success('HTTP/1.0 200 OK\r\nContent-Length: 23\r\n\r\npackager-status:running')
        );
      if (args.includes('reverse')) return success();
      if (args.includes('pm') && args.includes('path'))
        return options.installedPackage ?? success('package:/data/app/synthetic/base.apk\n');
      if (args.includes('dumpsys') && args.includes('package'))
        return (
          options.debugPackage ??
          success(
            'Packages:\n  Package [com.lejie710.mymoneymanagement] (abcd):\n    flags=[ DEBUGGABLE HAS_CODE ]\n',
          )
        );
      if (args.includes('am') && args.includes('start'))
        return options.activity ?? success('Status: ok\n');
      throw new Error(`Unexpected mocked process request: ${args.join(' ')}`);
    },
    spawn(command, args, spawnOptions) {
      launches.push({ command, args: Array.from(args), options: spawnOptions });
      return { unref() {}, on() {}, kill() {} };
    },
  };
  const fakeFs = {
    existsSync() {
      return true;
    },
    mkdirSync() {},
    openSync() {
      return 42;
    },
    closeSync() {},
  };
  const fakeProcess = {
    env: { ANDROID_HOME: 'synthetic-sdk' },
    argv: [
      'node',
      launcherPath,
      ...(options.headless === false ? [] : ['--headless']),
      ...(options.bootOnly === false ? [] : ['--boot-only']),
      ...(options.extraArgs ?? []),
    ],
    execPath: 'synthetic-node',
    exitCode: 0,
  };
  await vm.runInNewContext(
    launcherSource,
    {
      require(name) {
        if (name === 'node:fs') return fakeFs;
        if (name === 'node:path') return path;
        if (name === 'node:child_process') return childProcess;
        if (name === './project-app-launch.cjs')
          return require('../scripts/project-app-launch.cjs');
        throw new Error(`Unexpected launcher dependency: ${name}`);
      },
      __dirname: path.dirname(launcherPath),
      process: fakeProcess,
      console: {
        log(message) {
          messages.push(message);
        },
        error(message) {
          errors.push(message);
        },
      },
      Date: {
        now() {
          return virtualTime;
        },
      },
      setTimeout(callback, delay) {
        pauses.push(delay);
        virtualTime += delay;
        callback();
        return 0;
      },
      fetch(url, init) {
        if (options.fetch) return options.fetch(url, init);
        throw new Error('Network access is forbidden in launcher tests.');
      },
      AbortSignal,
    },
    { filename: launcherPath, timeout: 2000 },
  );
  return { calls, launches, errors, messages, pauses, virtualTime, exitCode: fakeProcess.exitCode };
}

test('timed-out device discovery never turns uncertain state into another emulator launch', async () => {
  const result = await runLauncher({
    discovery: { status: null, stdout: '', stderr: '', error: new Error('ETIMEDOUT') },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.launches.length, 0);
  assert.match(result.errors.join('\n'), /device discovery failed/);
  assert.equal(
    result.calls.some((call) => call.args[0] === 'connect'),
    false,
  );
});

test('timed-out or failed reconnection never launches a duplicate after empty discovery', async () => {
  for (const reconnect of [
    { status: null, stdout: '', stderr: '', error: new Error('ETIMEDOUT') },
    { status: null, stdout: '', stderr: '' },
    { status: 1, stdout: '', stderr: '', error: new Error('EPIPE') },
  ]) {
    const result = await runLauncher({ reconnect });
    assert.equal(result.exitCode, 1);
    assert.equal(result.launches.length, 0);
    assert.match(result.errors.join('\n'), /reconnection did not complete/);
    assert.equal(
      result.calls.some((call) => call.args[0] === '-accel-check'),
      false,
    );
  }
});

test('a healthy native alias is reused even when its loopback alias is stale and offline', async () => {
  const result = await runLauncher({
    discovery: deviceList('emulator-5580\tdevice\n127.0.0.1:5581\toffline\n'),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.launches.length, 0);
  assert.deepEqual(result.errors, []);
  assert.ok(
    result.calls.some(
      (call) => call.args[1] === 'emulator-5580' && call.args.includes('ro.boot.qemu.avd_name'),
    ),
  );
  assert.ok(
    result.calls.some((call) => call.args[1] === 'emulator-5580' && call.args.includes('reverse')),
  );
  assert.equal(
    result.calls.some((call) => call.args[0] === 'connect'),
    false,
  );
});

test('a healthy loopback alias is reused when the native alias is offline', async () => {
  const result = await runLauncher({
    discovery: deviceList('emulator-5580\toffline\n127.0.0.1:5581\tdevice\n'),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.launches.length, 0);
  assert.ok(
    result.calls.some(
      (call) => call.args[1] === '127.0.0.1:5581' && call.args.includes('ro.boot.qemu.avd_name'),
    ),
  );
  assert.ok(
    result.calls.some((call) => call.args[1] === '127.0.0.1:5581' && call.args.includes('reverse')),
  );
});

test('an offline phone with no healthy alias stops instead of launching a second instance', async () => {
  const result = await runLauncher({ discovery: deviceList('emulator-5580\toffline\n') });
  assert.equal(result.exitCode, 1);
  assert.equal(result.launches.length, 0);
  assert.match(result.errors.join('\n'), /emulator is offline/);
});

test('successful reconnection verifies and reuses the existing phone under its loopback alias', async () => {
  for (const response of ['connected to 127.0.0.1:5581', 'already connected to 127.0.0.1:5581']) {
    const result = await runLauncher({ reconnect: success(response) });
    assert.equal(result.exitCode, 0);
    assert.equal(result.launches.length, 0);
    assert.ok(
      result.calls.some(
        (call) => call.args[1] === '127.0.0.1:5581' && call.args.includes('ro.boot.qemu.avd_name'),
      ),
    );
    assert.ok(
      result.calls.some(
        (call) => call.args[1] === '127.0.0.1:5581' && call.args.includes('reverse'),
      ),
    );
    assert.ok(result.messages.includes('Android is ready.'));
  }
});

test('a different AVD at the configured endpoint is not reused or replaced', async () => {
  for (const connection of [
    { discovery: deviceList('emulator-5580\tdevice\n') },
    { reconnect: success('connected to 127.0.0.1:5581') },
  ]) {
    const result = await runLauncher({ ...connection, avdName: 'SomeOtherProject' });
    assert.equal(result.exitCode, 1);
    assert.equal(result.launches.length, 0);
    assert.match(result.errors.join('\n'), /another emulator \(SomeOtherProject\)/);
    assert.equal(
      result.calls.some((call) => call.args.includes('reverse')),
      false,
    );
  }
});

test('confirmed absent endpoint starts one headless emulator with host graphics and hardware CPU acceleration', async () => {
  const result = await runLauncher();
  assert.equal(result.exitCode, 0);
  assert.equal(result.launches.length, 1);
  assert.ok(result.calls.some((call) => call.args[0] === 'connect'));
  const launch = result.launches[0];
  assert.equal(launch.args[launch.args.indexOf('-avd') + 1], 'FYP_API35');
  assert.equal(launch.args[launch.args.indexOf('-port') + 1], '5580');
  assert.equal(launch.args[launch.args.indexOf('-gpu') + 1], 'host');
  assert.equal(launch.args.includes('-accel'), false);
  assert.ok(result.calls.some((call) => call.args[0] === '-accel-check'));
  assert.ok(launch.args.includes('-no-window'));
  assert.equal(launch.options.windowsHide, true);
  assert.ok(result.messages.includes('Android is ready.'));
});

test('software-graphics selects SwiftShader without disabling hardware CPU acceleration', async () => {
  const result = await runLauncher({ extraArgs: ['--software-graphics'] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.launches.length, 1);
  const launch = result.launches[0];
  assert.equal(launch.args[launch.args.indexOf('-gpu') + 1], 'swiftshader');
  assert.equal(launch.args.includes('-accel'), false);
  assert.ok(result.calls.some((call) => call.args[0] === '-accel-check'));
  assert.ok(launch.args.includes('-no-window'));
  assert.equal(launch.options.windowsHide, true);
});

test('full software mode selects SwiftShader and explicitly disables CPU acceleration', async () => {
  for (const extraArgs of [['--software'], ['--software', '--software-graphics']]) {
    const result = await runLauncher({
      extraArgs,
      acceleration: { status: 1, stdout: 'No hardware acceleration', stderr: '' },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.launches.length, 1);
    const launch = result.launches[0];
    assert.equal(launch.args[launch.args.indexOf('-gpu') + 1], 'swiftshader');
    assert.equal(launch.args[launch.args.indexOf('-accel') + 1], 'off');
    assert.equal(
      result.calls.some((call) => call.args[0] === '-accel-check'),
      false,
    );
    assert.ok(launch.args.includes('-no-window'));
  }
});

test('graphics-only fallback still stops when hardware CPU acceleration is unavailable', async () => {
  const result = await runLauncher({
    extraArgs: ['--software-graphics'],
    acceleration: { status: 1, stdout: 'No hardware acceleration', stderr: '' },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.launches.length, 0);
  assert.match(result.errors.join('\n'), /hardware acceleration is unavailable/);
});

test('renderer flags never restart or duplicate an already-running verified emulator', async () => {
  for (const extraArgs of [[], ['--software-graphics'], ['--software']]) {
    const result = await runLauncher({
      extraArgs,
      discovery: deviceList('emulator-5580\tdevice\n'),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.launches.length, 0);
    assert.equal(
      result.calls.some((call) => call.args[0] === '-accel-check'),
      false,
    );
    assert.ok(result.messages.includes('Android is ready.'));
  }
});

test('new visible project-app emulator skips snapshots without wiping userdata while visible Expo Go keeps its default', async () => {
  for (const projectApp of [true, false]) {
    const result = await runLauncher({
      headless: false,
      extraArgs: projectApp ? ['--project-app'] : [],
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.launches.length, 1);
    const launch = result.launches[0];
    assert.equal(launch.args.includes('-no-snapshot'), projectApp);
    assert.equal(launch.args.includes('-no-window'), false);
    assert.equal(launch.args.includes('-wipe-data'), false);
    assert.equal(launch.options.windowsHide, false);
  }
});

test('visible project-app mode reuses a running emulator without restarting it or changing its snapshot mode', async () => {
  const result = await runLauncher({
    headless: false,
    extraArgs: ['--project-app'],
    discovery: deviceList('emulator-5580\tdevice\n'),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.launches.length, 0);
  assert.ok(result.messages.includes('Android is ready.'));
  assert.equal(
    result.calls.some((call) => call.args.includes('emu') || call.args.includes('force-stop')),
    false,
  );
});

test('boot readiness appearing between polls advances within one second instead of ten', async () => {
  const result = await runLauncher({ bootReadyAfterMs: 2500 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.virtualTime, 3000);
  assert.deepEqual(result.pauses, [1000, 1000, 1000]);
  assert.equal(result.messages.filter((message) => message.startsWith('Waiting for Android')).length, 1);
  assert.equal(result.launches.length, 1);
  assert.ok(result.calls.some((call) => call.args.includes('reverse')));
});

test('faster boot polling retains the hardware and software deadlines and never forwards an unbooted device', async () => {
  for (const [extraArgs, deadline] of [[[], 240000], [['--software'], 600000]]) {
    const result = await runLauncher({ extraArgs, bootReadyAfterMs: Infinity });
    assert.equal(result.exitCode, 1);
    assert.equal(result.virtualTime, deadline);
    assert.equal(
      result.messages.filter((message) => message.startsWith('Waiting for Android')).length,
      deadline / 10000,
    );
    assert.match(result.errors.join('\n'), /Android did not finish starting/);
    assert.equal(result.launches.length, 1);
    assert.equal(
      result.calls.some((call) => call.args.includes('reverse') || call.args.includes('am')),
      false,
    );
  }
});

test('project-app mode verifies the same owned AVD and opens MainActivity instead of Expo Go', async () => {
  const result = await runLauncher({
    bootOnly: false,
    extraArgs: ['--project-app'],
    discovery: deviceList('emulator-5580\tdevice\n'),
    fetch: async (url) =>
      url.endsWith('/status')
        ? { ok: true, text: async () => 'packager-status:running' }
        : {
            ok: true,
            json: async () => ({
              extra: {
                expoClient: {
                  slug: 'my-money-management',
                  android: { package: 'com.lejie710.mymoneymanagement' },
                },
                expoGo: { developer: { projectRoot: path.resolve(__dirname, '..') } },
              },
            }),
          },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.launches.length, 0);
  assert.ok(
    result.calls.some(
      (call) => call.args.includes('pm') && call.args.includes('com.lejie710.mymoneymanagement'),
    ),
  );
  const open = result.calls.find((call) => call.args.includes('am'));
  assert.ok(open.args.includes('com.lejie710.mymoneymanagement/.MainActivity'));
  assert.equal(open.args.includes('host.exp.exponent'), false);
  assert.equal(open.args.includes('-S'), false);
});

test('project-app mode cannot bypass wrong-AVD or missing-package verification', async () => {
  const wrong = await runLauncher({
    bootOnly: false,
    extraArgs: ['--project-app'],
    discovery: deviceList('emulator-5580\tdevice\n'),
    avdName: 'ForeignAVD',
  });
  assert.equal(wrong.exitCode, 1);
  assert.equal(
    wrong.calls.some((call) => call.args.includes('pm')),
    false,
  );
  assert.equal(wrong.launches.length, 0);
  const missing = await runLauncher({
    bootOnly: false,
    extraArgs: ['--project-app'],
    discovery: deviceList('emulator-5580\tdevice\n'),
    installedPackage: success(''),
  });
  assert.equal(missing.exitCode, 1);
  assert.match(missing.errors.join('\n'), /not installed/);
  assert.equal(missing.launches.length, 0);
  assert.equal(
    missing.calls.some((call) => call.args.includes('reverse')),
    false,
  );
  assert.equal(
    missing.calls.some((call) => call.args.includes('am')),
    false,
  );
});

test('project-app wrapper verifies device HTTP after forwarding and rejects a foreign status before opening', async () => {
  for (const ready of [true, false]) {
    const body = ready ? 'packager-status:running' : 'another HTTP service';
    const result = await runLauncher({
      bootOnly: false,
      extraArgs: ['--project-app'],
      discovery: deviceList('emulator-5580\tdevice\n'),
      deviceStatus: success(
        `HTTP/1.0 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      ),
      fetch: async (url) =>
        url.endsWith('/status')
          ? { ok: true, text: async () => 'packager-status:running' }
          : {
              ok: true,
              json: async () => ({
                extra: {
                  expoClient: {
                    slug: 'my-money-management',
                    android: { package: 'com.lejie710.mymoneymanagement' },
                  },
                  expoGo: { developer: { projectRoot: path.resolve(__dirname, '..') } },
                },
              }),
            },
    });
    const forwarding = result.calls.findIndex((call) => call.args.includes('reverse'));
    const deviceProbe = result.calls.findIndex((call) => call.args[2] === 'exec-out');
    const opening = result.calls.findIndex((call) => call.args.includes('am'));
    assert.ok(forwarding >= 0 && deviceProbe > forwarding);
    assert.equal(result.calls[deviceProbe].args[1], 'emulator-5580');
    assert.ok(result.calls[deviceProbe].options.timeout <= 3000);
    assert.equal(result.calls[deviceProbe].options.maxBuffer, 16384);
    assert.equal(result.launches.length, 0);
    if (ready) {
      assert.equal(result.exitCode, 0);
      assert.ok(opening > deviceProbe);
      assert.deepEqual(result.errors, []);
    } else {
      assert.equal(result.exitCode, 1);
      assert.equal(opening, -1);
      assert.match(result.errors.join('\n'), /not the ready Metro/);
    }
  }
});

test('project-app release APK is rejected without contacting Metro or changing forwarding', async () => {
  let requests = 0;
  const result = await runLauncher({
    bootOnly: false,
    extraArgs: ['--project-app'],
    discovery: deviceList('emulator-5580\tdevice\n'),
    debugPackage: success(
      'Packages:\n  Package [com.lejie710.mymoneymanagement] (abcd):\n    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ALLOW_BACKUP ]\n',
    ),
    fetch: async () => {
      requests++;
      throw Error('Unexpected network request');
    },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join('\n'), /release\/non-debuggable.*debug APK/);
  assert.equal(requests, 0);
  assert.equal(result.launches.length, 0);
  assert.equal(
    result.calls.some((call) => call.args.includes('reverse') || call.args.includes('am')),
    false,
  );
  assert.deepEqual(result.calls.at(-1).args.slice(2), [
    'shell',
    'dumpsys',
    'package',
    'com.lejie710.mymoneymanagement',
  ]);
});

test('rejected project-app server ownership never rewrites ADB forwarding', async () => {
  for (const server of ['foreign-checkout', 'unknown-status']) {
    const result = await runLauncher({
      bootOnly: false,
      extraArgs: ['--project-app'],
      discovery: deviceList('emulator-5580\tdevice\n'),
      fetch: async (url) =>
        url.endsWith('/status')
          ? {
              ok: true,
              text: async () =>
                server === 'unknown-status' ? 'another HTTP service' : 'packager-status:running',
            }
          : {
              ok: true,
              json: async () => ({
                extra: {
                  expoClient: {
                    slug: 'my-money-management',
                    android: { package: 'com.lejie710.mymoneymanagement' },
                  },
                  expoGo: {
                    developer: { projectRoot: path.resolve(__dirname, '../../another-checkout') },
                  },
                },
              }),
            },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(
      result.calls.some((call) => call.args.includes('reverse')),
      false,
    );
    assert.equal(
      result.calls.some((call) => call.args.includes('am')),
      false,
    );
    assert.equal(result.launches.length, 0);
  }
});

test('default Expo Go mode retains its existing-server deep link and never selects the project package', async () => {
  const result = await runLauncher({
    bootOnly: false,
    discovery: deviceList('emulator-5580\tdevice\n'),
    fetch: async (url) =>
      url.endsWith('/status')
        ? { ok: true }
        : { json: async () => ({ extra: { expoClient: { slug: 'my-money-management' } } }) },
  });
  assert.equal(result.exitCode, 0);
  const open = result.calls.find((call) => call.args.includes('am'));
  assert.ok(open.args.includes('host.exp.exponent'));
  assert.ok(open.args.includes('exp://127.0.0.1:8081?__expo_disable_fab=1'));
  assert.equal(
    result.calls.some((call) => call.args.includes('pm')),
    false,
  );
});
