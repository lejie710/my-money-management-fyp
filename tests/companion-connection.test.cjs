const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const ts = require('typescript');
const connection = require('../src/companion/connection');
const { parseCompanionConnection, MAX_COMPANION_CONNECTION_BYTES } = connection;
const config = {
  version: 1,
  runId: 'synthetic-run-1',
  url: 'http://127.0.0.1:8787/v1/recognize',
  token: 'synthetic_'.repeat(6),
};
const bytes = (value = config) => new Uint8Array(Buffer.from(JSON.stringify(value), 'ascii'));

test('pure parser returns one detached frozen exact configuration and accepts field order and ordinary spaces', () => {
  const source = bytes(),
    parsed = parseCompanionConnection(source);
  assert.deepEqual(parsed, config);
  assert.ok(Object.isFrozen(parsed));
  assert.deepEqual(Object.keys(parsed), ['version', 'runId', 'url', 'token']);
  source.fill(0);
  assert.deepEqual(parsed, config);
  const reordered = ` { "token" : "${config.token}" , "url" : "${config.url}" , "runId" : "${config.runId}" , "version" : 1 } `;
  assert.deepEqual(parseCompanionConnection(Buffer.from(reordered, 'ascii')), config);
});

test('exact byte bounds reject empty, oversized, control, nonASCII and BOM data without payload in errors', () => {
  const exact = Buffer.alloc(MAX_COMPANION_CONNECTION_BYTES, 32);
  Buffer.from(bytes()).copy(exact);
  assert.deepEqual(parseCompanionConnection(exact), config);
  for (const invalid of [
    null,
    {},
    [],
    'raw',
    new Uint8Array(),
    new Uint8Array(4097),
    Buffer.concat([bytes(), Buffer.from('\n')]),
    Buffer.from([0xef, 0xbb, 0xbf, ...bytes()]),
    Buffer.from([0x80]),
    Buffer.from([0x7f]),
    Buffer.from([9]),
    Buffer.from('{private-payload'),
  ]) {
    assert.throws(
      () => parseCompanionConnection(invalid),
      (error) =>
        error.code === 'INVALID_CONNECTION' &&
        !error.message.includes('private-payload') &&
        !error.message.includes(config.token),
    );
  }
});

test('schema, run ID, token and exact loopback path/port reject unowned configurations', () => {
  for (const invalid of [
    [],
    null,
    { ...config, extra: true },
    { ...config, version: '1' },
    { ...config, version: 2 },
    { ...config, runId: '' },
    { ...config, runId: 'Uppercase' },
    { ...config, runId: '-first' },
    { ...config, runId: 'a'.repeat(65) },
    { ...config, token: 'a'.repeat(42) },
    { ...config, token: 'a'.repeat(129) },
    { ...config, token: 'a'.repeat(43) + '=' },
    { ...config, token: 'a'.repeat(43) + '\t' },
    ...[
      'http://localhost:8787/v1/recognize',
      'http://127.0.0.1:8788/v1/recognize',
      'https://127.0.0.1:8787/v1/recognize',
      'http://127.0.0.1:8787/v1/recognize?token=x',
      'http://127.0.0.1:8787/v1/recognize/',
      'http://user@127.0.0.1:8787/v1/recognize',
      'http://example.test:8787/v1/recognize',
    ].map((url) => ({ ...config, url })),
  ])
    assert.throws(
      () => parseCompanionConnection(bytes(invalid)),
      (error) => error.code === 'INVALID_CONNECTION',
    );
  assert.equal(
    parseCompanionConnection(bytes({ ...config, runId: 'a'.repeat(64), token: 'a'.repeat(128) }))
      .runId.length,
    64,
  );
  assert.equal(
    parseCompanionConnection(bytes({ ...config, token: 'a'.repeat(43) })).token.length,
    43,
  );
});

test('duplicate JSON members including escaped duplicate names are rejected instead of taking the last token', () => {
  for (const extra of ['"version":1,', '"token":"ignored",', '"\\u0074oken":"ignored",']) {
    const input = '{' + extra + JSON.stringify(config).slice(1);
    assert.throws(
      () => parseCompanionConnection(Buffer.from(input, 'ascii')),
      (error) => error.code === 'INVALID_CONNECTION',
    );
  }
});

function nativeFixture(options = {}) {
  const calls = [],
    data = options.bytes ?? bytes();
  let infoCount = 0,
    offset = options.startOffset ?? 0;
  class File {
    constructor(...args) {
      calls.push(['File', ...args]);
    }
    info() {
      calls.push(['info']);
      infoCount++;
      if (options.infoError) throw Error('private-native-path-and-token');
      if (options.missing || (infoCount > 1 && options.disappear)) return { exists: false };
      return {
        exists: true,
        size:
          infoCount > 1 && options.afterSize !== undefined
            ? options.afterSize
            : (options.size ?? data.length),
      };
    }
    open(mode) {
      calls.push(['open', mode]);
      if (options.openError) throw Error('private-native-path-and-token');
      return {
        get offset() {
          return offset;
        },
        get size() {
          return calls.some(([name]) => name === 'read') && options.endSize !== undefined
            ? options.endSize
            : (options.handleSize ?? data.length);
        },
        async readBytes(size) {
          calls.push(['read', size]);
          if (options.readError) throw Error('private-native-path-and-token');
          if (options.gate) await options.gate;
          offset = options.endOffset ?? size;
          return options.short ? data.slice(0, data.length - 1) : data;
        },
        close() {
          calls.push(['close']);
          if (options.closeError) throw Error('private-native-path-and-token');
        },
      };
    }
  }
  const compiled = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, '../src/companion/expoConnection.ts'), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === 'expo-file-system')
        return {
          File,
          FileMode: { ReadOnly: 'readonly' },
          Paths: { document: { uri: 'file:///private/files/' } },
        };
      if (name === './connection') return connection;
      throw Error(`Unexpected connection dependency: ${name}`);
    },
  });
  return { calls, read: exports.readPrivateCompanionConnection };
}

test('native reader uses only the fixed app-private file and closes its bounded read handle before returning', async () => {
  const f = nativeFixture();
  assert.deepEqual(await f.read(), config);
  assert.deepEqual(f.calls, [
    ['File', { uri: 'file:///private/files/' }, 'companion-connection.json'],
    ['info'],
    ['open', 'readonly'],
    ['read', bytes().length],
    ['info'],
    ['close'],
  ]);
});

test('missing file alone returns null; bad size is rejected before opening or reading', async () => {
  const missing = nativeFixture({ missing: true });
  assert.equal(await missing.read(), null);
  assert.equal(
    missing.calls.some(([name]) => name === 'open'),
    false,
  );
  for (const size of [0, -1, 4097, 1.5, NaN, Infinity]) {
    const f = nativeFixture({ size });
    await assert.rejects(f.read(), (error) => error.code === 'INVALID_CONNECTION');
    assert.equal(
      f.calls.some(([name]) => name === 'open'),
      false,
    );
  }
});

test('initial offset/size, short read, end offset/size and disappearing/replaced file are all rejected with handle closed', async () => {
  for (const options of [
    { startOffset: 1 },
    { handleSize: bytes().length + 1 },
    { short: true },
    { endOffset: 0 },
    { endSize: bytes().length + 1 },
    { afterSize: bytes().length + 1 },
    { disappear: true },
  ]) {
    const f = nativeFixture(options);
    await assert.rejects(f.read(), (error) => error.code === 'CONNECTION_UNAVAILABLE');
    assert.equal(f.calls.filter(([name]) => name === 'close').length, 1);
  }
});

test('native failures and malformed payloads use fixed errors without file paths or token values', async () => {
  for (const options of [
    { infoError: true },
    { openError: true },
    { readError: true },
    { closeError: true },
    { bytes: new Uint8Array(Buffer.from('private-native-path-and-token')) },
  ]) {
    const f = nativeFixture(options);
    await assert.rejects(
      f.read(),
      (error) =>
        error instanceof connection.CompanionConnectionError &&
        !error.message.includes('private-native') &&
        !error.message.includes(config.token),
    );
    if (f.calls.some(([name]) => name === 'open') && !options.openError)
      assert.equal(f.calls.filter(([name]) => name === 'close').length, 1);
  }
});
