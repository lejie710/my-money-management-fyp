const MAX_NOTES_LENGTH = 2000;
const MAX_PERSON_NAME_LENGTH = 120;
const MAX_PLACE_LABEL_LENGTH = 240;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_PHOTO_DIMENSION = 16384;
const MAX_PHOTO_PIXELS = 40000000;
const MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value);
const ownKeys = (value, allowed) =>
  object(value) && Object.keys(value).every((key) => allowed.includes(key));
const clone = (value) => JSON.parse(JSON.stringify(value));

function validatePhotoInspection(value) {
  if (
    !object(value) ||
    !Object.hasOwn(MIME_EXTENSIONS, value.mimeType) ||
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    value.width < 1 ||
    value.height < 1 ||
    value.width > MAX_PHOTO_DIMENSION ||
    value.height > MAX_PHOTO_DIMENSION ||
    value.width * value.height > MAX_PHOTO_PIXELS ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 1 ||
    value.byteSize > MAX_PHOTO_BYTES
  )
    throw new Error(
      'Choose a supported JPEG, PNG or WebP image up to 10 MiB and 40 million pixels.',
    );
  return {
    mimeType: value.mimeType,
    width: value.width,
    height: value.height,
    byteSize: value.byteSize,
  };
}

function validatePhotoRef(value, ownerIncarnationId) {
  validatePhotoInspection(value);
  if (
    !ownKeys(value, [
      'id',
      'ownerIncarnationId',
      'fileName',
      'mimeType',
      'width',
      'height',
      'byteSize',
    ]) ||
    typeof value.id !== 'string' ||
    !/^photo-[a-z0-9-]{1,80}$/.test(value.id) ||
    !validId(value.ownerIncarnationId) ||
    (ownerIncarnationId !== undefined && value.ownerIncarnationId !== ownerIncarnationId) ||
    value.fileName !== `${value.id}.${MIME_EXTENSIONS[value.mimeType]}`
  )
    throw new Error('The saved photo reference is invalid or belongs to another wallet.');
  return value;
}

function photoKey(photo) {
  validatePhotoRef(photo);
  return JSON.stringify([photo.ownerIncarnationId, photo.id, photo.fileName]);
}

function samePhotoRef(left, right) {
  return (
    photoKey(left) === photoKey(right) &&
    ['mimeType', 'width', 'height', 'byteSize'].every((key) => left[key] === right[key])
  );
}

function emptyTransactionContext() {
  return { notes: '', photo: null, withPerson: null, location: null };
}

function normalizeNotes(value) {
  if (value === null) return '';
  if (typeof value !== 'string' || value.length > MAX_NOTES_LENGTH)
    throw new Error('Notes must contain no more than 2,000 characters.');
  return value.trim() ? value : '';
}

function normalizePerson(value) {
  if (value === null) return null;
  if (
    !ownKeys(value, ['name', 'source']) ||
    typeof value.name !== 'string' ||
    !['manual', 'contacts', 'recorded'].includes(value.source)
  )
    throw new Error('Choose or enter a valid person name.');
  const name = value.name.trim();
  if (name.length > MAX_PERSON_NAME_LENGTH)
    throw new Error('Person name must contain no more than 120 characters.');
  return name ? { name, source: value.source } : null;
}

function normalizePlace(value) {
  if (value === null) return null;
  if (
    !ownKeys(value, ['label', 'source']) ||
    typeof value.label !== 'string' ||
    !['manual', 'device', 'map', 'recorded'].includes(value.source)
  )
    throw new Error('Choose or enter a valid place label.');
  const label = value.label.trim();
  if (label.length > MAX_PLACE_LABEL_LENGTH)
    throw new Error('Place label must contain no more than 240 characters.');
  return label ? { label, source: value.source } : null;
}

function validateTransactionContext(value, ownerIncarnationId) {
  if (
    !object(value) ||
    !['notes', 'photo', 'withPerson', 'location'].every((key) => Object.hasOwn(value, key))
  )
    throw new Error('Saved transaction context has an invalid format.');
  if (typeof value.notes !== 'string' || normalizeNotes(value.notes) !== value.notes)
    throw new Error('Saved notes have an invalid format.');
  if (value.photo !== null) validatePhotoRef(value.photo, ownerIncarnationId);
  for (const [key, normalizer] of [
    ['withPerson', normalizePerson],
    ['location', normalizePlace],
  ]) {
    const normalized = normalizer(value[key]);
    if (JSON.stringify(normalized) !== JSON.stringify(value[key])) {
      // Object-key ordering is not a semantic difference; only canonical values matter.
      const label = key === 'withPerson' ? 'name' : 'label';
      if (
        normalized === null ||
        value[key] === null ||
        normalized[label] !== value[key][label] ||
        normalized.source !== value[key].source
      )
        throw new Error('Saved optional transaction labels have an invalid format.');
    }
  }
  return value;
}

function contextForTransaction(transaction) {
  if (!object(transaction)) throw new Error('Choose a valid transaction.');
  if (transaction.context === undefined) return emptyTransactionContext();
  validateTransactionContext(transaction.context);
  return clone(transaction.context);
}

function normalizeContextPatch(patch) {
  if (patch === null) return null;
  if (!ownKeys(patch, ['notes', 'photo', 'withPerson', 'location']))
    throw new Error('Transaction context contains an unsupported field.');
  const normalized = {};
  if (patch.notes !== undefined) normalized.notes = normalizeNotes(patch.notes);
  if (patch.photo !== undefined)
    normalized.photo = patch.photo === null ? null : clone(validatePhotoRef(patch.photo));
  if (patch.withPerson !== undefined) normalized.withPerson = normalizePerson(patch.withPerson);
  if (patch.location !== undefined) normalized.location = normalizePlace(patch.location);
  return normalized;
}

function applyContextPatch(transaction, patch, ownerIncarnationId) {
  const normalized = normalizeContextPatch(patch);
  const context =
    normalized === null
      ? emptyTransactionContext()
      : { ...contextForTransaction(transaction), ...normalized };
  validateTransactionContext(context, ownerIncarnationId);
  return { ...transaction, context };
}

function promoteLegacyContext(transaction, ownerIncarnationId) {
  if (transaction.context !== undefined) {
    validateTransactionContext(transaction.context, ownerIncarnationId);
    return transaction;
  }
  const context = emptyTransactionContext();
  let promoted = false;
  if (typeof transaction.notes === 'string' && transaction.notes.length <= MAX_NOTES_LENGTH) {
    context.notes = normalizeNotes(transaction.notes);
    promoted = promoted || Boolean(context.notes);
  }
  if (
    typeof transaction.withPerson === 'string' &&
    transaction.withPerson.trim().length <= MAX_PERSON_NAME_LENGTH
  ) {
    context.withPerson = normalizePerson({ name: transaction.withPerson, source: 'recorded' });
    promoted = promoted || context.withPerson !== null;
  }
  if (
    typeof transaction.location === 'string' &&
    transaction.location.trim().length <= MAX_PLACE_LABEL_LENGTH
  ) {
    context.location = normalizePlace({ label: transaction.location, source: 'recorded' });
    promoted = promoted || context.location !== null;
  }
  // Old URLs remain untouched legacy metadata. They are never fetched or promoted.
  return promoted ? { ...transaction, context } : transaction;
}

module.exports = {
  MAX_NOTES_LENGTH,
  MAX_PERSON_NAME_LENGTH,
  MAX_PLACE_LABEL_LENGTH,
  MAX_PHOTO_BYTES,
  MAX_PHOTO_DIMENSION,
  MAX_PHOTO_PIXELS,
  MIME_EXTENSIONS,
  validatePhotoInspection,
  validatePhotoRef,
  photoKey,
  samePhotoRef,
  emptyTransactionContext,
  validateTransactionContext,
  contextForTransaction,
  normalizeContextPatch,
  applyContextPatch,
  promoteLegacyContext,
};
