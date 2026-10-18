const { sha256 } = require('@noble/hashes/sha2.js');
function sha256Hex(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('Hash actual file bytes.');
  return Array.from(sha256(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}
module.exports = { sha256Hex };
