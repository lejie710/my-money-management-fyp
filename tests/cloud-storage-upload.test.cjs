const test = require('node:test');
const assert = require('node:assert/strict');
const { createStorageUploader, MAX_RESPONSE_BYTES } = require('../src/cloud/storageUpload');
const { sha256Hex } = require('../src/cloud/hash');
const { utf8, decodeUtf8 } = require('../src/cloud/backupFormat');
const owner = { projectId: 'demo-money-backup', uid: 'synthetic-user' };
const configuration = {
  mode: 'emulator',
  firebase: {
    projectId: owner.projectId,
    apiKey: 'demo-only-key',
    appId: 'demo-app',
    authDomain: 'demo-money-backup.firebaseapp.com',
    storageBucket: 'demo-money-backup.appspot.com',
  },
  emulators: { auth: 19099, firestore: 18080, storage: 19199 },
};
const path = 'users/synthetic-user/walletBackups/backup-native-0123456789abcdef/snapshot.json';
const bytes = utf8('{"title":"Coffee","amount":1250}');
const metadata = { contentType: 'application/json', sha256: sha256Hex(bytes) };
function response(url, overrides = {}, resultChanges = {}) {
  const raw = utf8(
    JSON.stringify({
      name: path,
      bucket: configuration.firebase.storageBucket,
      size: String(bytes.length),
      contentType: metadata.contentType,
      metadata: { sha256: metadata.sha256 },
      ...resultChanges,
    }),
  );
  let sent = false;
  return {
    status: 200,
    url,
    redirected: false,
    headers: { get: () => String(raw.length) },
    body: {
      getReader() {
        return {
          async read() {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: raw };
          },
          cancel() {
            return Promise.resolve();
          },
          releaseLock() {},
        };
      },
      cancel() {
        return Promise.resolve();
      },
    },
    ...overrides,
  };
}
function setup(options = {}) {
  const requests = [];
  const upload = createStorageUploader({
    configuration,
    owner,
    getToken: async () => 'synthetic.token.value',
    assertCurrent() {},
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return response(url);
    },
    ...options,
  });
  return { upload, requests };
}
test('native upload uses Uint8Array multipart with exact bytes and no Blob constructor', async () => {
  const OriginalBlob = globalThis.Blob;
  globalThis.Blob = class {
    constructor() {
      throw Error('RN Blob ArrayBuffer unsupported');
    }
  };
  try {
    const { upload, requests } = setup();
    await upload(path, bytes, metadata);
    assert.equal(requests.length, 1);
    const { url, init } = requests[0];
    assert.equal(new URL(url).origin, 'http://127.0.0.1:19199');
    assert.equal(new URL(url).searchParams.get('name'), path);
    assert.ok(init.body instanceof Uint8Array);
    assert.equal(init.headers.Authorization, 'Firebase synthetic.token.value');
    assert.equal(init.headers['X-Goog-Upload-Protocol'], 'multipart');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    const text = decodeUtf8(init.body),
      boundary = init.headers['Content-Type'].split('boundary=')[1];
    assert.ok(text.includes('"metadata":{"sha256":"' + metadata.sha256 + '"}'));
    assert.ok(text.includes('\r\n\r\n' + decodeUtf8(bytes) + '\r\n--' + boundary + '--'));
  } finally {
    globalThis.Blob = OriginalBlob;
  }
});
test('hosted endpoint is fixed official HTTPS and malformed or foreign paths dispatch nothing', async () => {
  const hosted = {
    mode: 'hosted',
    firebase: { ...configuration.firebase, projectId: 'example-money-project' },
  };
  const { upload, requests } = setup({
    configuration: hosted,
    owner: { ...owner, projectId: 'example-money-project' },
  });
  await upload(path, bytes, metadata);
  assert.equal(new URL(requests[0].url).origin, 'https://firebasestorage.googleapis.com');
  for (const name of [
    path.replace('synthetic-user', 'other-user'),
    path + '/extra',
    'https://example.invalid/' + path,
    path.replace('snapshot.json', '../snapshot.json'),
  ])
    await assert.rejects(upload(name, bytes, metadata), /not confirmed/);
  assert.equal(requests.length, 1);
});
test('invalid size, type, digest and photo path/hash mismatches never dispatch', async () => {
  const { upload, requests } = setup();
  await assert.rejects(upload(path, new Uint8Array(), metadata));
  const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
  await assert.rejects(upload(path, oversized, { ...metadata, sha256: sha256Hex(oversized) }));
  const oversizedPhoto = new Uint8Array(10 * 1024 * 1024 + 1);
  const photoHash = sha256Hex(oversizedPhoto);
  await assert.rejects(
    upload(path.replace('snapshot.json', 'photos/' + photoHash), oversizedPhoto, {
      contentType: 'image/png',
      sha256: photoHash,
    }),
  );
  await assert.rejects(upload(path, bytes, { ...metadata, contentType: 'text/plain' }));
  await assert.rejects(upload(path, bytes, { ...metadata, sha256: '0'.repeat(64) }));
  await assert.rejects(
    upload(path.replace('snapshot.json', 'photos/' + '0'.repeat(64)), bytes, {
      ...metadata,
      contentType: 'image/png',
    }),
  );
  assert.equal(requests.length, 0);
});
test('current owner is rechecked after asynchronous token lookup and before dispatch', async () => {
  let current = true;
  const { upload, requests } = setup({
    getToken: async () => {
      current = false;
      return 'token';
    },
    assertCurrent() {
      if (!current) throw Error('changed owner');
    },
  });
  await assert.rejects(upload(path, bytes, metadata), /not confirmed/);
  assert.equal(requests.length, 0);
});
test('cancellation before dispatch or while waiting aborts native request and retains generic errors', async () => {
  const stopped = new AbortController();
  stopped.abort();
  const first = setup();
  await assert.rejects(first.upload(path, bytes, metadata, stopped.signal));
  assert.equal(first.requests.length, 0);
  const caller = new AbortController();
  let requestSignal;
  const second = setup({
    fetchImpl: async (url, init) => {
      requestSignal = init.signal;
      caller.abort();
      throw Error('private credential in a provider error');
    },
  });
  await assert.rejects(
    second.upload(path, bytes, metadata, caller.signal),
    (error) => !error.message.includes('credential') && /not confirmed/.test(error.message),
  );
  assert.equal(requestSignal.aborted, true);
});
test('timeout aborts a stalled fetch without waiting for provider settlement', async () => {
  let signal;
  const { upload } = setup({
    timeoutMs: 15,
    fetchImpl: async (url, init) => {
      signal = init.signal;
      return new Promise(() => {});
    },
  });
  await assert.rejects(upload(path, bytes, metadata), /not confirmed/);
  assert.equal(signal.aborted, true);
});
test('late fetch bodies are cancelled after caller cancellation', async () => {
  const caller = new AbortController();
  let resolve,
    cancelled = 0,
    started;
  const ready = new Promise((done) => {
    started = done;
  });
  const { upload } = setup({
    fetchImpl: (url) => {
      started();
      return new Promise((done) => {
        resolve = () =>
          done(
            response(url, {
              body: {
                cancel() {
                  cancelled++;
                  return Promise.resolve();
                },
              },
            }),
          );
      });
    },
  });
  const work = upload(path, bytes, metadata, caller.signal);
  await ready;
  caller.abort();
  await assert.rejects(work);
  resolve();
  await new Promise((done) => setImmediate(done));
  assert.equal(cancelled, 1);
});
test('redirects, error payloads and mismatched response ownership remain generic', async () => {
  for (const override of [
    { status: 403 },
    { redirected: true },
    { url: 'https://example.invalid/secret' },
    {
      body: {
        getReader() {
          return {
            async read() {
              return { done: false, value: utf8('secret-provider-response') };
            },
            cancel() {
              return Promise.resolve();
            },
            releaseLock() {},
          };
        },
      },
    },
  ]) {
    const { upload } = setup({ fetchImpl: async (url) => response(url, override) });
    await assert.rejects(
      upload(path, bytes, metadata),
      (error) => /not confirmed/.test(error.message) && !error.message.includes('secret'),
    );
  }
});
test('response byte, empty chunk, and monotonic-time limits terminate hostile streams', async () => {
  for (const mode of ['oversize', 'empty', 'late']) {
    let clock = 0,
      reads = 0,
      cancelled = 0;
    const { upload } = setup({
      now: () => clock,
      fetchImpl: async (url) =>
        response(url, {
          headers: { get: () => null },
          body: {
            getReader() {
              return {
                async read() {
                  reads++;
                  if (mode === 'late') clock = 40001;
                  return {
                    done: false,
                    value:
                      mode === 'oversize'
                        ? new Uint8Array(MAX_RESPONSE_BYTES + 1)
                        : new Uint8Array(),
                  };
                },
                cancel() {
                  cancelled++;
                  return Promise.resolve();
                },
                releaseLock() {},
              };
            },
          },
        }),
    });
    await assert.rejects(upload(path, bytes, metadata));
    assert.ok(reads <= 33);
    assert.equal(cancelled, 1);
  }
});
test('synchronous fetch failure and stalled token lookup never expose provider errors', async () => {
  const broken = setup({
    fetchImpl: () => {
      throw Error('secret-token');
    },
  });
  await assert.rejects(
    broken.upload(path, bytes, metadata),
    (error) => !error.message.includes('secret-token'),
  );
  const waiting = setup({ timeoutMs: 15, getToken: () => new Promise(() => {}) });
  await assert.rejects(waiting.upload(path, bytes, metadata));
  assert.equal(waiting.requests.length, 0);
});

test('binary photo bytes survive multipart assembly without UTF-8 conversion', async () => {
  const binary = new Uint8Array([0, 255, 137, 80, 78, 71, 128, 13, 10, 0, 254]);
  const hash = sha256Hex(binary),
    target = path.replace('snapshot.json', 'photos/' + hash);
  const meta = { contentType: 'image/png', sha256: hash };
  let sentBody;
  const { upload } = setup({
    fetchImpl: async (url, init) => {
      sentBody = init.body;
      const raw = utf8(
        JSON.stringify({
          name: target,
          bucket: configuration.firebase.storageBucket,
          size: String(binary.length),
          contentType: meta.contentType,
          metadata: { sha256: hash },
        }),
      );
      let sent = false;
      return response(url, {
        headers: { get: () => String(raw.length) },
        body: {
          getReader() {
            return {
              async read() {
                if (sent) return { done: true };
                sent = true;
                return { done: false, value: raw };
              },
              cancel() {
                return Promise.resolve();
              },
              releaseLock() {},
            };
          },
        },
      });
    },
  });
  await upload(target, binary, meta);
  const at = Buffer.from(sentBody).indexOf(Buffer.from(binary));
  assert.ok(at > 0);
  assert.deepEqual(sentBody.slice(at, at + binary.length), binary);
});

test('a successful HTTP response must acknowledge the exact object, bucket, size, type and digest', async () => {
  for (const change of [
    { name: path.replace('synthetic-user', 'other-user') },
    { bucket: 'other-project.appspot.com' },
    { size: String(bytes.length + 1) },
    { contentType: 'text/plain' },
    { metadata: { sha256: '0'.repeat(64) } },
  ]) {
    const { upload } = setup({ fetchImpl: async (url) => response(url, {}, change) });
    await assert.rejects(upload(path, bytes, metadata), /not confirmed/);
  }
});
