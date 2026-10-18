// Pre-decode structural/header checks only. Never a replacement for native decoding.
// No file-system, network, Buffer, or React Native dependency.
const MAX_PHOTO_BYTES = 10485760;
const MAX_PHOTO_DIMENSION = 16384;
const MAX_PHOTO_PIXELS = 40000000;

class ImageHeaderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImageHeaderError';
    this.code = code;
  }
}
const invalid = (message) => {
  throw new ImageHeaderError('INVALID_IMAGE', message);
};
const unsupported = (message) => {
  throw new ImageHeaderError('UNSUPPORTED_FORMAT', message);
};
const equal = (bytes, offset, signature) =>
  signature.every((value, i) => bytes[offset + i] === value);
const text = (bytes, offset, count) =>
  String.fromCharCode(...bytes.subarray(offset, offset + count));
const be16 = (bytes, offset) => bytes[offset] * 256 + bytes[offset + 1];
const le16 = (bytes, offset) => bytes[offset] + bytes[offset + 1] * 256;
const be32 = (bytes, offset) =>
  bytes[offset] * 16777216 +
  bytes[offset + 1] * 65536 +
  bytes[offset + 2] * 256 +
  bytes[offset + 3];
const le24 = (bytes, offset) => bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
const le32 = (bytes, offset) => le24(bytes, offset) + bytes[offset + 3] * 16777216;
function bounds(bytes, offset, length) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > bytes.length - length
  )
    invalid('The image contains a truncated or invalid segment.');
}
function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
    invalid('The image must declare positive dimensions.');
  if (
    width > MAX_PHOTO_DIMENSION ||
    height > MAX_PHOTO_DIMENSION ||
    width * height > MAX_PHOTO_PIXELS
  )
    throw new ImageHeaderError(
      'DIMENSION_LIMIT',
      'The photo exceeds 16,384 pixels per side or 40 million pixels in total.',
    );
  return { width, height };
}

const crcTable = new Uint32Array(256);
for (let value = 0; value < 256; value++) {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  crcTable[value] = crc >>> 0;
}
function crc32(bytes, from, to) {
  let crc = 0xffffffff;
  for (let offset = from; offset < to; offset++)
    crc = crcTable[(crc ^ bytes[offset]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function png(bytes) {
  let offset = 8,
    size = null,
    color = null,
    bitDepth = null;
  let palette = false,
    dataSeen = false,
    dataClosed = false,
    dataBytes = 0;
  while (offset < bytes.length) {
    bounds(bytes, offset, 12);
    const length = be32(bytes, offset),
      kind = text(bytes, offset + 4, 4),
      start = offset + 8;
    if (length > 0x7fffffff || !/^[A-Za-z]{4}$/.test(kind) || kind[2] !== kind[2].toUpperCase())
      invalid('Invalid PNG chunk header.');
    bounds(bytes, start, length + 4);
    if (!size && kind !== 'IHDR') invalid('PNG must begin with its image header.');
    if (kind === 'IHDR') {
      if (size || offset !== 8 || length !== 13) invalid('Invalid or duplicate PNG image header.');
      size = dimensions(be32(bytes, start), be32(bytes, start + 4));
      bitDepth = bytes[start + 8];
      color = bytes[start + 9];
      const depths = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !depths[color]?.includes(bitDepth) ||
        bytes[start + 10] !== 0 ||
        bytes[start + 11] !== 0 ||
        bytes[start + 12] > 1
      )
        invalid('Unsupported or invalid PNG image-header fields.');
    } else if (kind === 'acTL' || kind === 'fcTL' || kind === 'fdAT') {
      unsupported('Animated PNG is not supported for a single transaction photo.');
    } else if (kind === 'PLTE') {
      if (
        palette ||
        dataSeen ||
        color === 0 ||
        color === 4 ||
        !length ||
        length % 3 ||
        length > 768 ||
        (color === 3 && length / 3 > 2 ** bitDepth)
      )
        invalid('Invalid PNG palette.');
      palette = true;
    } else if (kind === 'IDAT') {
      if (dataClosed || (color === 3 && !palette))
        invalid('Invalid PNG image-data order or missing palette.');
      dataSeen = true;
      dataBytes += length;
    } else if (kind === 'IEND') {
      if (length !== 0 || !dataSeen || !dataBytes)
        invalid('PNG is missing image data or has an invalid end chunk.');
    } else if (kind[0] === kind[0].toUpperCase()) invalid('The PNG has an unknown critical chunk.');
    if (crc32(bytes, offset + 4, start + length) !== be32(bytes, start + length))
      invalid('A PNG chunk checksum is invalid.');
    offset = start + length + 4;
    if (kind === 'IEND') {
      if (offset !== bytes.length) invalid('PNG contains data after its end chunk.');
      return size;
    }
    if (dataSeen && kind !== 'IDAT') dataClosed = true;
  }
  invalid('The PNG end chunk is missing.');
}

const jpegFrames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc9, 0xca, 0xcb]);
function jpeg(bytes) {
  let offset = 2,
    frame = null,
    scanSeen = false,
    entropySeen = false,
    insideScan = false;
  while (offset < bytes.length) {
    if (insideScan) {
      let foundMarker = false;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          entropySeen = true;
          offset++;
          continue;
        }
        const markerStart = offset;
        while (offset < bytes.length && bytes[offset] === 0xff) offset++;
        bounds(bytes, offset, 1);
        const marker = bytes[offset];
        if (marker === 0 || (marker >= 0xd0 && marker <= 0xd7) || marker === 1) {
          entropySeen = true;
          offset++;
          continue;
        }
        offset = markerStart;
        insideScan = false;
        foundMarker = true;
        break;
      }
      if (!foundMarker) invalid('The JPEG scan is truncated before its end marker.');
    }
    if (bytes[offset] !== 0xff) invalid('Invalid JPEG marker boundary.');
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    bounds(bytes, offset, 1);
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!frame || !scanSeen || !entropySeen || offset !== bytes.length)
        invalid('JPEG is missing a frame/scan or has trailing data.');
      return { width: frame.width, height: frame.height };
    }
    if (marker === 0xd8 || marker === 0 || (marker >= 0xd0 && marker <= 0xd7))
      invalid('Unexpected standalone JPEG marker.');
    if (marker === 1) continue;
    if (marker < 0xc0 || marker === 0xff) invalid('Unknown JPEG marker.');
    if ([0xc5, 0xc6, 0xc7, 0xcd, 0xce, 0xcf, 0xdc, 0xde, 0xdf].includes(marker))
      unsupported('JPEG with deferred dimensions or hierarchical frames is not supported.');
    bounds(bytes, offset, 2);
    const length = be16(bytes, offset),
      start = offset + 2;
    if (length < 2) invalid('Invalid JPEG segment length.');
    bounds(bytes, offset, length);
    if (jpegFrames.has(marker)) {
      if (frame || length < 11) invalid('Invalid or repeated JPEG frame header.');
      const precision = bytes[start],
        height = be16(bytes, start + 1),
        width = be16(bytes, start + 3),
        componentCount = bytes[start + 5];
      if (!componentCount || length !== 8 + 3 * componentCount)
        invalid('JPEG frame length does not match its components.');
      if (componentCount > 4) unsupported('JPEG with more than four components is not supported.');
      const lossless = marker === 0xc3 || marker === 0xcb;
      if (
        lossless
          ? precision < 2 || precision > 16
          : marker === 0xc0
            ? precision !== 8
            : precision !== 8 && precision !== 12
      )
        invalid('Invalid JPEG sample precision.');
      const size = dimensions(width, height),
        components = new Map();
      for (let i = 0; i < componentCount; i++) {
        const at = start + 6 + 3 * i,
          id = bytes[at],
          h = bytes[at + 1] >> 4,
          v = bytes[at + 1] & 15;
        if (components.has(id) || !h || h > 4 || !v || v > 4 || bytes[at + 2] > 3)
          invalid('Invalid JPEG component definition.');
        components.set(id, h * v);
      }
      frame = { ...size, components };
    } else if (marker === 0xda) {
      if (!frame || length < 8) invalid('JPEG scan appears without a usable frame.');
      const count = bytes[start],
        seen = new Set();
      if (!count || count > 4 || length !== 6 + 2 * count)
        invalid('Invalid JPEG scan header length.');
      let samples = 0;
      for (let i = 0; i < count; i++) {
        const id = bytes[start + 1 + 2 * i],
          tables = bytes[start + 2 + 2 * i];
        if (!frame.components.has(id) || seen.has(id) || tables >> 4 > 3 || (tables & 15) > 3)
          invalid('Invalid JPEG scan component.');
        seen.add(id);
        samples += frame.components.get(id);
      }
      if (count > 1 && samples > 10)
        invalid('JPEG interleaved sampling factors exceed the supported format.');
      scanSeen = true;
      insideScan = true;
    }
    offset += length;
  }
  invalid('JPEG is missing its end marker or a usable frame.');
}

function vp8(bytes, start, length) {
  if (
    length < 11 ||
    bytes[start] & 1 ||
    ((bytes[start] >> 1) & 7) > 3 ||
    !(bytes[start] & 16) ||
    !equal(bytes, start + 3, [0x9d, 1, 0x2a])
  )
    invalid('Invalid WebP VP8 key-frame header.');
  const firstPartition = le24(bytes, start) >>> 5;
  if (firstPartition > length - 10) invalid('WebP VP8 partition is truncated.');
  return dimensions(le16(bytes, start + 6) & 0x3fff, le16(bytes, start + 8) & 0x3fff);
}
function vp8l(bytes, start, length) {
  if (length < 6 || bytes[start] !== 0x2f) invalid('Invalid WebP lossless header.');
  const bits = le32(bytes, start + 1);
  if (bits >>> 29) invalid('Unknown WebP lossless version.');
  return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
}
function webp(bytes) {
  bounds(bytes, 0, 20);
  if (le32(bytes, 4) + 8 !== bytes.length || bytes.length % 2)
    invalid('WebP RIFF length does not match the file.');
  let offset = 12,
    canvas = null,
    image = null,
    imageKind = null,
    alpha = false,
    flags = 0;
  const metadata = new Set();
  while (offset < bytes.length) {
    bounds(bytes, offset, 8);
    const kind = text(bytes, offset, 4),
      length = le32(bytes, offset + 4),
      start = offset + 8;
    bounds(bytes, start, length + (length % 2));
    if (!/^[\x20-\x7e]{4}$/.test(kind)) invalid('Invalid WebP chunk identifier.');
    if (length % 2 && bytes[start + length] !== 0) invalid('Invalid WebP chunk padding.');
    if (offset === 12 && !['VP8X', 'VP8 ', 'VP8L'].includes(kind))
      invalid('WebP begins with an invalid image chunk.');
    if (kind === 'VP8X') {
      if (offset !== 12 || canvas || length !== 10) invalid('Invalid WebP extended header.');
      flags = bytes[start];
      if (flags & 0xc1 || bytes[start + 1] || bytes[start + 2] || bytes[start + 3])
        invalid('Invalid WebP reserved header fields.');
      if (flags & 2) unsupported('Animated WebP is not supported for a single transaction photo.');
      canvas = dimensions(le24(bytes, start + 4) + 1, le24(bytes, start + 7) + 1);
    } else if (kind === 'ANIM' || kind === 'ANMF')
      unsupported('Animated WebP is not supported for a single transaction photo.');
    else if (kind === 'VP8 ' || kind === 'VP8L') {
      if (image) invalid('WebP contains multiple image bitstreams.');
      image = kind === 'VP8 ' ? vp8(bytes, start, length) : vp8l(bytes, start, length);
      imageKind = kind;
      if (canvas && (canvas.width !== image.width || canvas.height !== image.height))
        invalid('WebP canvas and image dimensions disagree.');
    } else if (kind === 'ALPH') {
      if (
        !canvas ||
        !(flags & 16) ||
        alpha ||
        image ||
        !length ||
        bytes[start] & 0xc0 ||
        (bytes[start] & 3) > 1 ||
        ((bytes[start] >> 4) & 3) > 1
      )
        invalid('Invalid WebP alpha chunk.');
      alpha = true;
    } else if (['ICCP', 'EXIF', 'XMP '].includes(kind)) {
      const flag = { ICCP: 32, EXIF: 8, 'XMP ': 4 }[kind];
      if (
        !canvas ||
        !(flags & flag) ||
        metadata.has(kind) ||
        !length ||
        (kind === 'ICCP' && (image || alpha))
      )
        invalid('Invalid WebP metadata declaration or order.');
      metadata.add(kind);
    }
    offset = start + length + (length % 2);
  }
  if (
    !image ||
    (alpha && imageKind !== 'VP8 ') ||
    (canvas && imageKind === 'VP8 ' && Boolean(flags & 16) !== alpha)
  )
    invalid('WebP is missing a compatible image or alpha bitstream.');
  for (const [kind, flag] of [
    ['ICCP', 32],
    ['EXIF', 8],
    ['XMP ', 4],
  ])
    if (Boolean(flags & flag) !== metadata.has(kind))
      invalid('WebP metadata flags do not match its chunks.');
  return canvas ?? image;
}

function inspectImageHeader(bytes) {
  if (!(bytes instanceof Uint8Array))
    throw new ImageHeaderError('INVALID_INPUT', 'Pass the actual image bytes as a Uint8Array.');
  if (!bytes.byteLength) invalid('The image is empty.');
  if (bytes.byteLength > MAX_PHOTO_BYTES)
    throw new ImageHeaderError('SIZE_LIMIT', 'The photo exceeds the 10 MiB size limit.');
  let mimeType, size;
  if (equal(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10])) {
    mimeType = 'image/png';
    size = png(bytes);
  } else if (equal(bytes, 0, [0xff, 0xd8])) {
    mimeType = 'image/jpeg';
    size = jpeg(bytes);
  } else if (text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 4) === 'WEBP') {
    mimeType = 'image/webp';
    size = webp(bytes);
  } else
    unsupported(
      'Choose a static JPEG, PNG, or WebP image. The actual file signature is unsupported.',
    );
  return Object.freeze({
    mimeType,
    width: size.width,
    height: size.height,
    byteSize: bytes.byteLength,
  });
}

module.exports = {
  inspectImageHeader,
  ImageHeaderError,
  MAX_PHOTO_BYTES,
  MAX_PHOTO_DIMENSION,
  MAX_PHOTO_PIXELS,
};
