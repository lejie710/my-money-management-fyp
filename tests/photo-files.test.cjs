const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { loadAdapter, deferred, flush } = require('./helpers/native-adapter-vm.cjs');
const core = require('../src/core/transactionContext');
const header = require('../src/attachments/imageHeader');

const u32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
const chunk = (kind, bytes) => {
  const body = Buffer.concat([Buffer.from(kind), bytes]);
  return Buffer.concat([u32(bytes.length), body, u32(zlib.crc32(body))]);
};
function png(width = 1, height = 1) {
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])])),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const photo = {
  id: 'photo-file-test',
  fileName: 'photo-file-test.png',
  ownerIncarnationId: 'wallet-test',
  mimeType: 'image/png',
  width: 1,
  height: 1,
  byteSize: png().length,
};

function fixture(options = {}) {
  const records = new Map(),
    calls = [];
  const sourceUri = options.uri ?? 'content://provider/selection';
  records.set(sourceUri, { bytes: options.bytes ?? png(), ...options.source });
  const joined = (parts) =>
    parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
  class Directory {
    constructor(...parts) {
      this.uri = joined(parts);
      calls.push([
        'directory',
        ...parts.map((part) => (typeof part === 'string' ? part : part.uri)),
      ]);
    }
    create(settings) {
      calls.push(['mkdir', this.uri, settings]);
      if (options.mkdirError) throw options.mkdirError;
    }
  }
  class File {
    constructor(...parts) {
      this.uri = joined(parts);
    }
    get exists() {
      throw Error('File.exists cannot establish absence when access is denied');
    }
    info() {
      calls.push(['info', this.uri]);
      const record = records.get(this.uri);
      if (record?.infoError) throw record.infoError;
      return record
        ? { exists: true, size: Object.hasOwn(record, 'size') ? record.size : record.bytes.length }
        : { exists: false };
    }
    async bytes() {
      calls.push(['bytes', this.uri]);
      const record = records.get(this.uri);
      if (record.bytesError) throw record.bytesError;
      return record.bytes;
    }
    async copy(target, settings) {
      calls.push(['copy', this.uri, target.uri, settings]);
      if (options.copy) return options.copy(this.uri, target.uri, records);
      records.set(target.uri, { ...records.get(this.uri) });
    }
    delete() {
      calls.push(['delete', this.uri]);
      if (options.delete) return options.delete(this.uri, records);
      records.delete(this.uri);
    }
  }
  const loaded = loadAdapter('photoFiles.ts', {
    'expo-file-system': {
      Directory,
      File,
      Paths: { document: { uri: 'file:///owned-documents' } },
    },
    'react-native': {
      Image: {
        getSize(uri, success, failure) {
          calls.push(['decode', uri]);
          if (options.decode) return options.decode(uri, success, failure);
          success(1, 1);
        },
      },
    },
    './imageHeader': header,
    '../core/transactionContext': core,
  });
  return {
    ...loaded,
    calls,
    records,
    sourceUri,
    adapter: loaded.exports.createPhotoFileAdapter('encoded-family'),
  };
}

test('supported content URI is inspected from bytes before native decoding and returns real header metadata', async () => {
  const f = fixture();
  const metadata = await f.adapter.inspectSource(f.sourceUri);
  assert.deepEqual(metadata, {
    mimeType: 'image/png',
    width: 1,
    height: 1,
    byteSize: png().length,
  });
  assert.deepEqual(
    f.calls.map((x) => x[0]),
    ['info', 'bytes', 'decode'],
  );
  assert.equal(f.timers.size, 0);
});

test('remote/path-only URIs never reach the native filesystem', async () => {
  for (const uri of [
    'https://example.invalid/photo.png',
    '/tmp/photo.png',
    'data:image/png,x',
    null,
  ]) {
    const f = fixture();
    await assert.rejects(f.adapter.inspectSource(uri), /local photo/);
    assert.equal(f.calls.length, 0);
  }
});

test('unavailable, oversized or invalid size is rejected before byte allocation or decode', async () => {
  for (const size of [0, -1, NaN, Infinity, undefined, 10 * 1024 * 1024 + 1]) {
    const f = fixture({ source: { size } });
    await assert.rejects(f.adapter.inspectSource(f.sourceUri), /10 MiB/);
    assert.deepEqual(
      f.calls.map((x) => x[0]),
      ['info'],
    );
  }
});

test('oversized dimensions, invalid image bytes, metadata races and read failure never reach decode', async () => {
  for (const options of [
    { bytes: png(16385, 1) },
    { bytes: png(10000, 10000) },
    { bytes: Buffer.from('GIF89a unsupported') },
    { source: { size: png().length + 1 } },
    { source: { bytesError: Error('Read unavailable') } },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.adapter.inspectSource(f.sourceUri));
    assert.equal(
      f.calls.some((x) => x[0] === 'decode'),
      false,
    );
  }
});

test('native decode failure, mismatched dimensions and timeout preserve an explicit failure', async () => {
  for (const decode of [(_uri, _ok, fail) => fail(), (_uri, ok) => ok(2, 1)]) {
    const f = fixture({ decode });
    await assert.rejects(f.adapter.inspectSource(f.sourceUri), /decoded|dimensions/);
    assert.equal(f.timers.size, 0);
  }
  let late;
  const timed = fixture({
    decode: (_uri, ok) => {
      late = ok;
    },
  });
  const pending = timed.adapter.inspectSource(timed.sourceUri);
  await flush();
  timed.fireTimers();
  await assert.rejects(pending, /decoded in time/);
  late(1, 1);
  assert.equal(timed.timers.size, 0);
});

test('copy is awaited, explicitly refuses overwrite, and never deletes the source', async () => {
  const copy = deferred();
  const f = fixture({ copy: () => copy.promise });
  let settled = false;
  const pending = f.adapter.copyIntoOwned(f.sourceUri, photo).then(() => {
    settled = true;
  });
  await flush();
  assert.equal(settled, false);
  const invocation = f.calls.find((x) => x[0] === 'copy');
  assert.equal(invocation[3].overwrite, false);
  copy.resolve();
  await pending;
  assert.equal(settled, true);
  assert.equal(
    f.calls.some((x) => x[0] === 'delete'),
    false,
  );
  assert.ok(f.records.has(f.sourceUri));
});

test('existing or unreadable targets block copy before directory creation', async () => {
  for (const entry of [{ bytes: png() }, { infoError: Error('Permission unavailable') }]) {
    const f = fixture();
    f.records.set(f.adapter.uriFor(photo), entry);
    await assert.rejects(
      f.adapter.copyIntoOwned(f.sourceUri, photo),
      /already exists|Permission unavailable/,
    );
    assert.equal(
      f.calls.some((x) => x[0] === 'copy' || x[0] === 'mkdir'),
      false,
    );
  }
});

test('copy-then-error remains an uncertain failure with its target available for manager recovery', async () => {
  const f = fixture({
    copy: async (source, target, records) => {
      records.set(target, { ...records.get(source) });
      throw Error('Copy response lost');
    },
  });
  await assert.rejects(f.adapter.copyIntoOwned(f.sourceUri, photo), /response lost/);
  assert.ok(f.records.has(f.adapter.uriFor(photo)));
  assert.ok(f.records.has(f.sourceUri));
  assert.equal(
    f.calls.some((x) => x[0] === 'delete'),
    false,
  );
});

test('owned missing files return null but metadata permission failure never becomes absence or completed removal', async () => {
  const f = fixture();
  assert.equal(await f.adapter.inspectOwned(photo), null);
  const target = f.adapter.uriFor(photo);
  f.records.set(target, { infoError: Error('Permission unavailable') });
  await assert.rejects(f.adapter.inspectOwned(photo), /Permission unavailable/);
  await assert.rejects(f.adapter.removeOwned(photo), /Permission unavailable/);
  assert.equal(
    f.calls.some((x) => x[0] === 'delete'),
    false,
  );
});

test('delete verifies absence and leaves after-effect failures for the manager to reconcile', async () => {
  const retained = fixture({ delete: () => {} });
  retained.records.set(retained.adapter.uriFor(photo), { bytes: png() });
  await assert.rejects(retained.adapter.removeOwned(photo), /could not be removed/);
  const lost = fixture({
    delete: (uri, records) => {
      records.delete(uri);
      throw Error('Delete response lost');
    },
  });
  lost.records.set(lost.adapter.uriFor(photo), { bytes: png() });
  await assert.rejects(lost.adapter.removeOwned(photo), /response lost/);
  assert.equal(await lost.adapter.inspectOwned(photo), null);
  assert.ok(lost.records.has(lost.sourceUri));
});

test('long common-prefix families and owners use bounded distinct path components', () => {
  const f = fixture();
  const longOwner = { ...photo, ownerIncarnationId: 'w' + ':'.repeat(119) };
  const prefix = encodeURIComponent(
    JSON.stringify(['test', 'namespace-'.repeat(12), 'firebase', 'u'.repeat(128)]),
  );
  const a = f.exports.createPhotoFileAdapter(prefix + 'A').uriFor(longOwner);
  const b = f.exports.createPhotoFileAdapter(prefix + 'B').uriFor(longOwner);
  const shorter = f.exports.createPhotoFileAdapter(prefix).uriFor(longOwner);
  assert.notEqual(a, b);
  assert.notEqual(a, shorter);
  for (const uri of [a, b, shorter]) {
    const parts = uri.split('/').filter(Boolean);
    assert.ok(parts.includes('family-end'));
    assert.ok(parts.includes('files'));
    assert.ok(parts.every((part) => Buffer.byteLength(part) <= 100));
    assert.ok(parts.some((part) => part.startsWith('f-')));
    assert.ok(parts.some((part) => part.startsWith('o-')));
  }
  for (const invalid of [
    '',
    '.',
    '..',
    '../family',
    'family/other',
    'family\\other',
    'raw 非ASCII',
  ]) {
    assert.throws(() => f.exports.createPhotoFileAdapter(invalid), /family/);
  }
  assert.throws(() => f.adapter.uriFor({ ...photo, fileName: '../another.png' }));
});
