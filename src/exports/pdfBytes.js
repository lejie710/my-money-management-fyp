const { inspectImageHeader } = require('../attachments/imageHeader');
const { MAX_PHOTO_BYTES } = require('../core/transactionContext');
const { PdfExportError, MIN_PDF_BYTES, MAX_PDF_BYTES } = require('./pdfController');
const PDF_TAIL_SCAN_BYTES = 2048;
const PDF_XREF_SCAN_BYTES = 1024;
function isPdfHeader(bytes) {
  return (
    bytes instanceof Uint8Array &&
    bytes.length >= 9 &&
    /^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(String.fromCharCode(...bytes.subarray(0, 10)))
  );
}
function readPdfEnvelope(header, tail, byteSize) {
  if (
    !isPdfHeader(header) ||
    !Number.isSafeInteger(byteSize) ||
    byteSize < MIN_PDF_BYTES ||
    byteSize > MAX_PDF_BYTES ||
    !(tail instanceof Uint8Array) ||
    tail.length !== Math.min(PDF_TAIL_SCAN_BYTES, byteSize)
  )
    return null;
  const text = String.fromCharCode(...tail);
  const end = /startxref[\x00\t\n\f\r ]+([0-9]{1,10})[\x00\t\n\f\r ]+%%EOF[\x00\t\n\f\r ]*$/.exec(
    text,
  );
  if (!end) return null;
  const xrefOffset = Number(end[1]),
    trailerOffset = byteSize - tail.length + end.index;
  return Number.isSafeInteger(xrefOffset) && xrefOffset >= 9 && xrefOffset < trailerOffset
    ? { xrefOffset }
    : null;
}
function isPdfXrefStart(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > PDF_XREF_SCAN_BYTES) return false;
  const text = String.fromCharCode(...bytes);
  return (
    /^xref[\x00\t\n\f\r ]/.test(text) ||
    (/^[0-9]{1,10}[\x00\t\n\f\r ]+[0-9]{1,5}[\x00\t\n\f\r ]+obj[\x00\t\n\f\r ]/.test(text) &&
      /\/Type[\x00\t\n\f\r ]*\/XRef\b/.test(text))
  );
}
function validatePdfFileName(name) {
  if (typeof name !== 'string' || !/^(report|transaction)-[a-z0-9][a-z0-9-]{0,70}\.pdf$/.test(name))
    throw new PdfExportError('INVALID_PATH', 'The PDF filename is invalid.');
  return name;
}
function filePath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:///') || /[?#]|%2f|%5c/i.test(uri))
    throw new PdfExportError('INVALID_PATH', 'Only an app-cache PDF can be used.');
  let path;
  try {
    path = decodeURIComponent(uri.slice(7));
  } catch {
    throw new PdfExportError('INVALID_PATH', 'The PDF path could not be read.');
  }
  if (/[\\\0%]/.test(path) || path.split('/').some((part) => part === '.' || part === '..'))
    throw new PdfExportError('INVALID_PATH', 'The PDF path is invalid.');
  return path.replace(/\/+$/, '');
}
function validateCacheUri(uri, cacheUri, excludedRoot) {
  const path = filePath(uri),
    cache = filePath(cacheUri);
  if (
    !path.startsWith(cache + '/') ||
    (excludedRoot &&
      (path === filePath(excludedRoot) || path.startsWith(filePath(excludedRoot) + '/')))
  )
    throw new PdfExportError(
      'INVALID_PATH',
      'Only the PDF produced in this app cache can be retained.',
    );
  return uri;
}
function photoDataUrl(bytes, expected) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_PHOTO_BYTES)
    throw new PdfExportError(
      'IMAGE_INVALID',
      'The selected photo is empty or too large. Deselect it or choose another.',
    );
  let info;
  try {
    info = inspectImageHeader(bytes);
  } catch {
    throw new PdfExportError(
      'IMAGE_INVALID',
      'The selected photo is unsupported or invalid. Deselect it or choose another.',
    );
  }
  if (['mimeType', 'width', 'height', 'byteSize'].some((key) => info[key] !== expected[key]))
    throw new PdfExportError(
      'IMAGE_CHANGED',
      'The selected photo changed. Deselect it or choose it again.',
    );
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
    parts = [];
  for (let start = 0; start < bytes.length; start += 24576) {
    let part = '';
    const end = Math.min(bytes.length, start + 24576);
    for (let i = start; i < end; i += 3) {
      const a = bytes[i],
        b = i + 1 < end ? bytes[i + 1] : 0,
        c = i + 2 < end ? bytes[i + 2] : 0;
      part +=
        alphabet[a >> 2] +
        alphabet[((a & 3) << 4) | (b >> 4)] +
        (i + 1 < end ? alphabet[((b & 15) << 2) | (c >> 6)] : '=') +
        (i + 2 < end ? alphabet[c & 63] : '=');
    }
    parts.push(part);
  }
  return 'data:' + info.mimeType + ';base64,' + parts.join('');
}
module.exports = {
  isPdfHeader,
  readPdfEnvelope,
  isPdfXrefStart,
  PDF_TAIL_SCAN_BYTES,
  PDF_XREF_SCAN_BYTES,
  validatePdfFileName,
  validateCacheUri,
  photoDataUrl,
};
