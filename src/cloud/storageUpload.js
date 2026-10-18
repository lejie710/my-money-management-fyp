// Firebase Storage multipart protocol over native byte-capable fetch, without Blob creation.
const { validateCloudConfiguration } = require('./config');
const { cloudOwner, utf8, decodeUtf8, MAX_SNAPSHOT_BYTES } = require('./backupFormat');
const { sha256Hex } = require('./hash');
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const failure = () =>
  new Error(
    'Cloud photo or snapshot upload was not confirmed. Reconcile the pending backup before retrying.',
  );
function createStorageUploader({
  configuration,
  owner,
  fetchImpl,
  getToken,
  assertCurrent,
  timeoutMs = 40000,
  now = () => performance.now(),
}) {
  const config = validateCloudConfiguration(configuration);
  owner = cloudOwner(owner);
  if (
    owner.projectId !== config.firebase.projectId ||
    [fetchImpl, getToken, assertCurrent, now].some((fn) => typeof fn !== 'function') ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > 45000
  )
    throw failure();
  const origin =
    config.mode === 'emulator'
      ? `http://127.0.0.1:${config.emulators.storage}`
      : 'https://firebasestorage.googleapis.com';
  const bucket = config.firebase.storageBucket;
  return async function upload(path, bytes, metadata, signal) {
    const prefix = `users/${owner.uid}/walletBackups/`;
    if (typeof path !== 'string' || !path.startsWith(prefix)) throw failure();
    const relative = path.slice(prefix.length),
      match = /^(backup-[a-z0-9-]{16,96})\/(snapshot\.json|photos\/([a-f0-9]{64}))$/.exec(relative);
    if (
      !match ||
      !(bytes instanceof Uint8Array) ||
      !metadata ||
      Object.keys(metadata).sort().join(',') !== 'contentType,sha256' ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
      sha256Hex(bytes) !== metadata.sha256
    )
      throw failure();
    const snapshot = match[2] === 'snapshot.json';
    if (
      !bytes.length ||
      bytes.length > (snapshot ? MAX_SNAPSHOT_BYTES : MAX_PHOTO_BYTES) ||
      (snapshot
        ? metadata.contentType !== 'application/json'
        : !['image/png', 'image/jpeg', 'image/webp'].includes(metadata.contentType) ||
          match[3] !== metadata.sha256)
    )
      throw failure();
    const captured = new Uint8Array(bytes);
    const boundary = 'mymoney-' + metadata.sha256;
    const intro = utf8(
      `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify({ name: path, contentType: metadata.contentType, metadata: { sha256: metadata.sha256 } })}\r\n--${boundary}\r\nContent-Type: ${metadata.contentType}\r\n\r\n`,
    );
    const tail = utf8(`\r\n--${boundary}--`);
    const body = new Uint8Array(intro.length + captured.length + tail.length);
    body.set(intro);
    body.set(captured, intro.length);
    body.set(tail, intro.length + captured.length);
    const url = `${origin}/v0/b/${encodeURIComponent(bucket)}/o?name=${encodeURIComponent(path)}`;
    const abort = new AbortController();
    let timer, onAbort, reader, response, rejectAbort;
    const started = now();
    let last = started;
    const check = () => {
      const elapsed = now();
      if (
        !Number.isFinite(elapsed) ||
        !Number.isFinite(started) ||
        elapsed < last ||
        elapsed - started >= timeoutMs ||
        signal?.aborted ||
        abort.signal.aborted
      )
        throw failure();
      last = elapsed;
      assertCurrent();
    };
    const stopped = new Promise((_, reject) => {
      rejectAbort = reject;
    });
    const stop = () => {
      abort.abort();
      rejectAbort(failure());
    };
    const wait = async (promise) => {
      const value = await Promise.race([promise, stopped]);
      check();
      return value;
    };
    try {
      check();
      onAbort = stop;
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(stop, timeoutMs);
      const token = await wait(
        Promise.resolve().then(() => {
          check();
          return getToken();
        }),
      );
      if (typeof token !== 'string' || token.length > 16384 || !/^[A-Za-z0-9._-]+$/.test(token))
        throw failure();
      check();
      const request = Promise.resolve().then(() => {
        check();
        return fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: 'Firebase ' + token,
            'X-Goog-Upload-Protocol': 'multipart',
            'Content-Type': 'multipart/related; boundary=' + boundary,
          },
          body,
          signal: abort.signal,
          redirect: 'error',
          credentials: 'omit',
        });
      });
      request.then(
        (value) => {
          if (abort.signal.aborted) {
            try {
              Promise.resolve(value?.body?.cancel()).catch(() => {});
            } catch {}
          }
        },
        () => {},
      );
      response = await wait(request);
      if (
        !response ||
        response.status !== 200 ||
        response.redirected ||
        typeof response.url !== 'string'
      )
        throw failure();
      const actual = new URL(response.url),
        expected = new URL(url);
      if (
        actual.origin !== expected.origin ||
        actual.pathname !== expected.pathname ||
        actual.searchParams.get('name') !== path ||
        [...actual.searchParams.keys()].some((key) => key !== 'name')
      )
        throw failure();
      const declared = response.headers?.get('content-length');
      if (
        declared !== null &&
        declared !== undefined &&
        (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
      )
        throw failure();
      reader = response.body?.getReader();
      if (!reader) throw failure();
      const chunks = [];
      let length = 0,
        count = 0,
        empty = 0;
      while (true) {
        check();
        const row = await wait(reader.read());
        if (row.done) break;
        if (++count > 4096 || !(row.value instanceof Uint8Array)) throw failure();
        if (!row.value.length) {
          if (++empty > 32) throw failure();
          continue;
        }
        length += row.value.length;
        if (length > MAX_RESPONSE_BYTES) throw failure();
        chunks.push(row.value);
      }
      const encoded = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        encoded.set(chunk, offset);
        offset += chunk.length;
      }
      const result = JSON.parse(decodeUtf8(encoded));
      check();
      if (
        !result ||
        result.name !== path ||
        result.bucket !== bucket ||
        Number(result.size) !== captured.length ||
        result.contentType !== metadata.contentType ||
        result.metadata?.sha256 !== metadata.sha256
      )
        throw failure();
      check();
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      abort.abort();
      try {
        Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {});
      } catch {}
      try {
        reader?.releaseLock();
      } catch {}
    }
  };
}
module.exports = { createStorageUploader, MAX_RESPONSE_BYTES };
