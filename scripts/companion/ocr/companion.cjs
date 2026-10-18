const http = require('node:http'),
  crypto = require('node:crypto');
const { inspectImageHeader, MAX_PHOTO_BYTES } = require('../../../src/attachments/imageHeader');
const { validateOcrResult } = require('../../../src/core/receipt');
const { createWindowsOcrWorker, ReceiptServiceError, messages } = require('./windowsWorker.cjs');
const { validateProviders, PROVIDER_HEADER } = require('../../../src/companion/providerContract');
const { VisionReceiptError } = require('./googleVisionWorker.cjs');
const LEGACY_OCR = Object.freeze({
  engine: 'windows-media-ocr',
  processing: 'local',
  maxImageBytes: MAX_PHOTO_BYTES,
});
const MAX_RESPONSE_BYTES = 1024 * 1024;
function createReceiptCompanion({
  worker = createWindowsOcrWorker(),
  provider = LEGACY_OCR,
  binding = null,
  token = crypto.randomBytes(32).toString('base64url'),
  requestTimeoutMs = 45000,
  uploadTimeoutMs = 15000,
  routes = [],
} = {}) {
  provider =
    provider === null
      ? null
      : validateProviders({ ocr: provider, assistant: null, forecast: null }).ocr;
  if (binding !== null && (typeof binding !== 'string' || binding.length > 2048))
    throw new Error('Invalid OCR provider binding.');
  if (provider?.processing === 'cloud' && binding === null)
    throw new Error('Cloud OCR requires a paired provider binding.');
  if (provider && typeof worker?.recognize !== 'function')
    throw new Error('The selected OCR worker is unavailable.');
  const imageLimit = provider?.maxImageBytes ?? MAX_PHOTO_BYTES;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(token))
    throw new Error('Use a per-run random receipt token.');
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 50 ||
    requestTimeoutMs > 60000 ||
    !Number.isInteger(uploadTimeoutMs) ||
    uploadTimeoutMs < 50 ||
    uploadTimeoutMs > requestTimeoutMs
  )
    throw new Error('Use bounded receipt timeouts.');
  if (
    !Array.isArray(routes) ||
    routes.some(
      (route) =>
        !route ||
        !['GET', 'POST'].includes(route.method) ||
        typeof route.path !== 'string' ||
        !/^\/v1\/[a-z][a-z0-9/-]*$/.test(route.path) ||
        route.path === '/v1/recognize' ||
        typeof route.handle !== 'function' ||
        (route.close !== undefined && typeof route.close !== 'function'),
    ) ||
    new Set(routes.map((route) => `${route.method} ${route.path}`)).size !== routes.length
  )
    throw new Error('Provide distinct owned companion routes.');
  const routed = routes.map((route) => ({ ...route })),
    routeTasks = new Set();
  let busy = false,
    active = null,
    finishing = null,
    closing = false,
    closePromise = null;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Connection', 'close');
    const send = (status, code, message) => {
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        const body = JSON.stringify({ version: 1, error: { code, message } });
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
      }
    };
    const authorization = req.headers.authorization,
      expected = `Bearer ${token}`;
    if (
      typeof authorization !== 'string' ||
      Buffer.byteLength(authorization) !== Buffer.byteLength(expected) ||
      !crypto.timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
    ) {
      send(401, 'UNAUTHORIZED', 'The local receipt connection needs its current session token.');
      req.resume();
      return;
    }
    if (req.headers.origin !== undefined) {
      send(403, 'BAD_REQUEST', 'Browser-origin receipt requests are not enabled.');
      req.resume();
      return;
    }
    if (closing) {
      send(
        503,
        'OCR_UNAVAILABLE',
        'The local companion is stopping. Reconnect after it starts again.',
      );
      req.resume();
      return;
    }
    const extraRoute = routed.find(
      (route) => route.method === req.method && route.path === req.url,
    );
    if (extraRoute) {
      // All extension effects stay behind the same public token/origin boundary.
      const task = Promise.resolve()
        .then(() => {
          if (closing) {
            send(503, 'OCR_UNAVAILABLE', 'The local companion is stopping.');
            req.resume();
            return;
          }
          return extraRoute.handle(req, res);
        })
        .catch(() => {
          send(503, 'COMPANION_FAILED', 'The local companion request could not be completed.');
          req.resume();
        });
      routeTasks.add(task);
      try {
        await task;
      } finally {
        routeTasks.delete(task);
      }
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/recognize') {
      send(404, 'BAD_REQUEST', 'Use the local receipt recognition endpoint.');
      req.resume();
      return;
    }
    if (!provider) {
      send(503, 'OCR_UNAVAILABLE', 'No receipt recognition provider is configured.');
      req.resume();
      return;
    }
    if (
      (binding === null && req.headers[PROVIDER_HEADER] !== undefined) ||
      (binding !== null && req.headers[PROVIDER_HEADER] !== binding)
    ) {
      send(409, 'PROVIDER_MISMATCH', 'The receipt provider changed. Pair the companion again.');
      req.resume();
      return;
    }
    if (worker.hasUnconfirmedProcess?.()) {
      send(503, 'WORKER_UNCONFIRMED', messages.WORKER_UNCONFIRMED);
      req.resume();
      return;
    }
    if (busy) {
      send(429, 'BUSY', 'Another receipt is being recognized. Wait before trying again.');
      req.resume();
      return;
    }
    const mime = req.headers['content-type'];
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
      send(415, 'IMAGE_TYPE', 'Choose a static JPEG, PNG or WebP image.');
      req.resume();
      return;
    }
    const contentLength = req.headers['content-length'];
    if (
      contentLength !== undefined &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) > imageLimit)
    ) {
      send(
        413,
        provider.processing === 'cloud' ? 'CLOUD_TOO_LARGE' : 'TOO_LARGE',
        provider.processing === 'cloud'
          ? 'Google Cloud Vision accepts images up to 6 MiB.'
          : messages.TOO_LARGE,
      );
      req.resume();
      return;
    }
    busy = true;
    let finish;
    finishing = new Promise((resolve) => {
      finish = resolve;
    });
    const abort = new AbortController();
    active = abort;
    let total = 0;
    const chunks = [];
    const timer = setTimeout(() => {
      abort.abort();
      send(504, 'TIMEOUT', messages.TIMEOUT);
    }, requestTimeoutMs);
    const uploadTimer = setTimeout(() => {
      abort.abort();
      send(408, 'TIMEOUT', 'The receipt upload did not finish in time.');
      req.destroy();
    }, uploadTimeoutMs);
    const disconnected = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.once('close', disconnected);
    try {
      for await (const chunk of req) {
        if (abort.signal.aborted) throw new ReceiptServiceError('CANCELLED', messages.CANCELLED);
        total += chunk.length;
        if (total > imageLimit) throw new ReceiptServiceError('TOO_LARGE', messages.TOO_LARGE);
        chunks.push(chunk);
      }
      clearTimeout(uploadTimer);
      if (abort.signal.aborted) throw new ReceiptServiceError('CANCELLED', messages.CANCELLED);
      const bytes = Buffer.concat(chunks, total);
      let info;
      try {
        info = inspectImageHeader(bytes);
      } catch {
        throw new ReceiptServiceError('IMAGE_INVALID', messages.IMAGE_INVALID);
      }
      if (info.mimeType !== mime)
        throw new ReceiptServiceError(
          'IMAGE_TYPE',
          'The image bytes do not match their declared type.',
        );
      const output = validateOcrResult(await worker.recognize(bytes, { signal: abort.signal }));
      if (
        output.provider !== provider.engine ||
        output.width !== info.width ||
        output.height !== info.height
      )
        throw new ReceiptServiceError('OCR_FAILED', messages.OCR_FAILED);
      if (abort.signal.aborted) throw new ReceiptServiceError('CANCELLED', messages.CANCELLED);
      const body = JSON.stringify({
        version: 1,
        ocr: output,
        ...(binding === null ? {} : { providerBinding: binding }),
      });
      if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES)
        throw new ReceiptServiceError('OCR_FAILED', messages.OCR_FAILED);
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
      }
    } catch (failure) {
      if (failure instanceof VisionReceiptError) {
        const mapped =
          {
            CONFIGURATION: 'OCR_UNAVAILABLE',
            IMAGE_INVALID: 'IMAGE_INVALID',
            TOO_LARGE: 'CLOUD_TOO_LARGE',
            TIMEOUT: 'TIMEOUT',
            CANCELLED: 'CANCELLED',
            PROVIDER_FAILED: 'PROVIDER_FAILED',
            RESPONSE_INVALID: 'OCR_FAILED',
            RESPONSE_TOO_LARGE: 'OCR_FAILED',
          }[failure.code] || 'OCR_FAILED';
        send(
          mapped === 'CLOUD_TOO_LARGE'
            ? 413
            : mapped === 'TIMEOUT'
              ? 504
              : mapped === 'CANCELLED'
                ? 499
                : 503,
          mapped,
          'The selected recognition request could not be completed. Review the connection or use manual entry.',
        );
      } else {
        const allowed = [
            'TOO_LARGE',
            'IMAGE_INVALID',
            'IMAGE_TYPE',
            'IMAGE_DIMENSIONS',
            'TIMEOUT',
            'CANCELLED',
            'OCR_FAILED',
            'OCR_UNAVAILABLE',
            'WORKER_UNCONFIRMED',
          ],
          code =
            failure instanceof ReceiptServiceError && allowed.includes(failure.code)
              ? failure.code
              : 'OCR_FAILED';
        send(
          code === 'TOO_LARGE'
            ? 413
            : code === 'IMAGE_INVALID' || code === 'IMAGE_TYPE' || code === 'IMAGE_DIMENSIONS'
              ? 422
              : code === 'TIMEOUT'
                ? 504
                : code === 'CANCELLED'
                  ? 499
                  : 503,
          code === 'TOO_LARGE' && provider.processing === 'cloud' ? 'CLOUD_TOO_LARGE' : code,
          code === 'TOO_LARGE' && provider.processing === 'cloud'
            ? 'Google Cloud Vision accepts images up to 6 MiB.'
            : code === 'IMAGE_TYPE'
              ? 'The image bytes do not match their declared type.'
              : messages[code],
        );
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(uploadTimer);
      res.off('close', disconnected);
      busy = false;
      active = null;
      finish();
      finishing = null;
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 16;
  server.maxConnections = 4;
  return {
    async listen(port = 8790) {
      if (closing) throw new Error('A closed companion cannot be restarted.');
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error('Choose a valid loopback port.');
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      return {
        version: 1,
        url: `http://127.0.0.1:${server.address().port}/v1/recognize`,
        token,
        pid: process.pid,
      };
    },
    close() {
      if (closePromise) return closePromise.then(() => worker?.drain?.());
      closing = true;
      closePromise = (async () => {
        const done = finishing;
        active?.abort();
        const stopped = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        // Route-owned cancellation/drain runs before waiting for their responses/server close.
        const cleanup = await Promise.allSettled(
          [...new Set(routed.map((route) => route.close).filter(Boolean))].map((close) =>
            Promise.resolve().then(() => close()),
          ),
        );
        await Promise.allSettled([...routeTasks]);
        if (done) await done;
        await stopped;
        if (cleanup.some((outcome) => outcome.status === 'rejected'))
          throw new Error('Companion route cleanup could not be confirmed.');
      })();
      return closePromise.then(() => worker?.drain?.());
    },
  };
}
module.exports = { createReceiptCompanion, MAX_RESPONSE_BYTES };
