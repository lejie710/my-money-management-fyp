const { validateLedger } = require('../core/model');
const { validateDataFamily, encodeDataFamily, encodeDataScope } = require('../accounts/identity');
const { validatePhotoRef, photoKey, samePhotoRef } = require('../core/transactionContext');
const { portableLedger, utf8, cloudOwner } = require('./backupFormat');
const { sha256Hex } = require('./hash');
const MAX_WALLET_BYTES = 768 * 1024;
const MAX_WALLET_PHOTOS = 100;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const exact = (v, keys) => {
  if (!object(v) || Object.keys(v).sort().join(',') !== [...keys].sort().join(','))
    throw new Error('Cloud wallet data has an unsupported structure.');
};
function everydayKeys(value) {
  const family = validateDataFamily(value);
  if (family.actor.kind !== 'firebase-hosted')
    throw new Error('A configured Firebase account is required.');
  cloudOwner({ projectId: family.actor.projectId, uid: family.actor.uid });
  const token = encodeDataFamily(family);
  const prefix = '@mymoney/cloud-wallet/v1/' + encodeURIComponent(token);
  return {
    familyToken: token,
    cache: prefix + '/confirmed',
    draft: prefix + '/draft',
    walletId:
      family.scope.kind === 'canonical'
        ? 'main'
        : 'test-' + sha256Hex(utf8(encodeDataScope(family.scope))),
  };
}
function checkedLedger(value) {
  portableLedger(value); // Validates all financial fields and rejects undeclared payload fields.
  return clone(validateLedger(value)); // Managed basenames are retained; no file URI/download URL is allowed.
}
function ledgerPhotos(ledger) {
  checkedLedger(ledger);
  const photos = new Map();
  for (const row of ledger.transactions) {
    const photo = row.context?.photo;
    if (!photo) continue;
    validatePhotoRef(photo, ledger.wallet.incarnationId);
    const key = photoKey(photo);
    if (photos.has(key) && !samePhotoRef(photos.get(key), photo))
      throw new Error('Cloud photo ownership metadata is inconsistent.');
    photos.set(key, clone(photo));
  }
  if (photos.size > MAX_WALLET_PHOTOS)
    throw new Error('A cloud wallet supports at most 100 attached photos.');
  return [...photos.values()];
}
function operationId(value) {
  if (typeof value !== 'string' || !/^wallet-[a-z0-9-]{16,96}$/.test(value))
    throw new Error('The cloud save identifier is invalid.');
  return value;
}
function decodeRecord(value, owner) {
  exact(value, [
    'version',
    'ownerUid',
    'revision',
    'operationId',
    'updatedAtMs',
    'payload',
    'payloadHash',
  ]);
  cloudOwner(owner);
  if (
    value.version !== 1 ||
    value.ownerUid !== owner.uid ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    value.revision > Number.MAX_SAFE_INTEGER - 1 ||
    !Number.isSafeInteger(value.updatedAtMs) ||
    value.updatedAtMs < 0 ||
    value.updatedAtMs > 8640000000000000 ||
    typeof value.payload !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.payloadHash)
  )
    throw new Error('The cloud wallet belongs to another account or has invalid metadata.');
  operationId(value.operationId);
  const bytes = utf8(value.payload);
  if (bytes.length > MAX_WALLET_BYTES || sha256Hex(bytes) !== value.payloadHash)
    throw new Error('The cloud wallet failed its size or integrity check.');
  let decoded;
  try {
    decoded = JSON.parse(value.payload);
  } catch {
    throw new Error('The cloud wallet payload is unreadable.');
  }
  exact(decoded, ['ledger', 'photos']);
  const ledger = checkedLedger(decoded.ledger),
    wanted = new Map(ledgerPhotos(ledger).map((p) => [photoKey(p), p]));
  if (!Array.isArray(decoded.photos) || decoded.photos.length !== wanted.size)
    throw new Error('The cloud attachment manifest is incomplete.');
  const seen = new Set();
  for (const item of decoded.photos) {
    exact(item, ['photo', 'sha256']);
    validatePhotoRef(item.photo, ledger.wallet.incarnationId);
    const key = photoKey(item.photo);
    if (
      seen.has(key) ||
      !wanted.has(key) ||
      !samePhotoRef(wanted.get(key), item.photo) ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw new Error('The cloud attachment manifest is inconsistent.');
    seen.add(key);
  }
  return { record: clone(value), ledger, photos: clone(decoded.photos) };
}
function makeRecord({ ledger, photos, owner, revision, id, nowMs }) {
  const payload = JSON.stringify({ ledger: checkedLedger(ledger), photos: clone(photos) });
  const record = {
    version: 1,
    ownerUid: owner.uid,
    revision,
    operationId: operationId(id),
    updatedAtMs: nowMs,
    payload,
    payloadHash: sha256Hex(utf8(payload)),
  };
  return decodeRecord(record, owner).record;
}
function validateOperation(value, owner, id) {
  exact(value, ['version', 'ownerUid', 'operationId', 'revision', 'payloadHash']);
  if (
    value.version !== 1 ||
    value.ownerUid !== owner.uid ||
    value.operationId !== operationId(id) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !/^[a-f0-9]{64}$/.test(value.payloadHash)
  )
    throw new Error('The cloud save receipt is invalid.');
  return clone(value);
}
module.exports = {
  MAX_WALLET_BYTES,
  MAX_WALLET_PHOTOS,
  everydayKeys,
  checkedLedger,
  ledgerPhotos,
  operationId,
  decodeRecord,
  makeRecord,
  validateOperation,
};
