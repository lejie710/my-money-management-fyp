const {
  cloudOwner,
  backupId,
  hashValue,
  MAX_SNAPSHOT_BYTES,
  MAX_PHOTOS,
  MAX_TOTAL_PHOTO_BYTES,
  utf8,
  decodeUtf8,
  validateSnapshot,
} = require('./backupFormat');
const { sha256Hex } = require('./hash');
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function validateIndex(value) {
  const fields = [
    'version',
    'backupId',
    'createdAtMs',
    'currency',
    'transactionCount',
    'photoCount',
    'snapshotBytes',
    'snapshotHash',
    'includesPhotos',
  ];
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== fields.sort().join(',') ||
    value.version !== 1
  )
    throw new Error('Cloud backup index is invalid.');
  backupId(value.backupId);
  hashValue(value.snapshotHash);
  if (
    !Number.isSafeInteger(value.createdAtMs) ||
    value.createdAtMs < 0 ||
    value.createdAtMs > 8640000000000000 ||
    !['MYR', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CNY'].includes(value.currency) ||
    !Number.isSafeInteger(value.transactionCount) ||
    value.transactionCount < 0 ||
    value.transactionCount > 10000 ||
    !Number.isSafeInteger(value.photoCount) ||
    value.photoCount < 0 ||
    value.photoCount > MAX_PHOTOS ||
    !Number.isSafeInteger(value.snapshotBytes) ||
    value.snapshotBytes < 1 ||
    value.snapshotBytes > MAX_SNAPSHOT_BYTES ||
    typeof value.includesPhotos !== 'boolean' ||
    (!value.includesPhotos && value.photoCount)
  )
    throw new Error('Cloud backup index values are invalid.');
  return Object.fromEntries(fields.map((key) => [key, value[key]]));
}
function createCloudTransport({ owner, sdk, timeoutMs = 45000 }) {
  owner = cloudOwner(owner);
  if (
    !sdk ||
    ['getIndex', 'listIndices', 'createIndex', 'head', 'put', 'get', 'remove'].some(
      (key) => typeof sdk[key] !== 'function',
    ) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 50 ||
    timeoutMs > 120000
  )
    throw new Error('Cloud backup connection is not configured.');
  const prefix = (id) => `users/${owner.uid}/walletBackups/${backupId(id)}`;
  const path = (id, name) => `${prefix(id)}/${name}`;
  const current = (signal) => {
    if (signal?.aborted)
      throw new Error(
        'Cloud work cancelled. A submitted upload may still complete; its pending backup is retained.',
      );
  };
  const run = async (work, signal) => {
    current(signal);
    let timer, listener;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'Cloud request timed out. Recheck the same pending backup before retrying.',
                ),
              ),
            timeoutMs,
          );
          if (signal) {
            listener = () =>
              reject(
                new Error('Cloud work cancelled. Pending work is retained for reconciliation.'),
              );
            signal.addEventListener('abort', listener, { once: true });
          }
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (listener) signal.removeEventListener('abort', listener);
    }
  };
  const putVerified = async (id, name, bytes, type, signal) => {
    current(signal);
    const hash = sha256Hex(bytes),
      target = path(id, name);
    const meta = await run(() => sdk.head(target), signal);
    current(signal);
    if (meta) {
      if (meta.sha256 !== hash || meta.size !== bytes.length || meta.contentType !== type)
        throw new Error(
          'An existing cloud object differs from this backup. Nothing was overwritten.',
        );
      const existing = await run(() => sdk.get(target, bytes.length), signal);
      current(signal);
      if (existing.length !== bytes.length || sha256Hex(existing) !== hash)
        throw new Error('The existing cloud object failed its integrity check.');
      return;
    }
    await run(() => sdk.put(target, bytes, { contentType: type, sha256: hash }, signal), signal);
    current(signal);
    const confirmed = await run(() => sdk.head(target), signal);
    current(signal);
    if (
      !confirmed ||
      confirmed.sha256 !== hash ||
      confirmed.size !== bytes.length ||
      confirmed.contentType !== type
    )
      throw new Error(
        'Uploaded object could not be confirmed. Retry the pending backup deliberately.',
      );
  };
  return Object.freeze({
    async list({ signal } = {}) {
      const values = await run(() => sdk.listIndices(50), signal);
      current(signal);
      if (!Array.isArray(values) || values.length > 50)
        throw new Error('The cloud backup list is invalid.');
      return values.map(validateIndex);
    },
    async backup(snapshot, readPhoto, { signal, onProgress = () => {} } = {}) {
      const checked = validateSnapshot(snapshot, owner),
        text = JSON.stringify(checked),
        bytes = utf8(text);
      const index = validateIndex({
        version: 1,
        backupId: checked.backupId,
        createdAtMs: checked.createdAtMs,
        currency: checked.ledger.wallet.currency,
        transactionCount: checked.ledger.transactions.length,
        photoCount: checked.photos.length,
        snapshotBytes: bytes.length,
        snapshotHash: sha256Hex(bytes),
        includesPhotos: checked.includesPhotos,
      });
      const existing = await run(() => sdk.getIndex(index.backupId), signal);
      current(signal);
      if (existing) {
        if (JSON.stringify(validateIndex(existing)) !== JSON.stringify(index))
          throw new Error('This cloud backup identifier already describes different data.');
        const savedBytes = await run(
          () => sdk.get(path(index.backupId, 'snapshot.json'), index.snapshotBytes),
          signal,
        );
        current(signal);
        if (
          !(savedBytes instanceof Uint8Array) ||
          savedBytes.length !== index.snapshotBytes ||
          sha256Hex(savedBytes) !== index.snapshotHash
        )
          throw new Error('The existing backup snapshot failed its integrity check.');
        for (const photo of checked.photos) {
          const storedPhoto = await run(
            () => sdk.get(path(index.backupId, `photos/${photo.sha256}`), photo.byteSize),
            signal,
          );
          current(signal);
          if (
            !(storedPhoto instanceof Uint8Array) ||
            storedPhoto.length !== photo.byteSize ||
            sha256Hex(storedPhoto) !== photo.sha256
          )
            throw new Error('An existing backup photo failed its integrity check.');
        }
        return index;
      }
      for (let i = 0; i < checked.photos.length; i++) {
        current(signal);
        const photo = checked.photos[i],
          image = await readPhoto(photo);
        current(signal);
        if (
          !(image instanceof Uint8Array) ||
          image.length !== photo.byteSize ||
          sha256Hex(image) !== photo.sha256
        )
          throw new Error('A captured photo changed or is missing. The backup remains pending.');
        onProgress(`Uploading photo ${i + 1} of ${checked.photos.length}…`);
        await putVerified(index.backupId, `photos/${photo.sha256}`, image, photo.mimeType, signal);
      }
      onProgress('Saving the wallet snapshot…');
      await putVerified(index.backupId, 'snapshot.json', bytes, 'application/json', signal);
      current(signal);
      await run(() => sdk.createIndex(index.backupId, index), signal);
      current(signal);
      const saved = await run(() => sdk.getIndex(index.backupId), signal);
      current(signal);
      if (!saved || JSON.stringify(validateIndex(saved)) !== JSON.stringify(index))
        throw new Error(
          'The cloud backup index could not be confirmed. Reopen the pending backup.',
        );
      return index;
    },
    async download(index, { signal } = {}) {
      index = validateIndex(index);
      const saved = await run(() => sdk.getIndex(index.backupId), signal);
      current(signal);
      if (!saved || JSON.stringify(validateIndex(saved)) !== JSON.stringify(index))
        throw new Error('This backup changed or is no longer available. Reload the list.');
      const bytes = await run(
        () => sdk.get(path(index.backupId, 'snapshot.json'), index.snapshotBytes),
        signal,
      );
      current(signal);
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.length !== index.snapshotBytes ||
        sha256Hex(bytes) !== index.snapshotHash
      )
        throw new Error('The downloaded backup failed its integrity check.');
      let snapshot;
      try {
        snapshot = validateSnapshot(JSON.parse(decodeUtf8(bytes)), owner);
      } catch {
        throw new Error('The downloaded wallet backup is invalid.');
      }
      if (
        snapshot.backupId !== index.backupId ||
        snapshot.createdAtMs !== index.createdAtMs ||
        snapshot.ledger.wallet.currency !== index.currency ||
        snapshot.ledger.transactions.length !== index.transactionCount ||
        snapshot.photos.length !== index.photoCount ||
        snapshot.includesPhotos !== index.includesPhotos
      )
        throw new Error('Backup metadata does not match its snapshot.');
      return snapshot;
    },
    async photo(snapshot, photo, { signal } = {}) {
      const checked = validateSnapshot(snapshot, owner),
        item = checked.photos.find((row) => row.sha256 === photo.sha256);
      if (!item) throw new Error('The photo is not part of this backup.');
      const bytes = await run(
        () => sdk.get(path(checked.backupId, `photos/${item.sha256}`), item.byteSize),
        signal,
      );
      current(signal);
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.length !== item.byteSize ||
        sha256Hex(bytes) !== item.sha256
      )
        throw new Error('A backup photo failed its integrity check.');
      return bytes;
    },
  });
}
module.exports = { validateIndex, createCloudTransport };
