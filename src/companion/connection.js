const { validateProviders } = require('./providerContract');
const MAX_COMPANION_CONNECTION_BYTES = 4096;
class CompanionConnectionError extends Error {
  constructor(code = 'INVALID_CONNECTION') {
    super(
      code === 'CONNECTION_UNAVAILABLE'
        ? 'The private companion connection could not be read. Pair the local companion again, then recheck.'
        : 'The private companion connection is invalid. Pair the local companion again, then recheck.',
    );
    this.name = 'CompanionConnectionError';
    this.code = code === 'CONNECTION_UNAVAILABLE' ? code : 'INVALID_CONNECTION';
  }
}
// The input is valid JSON before this scan. Keep a separate key set for each
// object, including nested provider objects, and compare decoded escaped keys.
function rejectDuplicateKeys(text) {
  const stack = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '{') {
      stack.push(new Set());
      continue;
    }
    if (character === '[') {
      stack.push(null);
      continue;
    }
    if (character === '}' || character === ']') {
      stack.pop();
      continue;
    }
    if (character !== '"') continue;
    const start = index++;
    for (; index < text.length; index++) {
      if (text[index] === '\\') index++;
      else if (text[index] === '"') break;
    }
    let after = index + 1;
    while (text[after] === ' ') after++;
    if (text[after] === ':') {
      const object = stack[stack.length - 1];
      const key = JSON.parse(text.slice(start, index + 1));
      if (!object || object.has(key)) throw new CompanionConnectionError();
      object.add(key);
    }
  }
}
function parseCompanionConnection(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_COMPANION_CONNECTION_BYTES
  )
    throw new CompanionConnectionError();
  let text = '';
  for (const byte of bytes) {
    if (byte < 32 || byte > 126) throw new CompanionConnectionError();
    text += String.fromCharCode(byte);
  }
  let value;
  try {
    value = JSON.parse(text);
    rejectDuplicateKeys(text);
    const expected =
      value?.version === 2 ? 'providers,runId,token,url,version' : 'runId,token,url,version';
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      ![1, 2].includes(value.version) ||
      Object.keys(value).sort().join(',') !== expected ||
      typeof value.runId !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.runId) ||
      value.url !== 'http://127.0.0.1:8787/v1/recognize' ||
      typeof value.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(value.token)
    )
      throw new CompanionConnectionError();
    const common = {
      version: value.version,
      runId: value.runId,
      url: value.url,
      token: value.token,
    };
    return Object.freeze(
      value.version === 2 ? { ...common, providers: validateProviders(value.providers) } : common,
    );
  } catch {
    throw new CompanionConnectionError();
  }
}
module.exports = {
  MAX_COMPANION_CONNECTION_BYTES,
  CompanionConnectionError,
  parseCompanionConnection,
};
