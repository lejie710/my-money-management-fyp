const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  inspectImageHeader,
  ImageHeaderError,
  MAX_PHOTO_BYTES,
} = require('../src/attachments/imageHeader');

const ascii = (text) => Buffer.from(text, 'ascii');
const u32be = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
const u32le = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const u16be = (value) => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
};
function chunk(kind, data) {
  const body = Buffer.concat([ascii(kind), data]);
  return Buffer.concat([u32be(data.length), body, u32be(zlib.crc32(body))]);
}
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function png(width = 1, height = 1, options = {}) {
  const header = Buffer.concat([
    u32be(width),
    u32be(height),
    Buffer.from([options.depth ?? 8, options.color ?? 6, options.compression ?? 0, 0, 0]),
  ]);
  return Buffer.concat([
    pngSignature,
    chunk('IHDR', header),
    ...(options.before ?? []),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
    ...(options.after ?? []),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function segment(marker, data) {
  return Buffer.concat([Buffer.from([255, marker]), u16be(data.length + 2), data]);
}
function jpeg(width = 32, height = 24, marker = 0xc0, extra = []) {
  const frame = Buffer.concat([
    Buffer.from([8]),
    u16be(height),
    u16be(width),
    Buffer.from([1, 1, 0x11, 0]),
  ]);
  const scan = Buffer.from([1, 1, 0, 0, 63, 0]);
  return Buffer.concat([
    Buffer.from([255, 216]),
    ...extra,
    segment(marker, frame),
    segment(0xda, scan),
    Buffer.from([0x12, 0xff, 0, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9]),
  ]);
}
function riffChunk(kind, payload) {
  return Buffer.concat([
    ascii(kind),
    u32le(payload.length),
    payload,
    ...(payload.length % 2 ? [Buffer.from([0])] : []),
  ]);
}
function webp(...chunks) {
  const body = Buffer.concat([ascii('WEBP'), ...chunks]);
  return Buffer.concat([ascii('RIFF'), u32le(body.length), body]);
}
function lossless(width = 30, height = 20) {
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
  return riffChunk('VP8L', Buffer.concat([Buffer.from([0x2f]), u32le(bits), Buffer.from([0])]));
}
function lossy(width = 30, height = 20) {
  const header = Buffer.from([
    0x30,
    0,
    0,
    0x9d,
    1,
    0x2a,
    width & 255,
    width >> 8,
    height & 255,
    height >> 8,
    0,
  ]);
  return riffChunk('VP8 ', header);
}
function extended(width, height, flags = 0) {
  const data = Buffer.alloc(10);
  data[0] = flags;
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return riffChunk('VP8X', data);
}
function rejects(bytes, code) {
  assert.throws(
    () => inspectImageHeader(bytes),
    (error) => error instanceof ImageHeaderError && (!code || error.code === code),
  );
}

test('synthetic receipt fixtures pass and actual bytes override a misleading file extension', () => {
  for (const name of ['receipt-a.png', 'receipt-b.png', 'blank.png']) {
    const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/images', name));
    assert.deepEqual(inspectImageHeader(bytes), {
      mimeType: 'image/png',
      width: 1100,
      height: 900,
      byteSize: bytes.length,
    });
  }
  const mislabeled = fs.readFileSync(
    path.join(__dirname, 'fixtures/images/png-with-webp-extension.webp'),
  );
  assert.equal(inspectImageHeader(mislabeled).mimeType, 'image/png');
});

test('input is actual Uint8Array bytes, subarray offsets work, and results do not expose mutable byte data', () => {
  for (const value of [null, {}, [], 'photo.png', new ArrayBuffer(8)])
    rejects(value, 'INVALID_INPUT');
  rejects(new Uint8Array(), 'INVALID_IMAGE');
  const image = png(),
    combined = Buffer.concat([Buffer.alloc(17, 33), image, Buffer.alloc(8)]);
  const slice = new Uint8Array(combined.buffer, combined.byteOffset + 17, image.length);
  const before = Buffer.from(slice),
    result = inspectImageHeader(slice);
  assert.deepEqual(Buffer.from(slice), before);
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(result, {
    mimeType: 'image/png',
    width: 1,
    height: 1,
    byteSize: image.length,
  });
});

test('unsupported GIF/HEIC/AVIF/video signatures are rejected without trusting filenames', () => {
  for (const bytes of [
    ascii('GIF89a'),
    Buffer.concat([u32be(24), ascii('ftypheic'), Buffer.alloc(12)]),
    Buffer.concat([u32be(24), ascii('ftypavif'), Buffer.alloc(12)]),
    webp(riffChunk('AVI ', Buffer.alloc(4))),
    ascii('This is not a JPEG despite its .jpg name'),
  ])
    rejects(bytes);
});

test('size, dimension, and pixel-count limits are enforced before image decoding', () => {
  rejects(new Uint8Array(MAX_PHOTO_BYTES + 1), 'SIZE_LIMIT');
  assert.equal(inspectImageHeader(png(16384, 1)).width, 16384);
  assert.equal(inspectImageHeader(png(8000, 5000)).height, 5000);
  for (const image of [
    png(16385, 1),
    png(8001, 5000),
    jpeg(16385, 1),
    jpeg(8001, 5000),
    webp(extended(16385, 1), lossless()),
    webp(lossless(8001, 5000)),
  ])
    rejects(image, 'DIMENSION_LIMIT');
  for (const image of [png(0, 1), png(1, 0), jpeg(0, 1), jpeg(1, 0)])
    rejects(image, 'INVALID_IMAGE');
});

test('every truncated prefix of complete structural PNG/JPEG/WebP fixtures rejects', () => {
  for (const image of [
    png(),
    jpeg(),
    webp(lossless()),
    webp(lossy()),
    webp(extended(30, 20), lossless()),
  ]) {
    inspectImageHeader(image);
    for (let length = 0; length < image.length; length++) rejects(image.subarray(0, length));
  }
});

test('PNG validates checksums, IHDR fields/order, palette requirements, and contiguous image-data chunks', () => {
  const corrupt = png();
  corrupt[29] ^= 1;
  rejects(corrupt, 'INVALID_IMAGE');
  rejects(png(1, 1, { depth: 3 }), 'INVALID_IMAGE');
  rejects(png(1, 1, { compression: 1 }), 'INVALID_IMAGE');
  rejects(png(1, 1, { color: 3 }), 'INVALID_IMAGE');
  inspectImageHeader(png(1, 1, { color: 3, before: [chunk('PLTE', Buffer.from([0, 0, 0]))] }));
  rejects(png(1, 1, { before: [chunk('ABCD', Buffer.alloc(0))] }), 'INVALID_IMAGE');
  rejects(
    png(1, 1, {
      after: [chunk('tEXt', ascii('test')), chunk('IDAT', Buffer.from([1]))],
    }),
    'INVALID_IMAGE',
  );
  rejects(png(1, 1, { before: [chunk('IHDR', Buffer.alloc(13))] }), 'INVALID_IMAGE');
  rejects(Buffer.concat([png(), Buffer.from([0])]), 'INVALID_IMAGE');
});

test('PNG malformed lengths and animation do not reach a native decoder', () => {
  const oversized = png();
  oversized.writeUInt32BE(0xffffffff, 8);
  rejects(oversized, 'INVALID_IMAGE');
  const truncated = Buffer.concat([pngSignature, u32be(100), ascii('IHDR'), Buffer.alloc(4)]);
  rejects(truncated, 'INVALID_IMAGE');
  for (const kind of ['acTL', 'fcTL', 'fdAT'])
    rejects(png(1, 1, { before: [chunk(kind, Buffer.alloc(8))] }), 'UNSUPPORTED_FORMAT');
});

test('JPEG accepts baseline/progressive headers, APP segments, byte stuffing, restart markers, and multiple scans', () => {
  const baseline = jpeg(640, 480, 0xc0, [segment(0xe1, ascii('Exif\0\0test'))]);
  assert.deepEqual(inspectImageHeader(baseline), {
    mimeType: 'image/jpeg',
    width: 640,
    height: 480,
    byteSize: baseline.length,
  });
  const progressive = jpeg(1280, 720, 0xc2);
  const twoScans = Buffer.concat([
    progressive.subarray(0, -2),
    segment(0xc4, Buffer.from([0])),
    segment(0xda, Buffer.from([1, 1, 0, 1, 63, 0])),
    Buffer.from([1, 2, 3, 255, 217]),
  ]);
  assert.equal(inspectImageHeader(twoScans).width, 1280);
});

test('JPEG rejects no SOF, repeated SOF, invalid segment length/components, and deferred/hierarchical dimensions', () => {
  rejects(Buffer.from([255, 216, 255, 217]), 'INVALID_IMAGE');
  rejects(Buffer.from([255, 216, 255, 225, 0, 1, 255, 217]), 'INVALID_IMAGE');
  rejects(Buffer.from([255, 216, 255, 225, 255, 255, 255, 217]), 'INVALID_IMAGE');
  rejects(jpeg(1, 1, 0xc5), 'UNSUPPORTED_FORMAT');
  rejects(jpeg(1, 1, 0xc0, [segment(0xdc, Buffer.from([0, 1]))]), 'UNSUPPORTED_FORMAT');
  const repeated = jpeg();
  rejects(Buffer.concat([repeated.subarray(0, 15), repeated.subarray(2)]), 'INVALID_IMAGE');
  const badComponent = jpeg();
  badComponent[13] = 0;
  rejects(badComponent, 'INVALID_IMAGE');
  const badScan = jpeg();
  badScan[20] = 9;
  rejects(badScan, 'INVALID_IMAGE');
  rejects(Buffer.concat([jpeg(), Buffer.from([0])]), 'INVALID_IMAGE');
});

test('WebP accepts VP8, VP8L, and VP8X with consistent dimensions', () => {
  for (const image of [
    webp(lossy(321, 123)),
    webp(lossless(321, 123)),
    webp(extended(321, 123), lossless(321, 123)),
  ])
    assert.deepEqual(inspectImageHeader(image), {
      mimeType: 'image/webp',
      width: 321,
      height: 123,
      byteSize: image.length,
    });
  const alpha = riffChunk('ALPH', Buffer.from([0, 0]));
  inspectImageHeader(webp(extended(20, 10, 16), alpha, lossy(20, 10)));
  inspectImageHeader(
    webp(extended(20, 10, 8), lossless(20, 10), riffChunk('EXIF', ascii('metadata'))),
  );
});

test('WebP validates RIFF/chunk/padding boundaries and rejects animation/mismatched canvas', () => {
  const wrongSize = webp(lossless());
  wrongSize.writeUInt32LE(0xffffffff, 4);
  rejects(wrongSize, 'INVALID_IMAGE');
  const chunkOverflow = webp(lossless());
  chunkOverflow.writeUInt32LE(0xffffffff, 16);
  rejects(chunkOverflow, 'INVALID_IMAGE');
  const padding = webp(lossy());
  padding[padding.length - 1] = 1;
  rejects(padding, 'INVALID_IMAGE');
  rejects(webp(extended(31, 20), lossless(30, 20)), 'INVALID_IMAGE');
  rejects(webp(extended(30, 20, 2), lossless()), 'UNSUPPORTED_FORMAT');
  rejects(webp(extended(30, 20), riffChunk('ANMF', Buffer.alloc(16))), 'UNSUPPORTED_FORMAT');
  rejects(webp(extended(30, 20)), 'INVALID_IMAGE');
  rejects(webp(lossless(), lossless()), 'INVALID_IMAGE');
});

test('WebP validates lossless version, VP8 key-frame signature, and declared metadata/alpha', () => {
  const version = webp(lossless());
  version[24] |= 0xe0;
  rejects(version, 'INVALID_IMAGE');
  const signature = webp(lossy());
  signature[23] = 0;
  rejects(signature, 'INVALID_IMAGE');
  const partition = webp(lossy());
  partition[21] = 255;
  rejects(partition, 'INVALID_IMAGE');
  rejects(webp(extended(30, 20, 8), lossless()), 'INVALID_IMAGE');
  rejects(webp(extended(30, 20, 16), lossy()), 'INVALID_IMAGE');
  rejects(
    webp(extended(30, 20), riffChunk('EXIF', ascii('metadata')), lossless()),
    'INVALID_IMAGE',
  );
});

test('header acceptance deliberately does not claim pixel-stream decoding', () => {
  // These bounded synthetic streams carry only structural fixtures, not full JPEG/VP8 encodings.
  assert.equal(inspectImageHeader(jpeg(100, 50)).height, 50);
  assert.equal(inspectImageHeader(webp(lossless(100, 50))).height, 50);
});

test('WebP ICC profile must precede alpha image data as well as the color bitstream', () => {
  const header = extended(30, 20, 32 | 16);
  const profile = riffChunk('ICCP', ascii('profile header fixture'));
  const alpha = riffChunk('ALPH', Buffer.from([0, 0]));
  inspectImageHeader(webp(header, profile, alpha, lossy()));
  rejects(webp(header, alpha, profile, lossy()), 'INVALID_IMAGE');
  rejects(webp(header, alpha, lossy(), profile), 'INVALID_IMAGE');
});
