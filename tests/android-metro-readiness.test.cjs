const test = require('node:test');
const assert = require('node:assert/strict');
const {
  savedDebugHost,
  readDeviceMetroHost,
  statusResponse,
  waitForDeviceMetro,
  deviceProbeCommand,
  DEVICE_METRO_TIMEOUT_MS,
} = require('../scripts/android-metro-readiness.cjs');
const PACKAGE = 'com.lejie710.mymoneymanagement';
const BODY = 'packager-status:running';
const HTTP = `HTTP/1.0 200 OK\r\nContent-Length: ${BODY.length}\r\n\r\n${BODY}`;
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });

function fixture(options = {}) {
  let clock = 0,
    probes = 0,
    preferences = 0;
  const calls = [],
    messages = [];
  const context = {
    packageName: PACKAGE,
    now: () => clock,
    pause: async (ms) => {
      clock += ms;
    },
    log: (message) => messages.push(message),
    adbRun(args, settings) {
      calls.push({ args, settings });
      if (args.includes('run-as')) return options.preferences?.(++preferences) ?? ok('<map/>');
      if (args.includes('getprop'))
        return ok(
          args.at(-1) === 'metro.host'
            ? (options.property ?? '')
            : (options.fingerprint ?? 'google/sdk_gphone64_x86_64/emu64xa'),
        );
      if (args[0] === 'exec-out')
        return (
          options.probe?.(++probes, settings, (ms) => {
            clock += ms;
          }) ?? ok(HTTP)
        );
      throw Error('Unexpected operation');
    },
  };
  return { context, calls, messages, time: () => clock, probes: () => probes };
}

test('stock emulator default and exact local overrides follow installed RN precedence', () => {
  for (const host of ['', '10.0.2.2:8081', '127.0.0.1:8081', 'localhost:8081']) {
    const f = fixture({
      preferences: () => ok(`<map><string name="debug_http_host">${host}</string></map>`),
    });
    assert.equal(readDeviceMetroHost(f.context.adbRun, PACKAGE).authority, host || '10.0.2.2:8081');
  }
  const prop = fixture({ property: '127.0.0.1' });
  assert.equal(readDeviceMetroHost(prop.context.adbRun, PACKAGE).authority, '127.0.0.1:8081');
  const precedence = fixture({
    property: 'foreign.test',
    preferences: () => ok('<map><string name="debug_http_host">localhost:8081</string></map>'),
  });
  assert.equal(readDeviceMetroHost(precedence.context.adbRun, PACKAGE).authority, 'localhost:8081');
  assert.equal(precedence.calls.length, 1);
});

test('foreign settings, unsupported ports, ambiguous XML and preference read failure never probe', () => {
  for (const preferences of [
    () => ok('<map><string name="debug_http_host">foreign.test:8081</string></map>'),
    () => ok('<map><string name="debug_http_host">localhost:9999</string></map>'),
    () =>
      ok(
        '<map><string name="debug_http_host">localhost:8081</string><string name="debug_http_host">10.0.2.2:8081</string></map>',
      ),
    () => ok('<map><int name="debug_http_host" value="8081"/></map>'),
    () => ok('not XML'),
    () => ({ status: 1, stdout: '', stderr: 'Permission denied' }),
    () => ({
      status: null,
      error: { code: 'ETIMEDOUT' },
      stdout: '',
      stderr: '',
    }),
  ]) {
    const f = fixture({ preferences });
    assert.throws(() => readDeviceMetroHost(f.context.adbRun, PACKAGE));
    assert.equal(f.probes(), 0);
  }
  assert.throws(
    () => readDeviceMetroHost(fixture({ property: 'foreign.test' }).context.adbRun, PACKAGE),
    /different debug-server/,
  );
});

test('only the exact missing preferences file can use the platform default', () => {
  const f = fixture({
    preferences: () => ({
      status: 1,
      stdout: '',
      stderr: `cat: shared_prefs/${PACKAGE}_preferences.xml: No such file or directory\n`,
    }),
  });
  assert.equal(readDeviceMetroHost(f.context.adbRun, PACKAGE).authority, '10.0.2.2:8081');
  assert.equal(
    savedDebugHost('<?xml version="1.0" encoding="utf-8" standalone="yes" ?>\n<map />'),
    '',
  );
});

test('HTTP status requires an exact successful bounded body with complete framing', () => {
  assert.equal(statusResponse(HTTP), true);
  assert.equal(
    statusResponse(
      `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${BODY.length.toString(16)}\r\n${BODY}\r\n0\r\n\r\n`,
    ),
    true,
  );
  assert.equal(statusResponse(`HTTP/1.0 200 OK\r\nConnection: close\r\n\r\n${BODY}`), true);
  for (const raw of [
    HTTP.replace('200', '302'),
    HTTP.replace('23', '21'),
    HTTP + '\n',
    HTTP.replace(BODY, 'Another server'),
    HTTP.replace('\r\n\r\n', '\n\n'),
    'x'.repeat(16385),
    `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 22\r\n\r\n${BODY}`,
    `HTTP/1.1 200 OK\r\nContent-Length: 22\r\nContent-Length: 22\r\n\r\n${BODY}`,
    `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n16\r\n${BODY}\r\n0\r\n`,
  ])
    assert.throws(() => statusResponse(raw));
});

test('connection startup retries are bounded and preserve preferences without any mutation command', async () => {
  const f = fixture({
    probe: (count) =>
      count < 3 ? { status: 1, stdout: '', stderr: 'nc: connect: Connection refused\n' } : ok(HTTP),
  });
  assert.equal(await waitForDeviceMetro(f.context), '10.0.2.2:8081');
  assert.equal(f.probes(), 3);
  assert.equal(f.time(), 1000);
  assert.equal(f.messages.length, 1);
  for (const call of f.calls) {
    assert.ok(
      call.args[0] === 'exec-out' || call.args.includes('getprop') || call.args.includes('cat'),
    );
    if (call.args[0] === 'exec-out') {
      assert.equal(
        call.args[1],
        "printf '%s\\r\\n' 'GET /status HTTP/1.0' 'Host: 10.0.2.2:8081' 'Connection: close' '' | toybox nc -w 2 -W 2 10.0.2.2 8081",
      );
      assert.equal(call.settings.input, undefined);
      assert.ok(call.settings.timeout > 0 && call.settings.timeout <= 3000);
      assert.equal(call.settings.maxBuffer, 16384);
    }
  }
});

test('raw exec-out connection errors retry and target construction rejects shell syntax', async () => {
  const f = fixture({
    probe: (count) => (count === 1 ? ok('nc: connect: Connection refused\n') : ok(HTTP)),
  });
  await waitForDeviceMetro(f.context);
  assert.equal(f.probes(), 2);
  for (const target of [
    'foreign.test:8081',
    'localhost:8081; echo x',
    "localhost':8081",
    'localhost:80',
  ])
    assert.throws(() => deviceProbeCommand(target));
});

test('retry timeout remains within its own60-second deadline', async () => {
  const f = fixture({
    probe: (_count, settings, advance) => {
      advance(settings.timeout);
      return {
        status: null,
        stdout: '',
        stderr: '',
        error: { code: 'ETIMEDOUT' },
      };
    },
  });
  await assert.rejects(waitForDeviceMetro(f.context), /within 60 seconds/);
  assert.equal(f.time(), DEVICE_METRO_TIMEOUT_MS);
  assert.ok(f.probes() < 20);
});

test('non-Metro response, transport errors and unavailable nc fail immediately', async () => {
  for (const result of [
    ok(HTTP.replace(BODY, 'wrong')),
    { status: 127, stdout: '', stderr: 'toybox: Unknown command nc' },
    { status: 1, stdout: '', stderr: 'error: device offline' },
    { status: null, stdout: '', stderr: '', error: { code: 'ENOBUFS' } },
  ]) {
    const f = fixture({ probe: () => result });
    await assert.rejects(waitForDeviceMetro(f.context));
    assert.equal(f.probes(), 1);
    assert.equal(f.time(), 0);
  }
});

test('settings changing after success are rejected, and an owned Metro exit interrupts the gate', async () => {
  const f = fixture({
    preferences: (count) =>
      ok(
        `<map><string name="debug_http_host">${count === 1 ? '10.0.2.2' : 'localhost'}:8081</string></map>`,
      ),
  });
  await assert.rejects(waitForDeviceMetro(f.context), /settings changed/);
  const ended = fixture();
  ended.context.assertActive = () => {
    throw Error('owned Metro stopped');
  };
  await assert.rejects(waitForDeviceMetro(ended.context), /owned Metro stopped/);
  assert.equal(ended.probes(), 0);
});

test('successful-looking output with unknown stderr cannot establish host or HTTP readiness', async () => {
  const preferences = fixture({
    preferences: () => ({ ...ok('<map/>'), stderr: 'unconfirmed ADB warning' }),
  });
  assert.throws(() => readDeviceMetroHost(preferences.context.adbRun, PACKAGE), /preferences/);
  const property = fixture();
  const original = property.context.adbRun;
  property.context.adbRun = (args, options) => {
    const result = original(args, options);
    return args.includes('getprop') ? { ...result, stderr: 'unconfirmed ADB warning' } : result;
  };
  assert.throws(
    () => readDeviceMetroHost(property.context.adbRun, PACKAGE),
    /host could not be verified/,
  );
  const response = fixture({ probe: () => ({ ...ok(HTTP), stderr: 'unconfirmed ADB warning' }) });
  await assert.rejects(waitForDeviceMetro(response.context), /could not run reliably/);
  assert.equal(response.probes(), 1);
});
