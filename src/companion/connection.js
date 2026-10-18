const MAX_COMPANION_CONNECTION_BYTES = 4096;
class CompanionConnectionError extends Error {
  constructor(code = "INVALID_CONNECTION") {
    super(
      code === "CONNECTION_UNAVAILABLE"
        ? "The private companion connection could not be read. Pair the local companion again, then recheck."
        : "The private companion connection is invalid. Pair the local companion again, then recheck.",
    );
    this.name = "CompanionConnectionError";
    this.code = code === "CONNECTION_UNAVAILABLE" ? code : "INVALID_CONNECTION";
  }
}
function parseCompanionConnection(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_COMPANION_CONNECTION_BYTES
  )
    throw new CompanionConnectionError();
  // The paired format consists entirely of ASCII fields. Reject BOM, control
  // bytes and non-ASCII encodings instead of accepting a lossy decode.
  let text = "";
  for (const byte of bytes) {
    if (byte < 32 || byte > 126) throw new CompanionConnectionError();
    text += String.fromCharCode(byte);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CompanionConnectionError();
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "runId,token,url,version" ||
    value.version !== 1 ||
    typeof value.runId !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.runId) ||
    value.url !== "http://127.0.0.1:8787/v1/recognize" ||
    typeof value.token !== "string" ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(value.token)
  )
    throw new CompanionConnectionError();
  // JSON.parse keeps only the last duplicate member. The pairing contract has
  // exactly four primitive fields, so reject duplicate source members as well.
  const keys = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '"') continue;
    const start = index++;
    for (; index < text.length; index++) {
      if (text[index] === "\\") index++;
      else if (text[index] === '"') break;
    }
    let after = index + 1;
    while (text[after] === " ") after++;
    if (text[after] === ":")
      keys.push(JSON.parse(text.slice(start, index + 1)));
  }
  if (keys.length !== 4 || new Set(keys).size !== 4)
    throw new CompanionConnectionError();
  return Object.freeze({
    version: 1,
    runId: value.runId,
    url: value.url,
    token: value.token,
  });
}
module.exports = {
  MAX_COMPANION_CONNECTION_BYTES,
  CompanionConnectionError,
  parseCompanionConnection,
};
