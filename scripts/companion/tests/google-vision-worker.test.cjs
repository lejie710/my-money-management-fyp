const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const realFetch = globalThis.fetch;
let unexpectedNetwork = 0;
globalThis.fetch = () => {
  unexpectedNetwork++;
  throw Error('Real fetch is forbidden in this offline suite.');
};
after(() => {
  globalThis.fetch = realFetch;
  assert.equal(unexpectedNetwork, 0);
});
const {
  ENDPOINT,
  LIMITS,
  VisionReceiptError,
  normalizeVisionResponse,
  createGoogleVisionWorker,
} = require('../ocr/googleVisionWorker.cjs');
const source = path.resolve(__dirname, '../../..');
const { inspectImageHeader } = require(path.join(source, 'src/attachments/imageHeader.js'));
const png = fs.readFileSync(path.join(source, 'tests/fixtures/images/receipt-a.png'));
const size = { width: 1100, height: 900 };
const credential = 'synthetic-offline-credential';
const clone = (value) => JSON.parse(JSON.stringify(value));
const polygon = [{}, { x: 200 }, { x: 200, y: 30 }, { y: 30 }];
function word(text, options = {}) {
  return {
    symbols: [...text].map((text) => ({ text })),
    boundingBox: { vertices: polygon },
    ...options,
  };
}
function document(words = [word('TOTAL'), word('12.50')], pageExtra = {}) {
  return {
    responses: [
      {
        fullTextAnnotation: {
          pages: [{ ...size, blocks: [{ paragraphs: [{ words }] }], ...pageExtra }],
          text: words.length ? 'TOTAL 12.50' : '',
        },
      },
    ],
  };
}
function response(payload = document(), options = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...options,
  });
}
function worker(fetchImpl, options = {}) {
  return createGoogleVisionWorker({
    apiKey: credential,
    inspectImageHeader,
    fetchImpl,
    ...options,
  });
}
function code(expected) {
  return (error) =>
    error instanceof VisionReceiptError &&
    error.code === expected &&
    !error.message.includes(credential) &&
    !error.message.includes('PRIVATE_PROVIDER_DETAIL');
}

test('import and configuration never call a provider; missing or malformed credentials fail closed', () => {
  for (const apiKey of [undefined, '', 'short', credential + '\r\nheader: value'])
    assert.throws(
      () => createGoogleVisionWorker({ apiKey, inspectImageHeader }),
      code('CONFIGURATION'),
    );
  assert.throws(() => createGoogleVisionWorker({ apiKey: credential }), code('CONFIGURATION'));
  createGoogleVisionWorker({ apiKey: credential, inspectImageHeader });
  assert.equal(unexpectedNetwork, 0);
});

test('only an explicit call uploads captured image bytes to the fixed HTTPS endpoint with a header credential', async () => {
  const calls = [];
  const engine = worker(async (url, options) => {
    calls.push({ url, options });
    return response();
  });
  assert.deepEqual(calls, []);
  const result = await engine.recognize(png);
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, ENDPOINT);
  assert.equal(new URL(url).search, '');
  assert.equal(options.headers['x-goog-api-key'], credential);
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  const request = JSON.parse(options.body);
  assert.deepEqual(request.requests[0].features, [{ type: 'DOCUMENT_TEXT_DETECTION' }]);
  assert.deepEqual(Buffer.from(request.requests[0].image.content, 'base64'), png);
  assert.equal(request.requests[0].image.source, undefined);
  assert.equal(result.provider, 'google-cloud-vision');
  assert.equal(result.language, 'und');
  assert.equal(result.textAngle, null);
  assert.ok(Object.isFrozen(result.words[0].bounds));
});

test('input mutation after submission cannot change the captured request', async () => {
  const input = Buffer.from(png);
  let resolve, submitted;
  const pendingResponse = new Promise((done) => {
    resolve = done;
  });
  const engine = worker(async (_, options) => {
    submitted = JSON.parse(options.body);
    return pendingResponse;
  });
  const pending = engine.recognize(input);
  input.fill(0);
  resolve(response());
  await pending;
  assert.deepEqual(Buffer.from(submitted.requests[0].image.content, 'base64'), png);
});

test('invalid and oversize images are refused without any upload', async () => {
  let calls = 0;
  const engine = worker(async () => {
    calls++;
    throw Error('Forbidden');
  });
  for (const image of [
    undefined,
    'file.png',
    new Uint8Array(),
    Buffer.from('GIF89a'),
    png.subarray(0, 24),
  ])
    await assert.rejects(engine.recognize(image), code('IMAGE_INVALID'));
  await assert.rejects(engine.recognize(Buffer.alloc(LIMITS.imageBytes + 1)), code('TOO_LARGE'));
  assert.equal(calls, 0);
});

test('normalization retains Unicode, omitted zero coordinates, rotation polygon and real confidence', () => {
  const shape = [
    { x: 10, y: 20 },
    { x: 100, y: 25 },
    { x: 96, y: 40 },
    { x: 7, y: 35 },
  ];
  const payload = document(
    [
      word('午餐', { confidence: 0.91 }),
      word('RM12.50', { boundingBox: { vertices: shape }, confidence: 0 }),
      word('Unknown'),
    ],
    {
      confidence: 0.8,
      property: {
        detectedLanguages: [{ languageCode: 'zh-Hans', confidence: 0.7 }],
      },
    },
  );
  const actual = normalizeVisionResponse(payload, size, 50);
  assert.equal(actual.words[0].text, '午餐');
  assert.deepEqual(actual.words[0].bounds, {
    x: 0,
    y: 0,
    width: 200,
    height: 30,
  });
  assert.deepEqual(actual.words[1].polygon, shape);
  assert.deepEqual(actual.words[1].bounds, {
    x: 7,
    y: 20,
    width: 93,
    height: 20,
  });
  assert.deepEqual(
    actual.words.map((word) => word.confidence),
    [0.91, 0, null],
  );
  assert.equal(actual.pageConfidence, 0.8);
  assert.equal(actual.language, 'zh-Hans');
  assert.equal(actual.textAngle, null);
  assert.equal(actual.title, undefined);
  assert.equal(actual.total, undefined);
});

test('normalized polygons convert to pixel bounds without inventing a missing page language', () => {
  const payload = document([
    word('Text', {
      boundingBox: {
        normalizedVertices: [{}, { x: 0.5 }, { x: 0.5, y: 0.1 }, { y: 0.1 }],
      },
    }),
  ]);
  const actual = normalizeVisionResponse(payload, size, 0);
  assert.deepEqual(actual.words[0].bounds, {
    x: 0,
    y: 0,
    width: 550,
    height: 90,
  });
  assert.equal(actual.language, 'und');
  assert.deepEqual(actual.detectedLanguages, []);
});

test('blank results remain empty without defaults or fabricated receipt fields', async () => {
  for (const payload of [
    { responses: [{}] },
    document([]),
    { responses: [{ fullTextAnnotation: {} }] },
  ]) {
    const actual = await worker(async () => response(payload)).recognize(png);
    assert.deepEqual(actual.words, []);
    assert.equal(actual.title, undefined);
    assert.equal(actual.date, undefined);
    assert.equal(actual.total, undefined);
  }
});

test('partial errors, missing document geometry and multiple-page responses are never accepted as blank receipts', () => {
  const partial = document();
  partial.responses[0].error = { code: 13, message: 'PRIVATE_PROVIDER_DETAIL' };
  assert.throws(() => normalizeVisionResponse(partial, size, 1), code('PROVIDER_FAILED'));
  const missing = {
    responses: [{ textAnnotations: [{ description: 'PRIVATE_PROVIDER_DETAIL' }] }],
  };
  const many = document();
  many.responses[0].fullTextAnnotation.pages.push(
    clone(many.responses[0].fullTextAnnotation.pages[0]),
  );
  for (const payload of [
    missing,
    many,
    { responses: [] },
    {},
    { responses: [{ fullTextAnnotation: { text: 'Detected', pages: [] } }] },
  ])
    assert.throws(() => normalizeVisionResponse(payload, size, 1), code('RESPONSE_INVALID'));
});

test('an empty full annotation cannot mask nonempty fallback text without usable geometry', () => {
  for (const fullTextAnnotation of [{}, { pages: [] }, { text: '', pages: [] }])
    assert.throws(
      () =>
        normalizeVisionResponse(
          {
            responses: [
              {
                fullTextAnnotation,
                textAnnotations: [{ description: 'TOTAL 12.50' }],
              },
            ],
          },
          size,
          1,
        ),
      code('RESPONSE_INVALID'),
    );
  const withWords = document();
  withWords.responses[0].textAnnotations = [{ description: 'TOTAL 12.50' }];
  assert.equal(normalizeVisionResponse(withWords, size, 1).words.length, 2);
});

test('malformed coordinates, confidence, dimensions and excessive word/text counts fail rather than truncate', () => {
  const invalidWords = [
    word('x', { confidence: 2 }),
    word('x', { confidence: null }),
    word('x', {
      boundingBox: {
        vertices: [{ x: -1 }, { x: 2 }, { x: 2, y: 5 }, { y: 5 }],
      },
    }),
    word('x', { boundingBox: { vertices: [{}, {}, {}, {}] } }),
    word('x', {
      boundingBox: {
        normalizedVertices: [{}, { x: 2 }, { x: 2, y: 0.1 }, { y: 0.1 }],
      },
    }),
    word('x'.repeat(129)),
    word('bad\ntext'),
  ];
  for (const value of invalidWords)
    assert.throws(
      () => normalizeVisionResponse(document([value]), size, 1),
      code('RESPONSE_INVALID'),
    );
  assert.throws(
    () => normalizeVisionResponse(document([word('x')], { width: 1 }), size, 1),
    code('RESPONSE_INVALID'),
  );
  assert.throws(
    () => normalizeVisionResponse(document(Array.from({ length: 3001 }, () => word('x'))), size, 1),
    code('RESPONSE_INVALID'),
  );
  assert.throws(
    () =>
      normalizeVisionResponse(
        document(Array.from({ length: 301 }, () => word('x'.repeat(100)))),
        size,
        1,
      ),
    code('RESPONSE_INVALID'),
  );
});

test('HTTP, redirect, provider and network errors never expose raw details or credentials', async () => {
  for (const fetchImpl of [
    async () => response({ error: { message: credential } }, { status: 403 }),
    async () => {
      throw Error(credential + ' PRIVATE_PROVIDER_DETAIL');
    },
    async () => ({
      status: 200,
      redirected: true,
      url: 'https://example.invalid/redirect',
    }),
  ])
    await assert.rejects(worker(fetchImpl).recognize(png), code('PROVIDER_FAILED'));
});

test('response JSON, media type and stream bytes are validated under bounded reads', async () => {
  for (const reply of [
    new Response('PRIVATE_PROVIDER_DETAIL', {
      headers: { 'content-type': 'text/html' },
    }),
    new Response('{broken', {
      headers: { 'content-type': 'application/json' },
    }),
    new Response(new Uint8Array([255, 254]), {
      headers: { 'content-type': 'application/json' },
    }),
  ])
    await assert.rejects(worker(async () => reply).recognize(png), code('RESPONSE_INVALID'));
  for (const reply of [
    new Response('{}', {
      headers: {
        'content-type': 'application/json',
        'content-length': String(LIMITS.responseBytes + 1),
      },
    }),
    new Response(Buffer.alloc(LIMITS.responseBytes + 1, 32), {
      headers: { 'content-type': 'application/json' },
    }),
  ])
    await assert.rejects(worker(async () => reply).recognize(png), code('RESPONSE_TOO_LARGE'));
});

test('the deadline covers a provider that ignores abort and a stalled response stream', async () => {
  let signal,
    canceled = 0;
  await assert.rejects(
    worker(
      async (_, options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
      { timeoutMs: 20 },
    ).recognize(png),
    code('TIMEOUT'),
  );
  assert.equal(signal.aborted, true);
  const stream = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      canceled++;
    },
  });
  await assert.rejects(
    worker(
      async () =>
        new Response(stream, {
          headers: { 'content-type': 'application/json' },
        }),
      { timeoutMs: 20 },
    ).recognize(png),
    code('TIMEOUT'),
  );
  assert.equal(canceled, 1);
});

test('many empty or tiny chunks are bounded by work count even below the byte limit', async () => {
  for (const chunk of [new Uint8Array(), Buffer.from(' ')]) {
    let pulls = 0,
      canceled = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk);
      },
      cancel() {
        canceled++;
      },
    });
    await assert.rejects(
      worker(
        async () =>
          new Response(stream, {
            headers: { 'content-type': 'application/json' },
          }),
        { timeoutMs: 60000 },
      ).recognize(png),
      code('RESPONSE_TOO_LARGE'),
    );
    assert.ok(pulls <= LIMITS.responseChunks + 2);
    assert.equal(canceled, 1);
  }
});

test('ready fetch and read promises cannot publish success after the monotonic deadline', async () => {
  let clock = 0,
    fetchSignal;
  await assert.rejects(
    worker(
      async (_, options) => {
        fetchSignal = options.signal;
        clock = 11;
        return response();
      },
      { timeoutMs: 10, now: () => clock },
    ).recognize(png),
    code('TIMEOUT'),
  );
  assert.equal(fetchSignal.aborted, true);

  clock = 0;
  let reads = 0,
    canceled = 0,
    released = 0;
  const reply = {
    status: 200,
    url: ENDPOINT,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: {
      getReader() {
        return {
          async read() {
            reads++;
            clock = 11;
            return { done: false, value: Buffer.from('{"responses":[{}]}') };
          },
          async cancel() {
            canceled++;
          },
          releaseLock() {
            released++;
          },
        };
      },
    },
  };
  await assert.rejects(
    worker(async () => reply, { timeoutMs: 10, now: () => clock }).recognize(png),
    code('TIMEOUT'),
  );
  assert.equal(reads, 1);
  assert.ok(canceled >= 1);
  assert.equal(released, 1);
});

test('caller cancellation prevents initial upload and rejects late results without retrying', async () => {
  const before = new AbortController();
  before.abort();
  let calls = 0,
    resolve;
  const engine = worker(async () => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  await assert.rejects(engine.recognize(png, { signal: before.signal }), code('CANCELLED'));
  assert.equal(calls, 0);
  const active = new AbortController();
  const pending = engine.recognize(png, { signal: active.signal });
  active.abort();
  await assert.rejects(pending, code('CANCELLED'));
  resolve(response());
  await new Promise((done) => setImmediate(done));
  assert.equal(calls, 1);
});

test('late response bodies are canceled after timeout or caller cancellation even if fetch ignores abort', async () => {
  for (const reason of ['TIMEOUT', 'CANCELLED']) {
    let resolve,
      canceled = 0;
    const controller = new AbortController();
    const engine = worker(
      async () =>
        new Promise((done) => {
          resolve = done;
        }),
      { timeoutMs: 20 },
    );
    const pending = engine.recognize(png, { signal: controller.signal });
    if (reason === 'CANCELLED') controller.abort();
    await assert.rejects(pending, code(reason));
    const stream = new ReadableStream({
      cancel() {
        canceled++;
      },
    });
    resolve(new Response(stream, { headers: { 'content-type': 'application/json' } }));
    await new Promise((done) => setImmediate(done));
    assert.equal(canceled, 1);
  }
});

test('the Google provider identity and geometry survive the provider-aware mobile contract', () => {
  const { validateOcrResult } = require(path.join(source, 'src/core/receipt.js'));
  const actual = normalizeVisionResponse(document(), size, 1);
  const accepted = validateOcrResult(actual);
  assert.deepEqual(accepted, actual);
  assert.equal(accepted.geometry, 'axis-aligned-envelope-with-original-polygon');
  assert.throws(
    () => validateOcrResult({ ...actual, provider: 'unknown-provider' }),
    /OCR response/,
  );
  assert.equal(actual.provider, 'google-cloud-vision');
});
