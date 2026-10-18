// Owned photo lifecycle; every native/file effect is injected.
const {
  validatePhotoInspection,
  validatePhotoRef,
  photoKey,
  samePhotoRef,
  MIME_EXTENSIONS,
} = require('../core/transactionContext');
const { encodeReminderOwner } = require('../reminders/store');
const MAX_PHOTO_ENTRIES = 20000;
const families = new Map();
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const outcome = (
  deleted = 0,
  retained = 0,
  pending = false,
  message = 'Photo storage is ready.',
) => ({ deleted, retained, pending, message });

function photoFamilyToken(family) {
  if (!object(family) || Object.keys(family).sort().join(',') !== 'actor,scope')
    throw new Error('A photo family needs explicit storage scope and account context.');
  return encodeReminderOwner({ ...family, incarnationId: 'photo-family' });
}

function validateEnvelope(value, familyToken) {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.familyToken !== familyToken ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_PHOTO_ENTRIES
  )
    throw new Error(
      'Saved photo ownership metadata is unavailable or invalid. Existing files have been retained.',
    );
  const seen = new Set();
  for (const entry of value.entries) {
    if (
      !object(entry) ||
      !['copying', 'ready', 'cleanup'].includes(entry.phase) ||
      !Number.isSafeInteger(entry.createdAtMs) ||
      entry.createdAtMs < 0 ||
      entry.createdAtMs > 8640000000000000
    )
      throw new Error(
        'Saved photo cleanup metadata is invalid. Existing files have been retained.',
      );
    validatePhotoRef(entry.photo);
    const key = photoKey(entry.photo);
    if (seen.has(key))
      throw new Error('Saved photo ownership is ambiguous. Existing files have been retained.');
    seen.add(key);
  }
  return value;
}

function createPhotoManager({ family, files, journal, ledgerStorage, now, newId }) {
  const familyToken = photoFamilyToken(family),
    journalKey = `@mymoney/photos/v1/${encodeURIComponent(familyToken)}`;
  if (
    !files ||
    !['inspectSource', 'copyIntoOwned', 'inspectOwned', 'uriFor', 'removeOwned'].every(
      (key) => typeof files[key] === 'function',
    ) ||
    typeof journal?.getItem !== 'function' ||
    typeof journal?.setItem !== 'function' ||
    typeof ledgerStorage?.withRetainedPhotoReferences !== 'function' ||
    typeof now !== 'function' ||
    typeof newId !== 'function'
  )
    throw new Error('Photo storage requires owned file, journal and ledger-reference adapters.');
  if (!families.has(familyToken))
    families.set(familyToken, { tail: Promise.resolve(), drafts: new Map(), pins: new Map() });
  const shared = families.get(familyToken),
    binding = {};
  let state = null,
    disposed = false,
    uncertain = false;
  const activeDrafts = new Set();
  const closedDrafts = new WeakSet();

  function queued(work, allowDisposed = false) {
    const run = shared.tail.then(async () => {
      if (disposed && !allowDisposed) throw new Error('This photo context is no longer active.');
      return work();
    });
    shared.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function load(create) {
    const raw = await journal.getItem(journalKey);
    if (raw === null) {
      if (state !== null || !create) {
        uncertain = true;
        throw new Error(
          'Saved photo ownership metadata is missing. Existing files have been retained.',
        );
      }
      await persist({ version: 1, familyToken, entries: [] });
      return;
    }
    state = validateEnvelope(JSON.parse(raw), familyToken);
    uncertain = false;
  }

  async function persist(next) {
    const intended = clone(validateEnvelope(next, familyToken)),
      bytes = JSON.stringify(intended);
    try {
      await journal.setItem(journalKey, bytes);
      state = intended;
      uncertain = false;
    } catch (error) {
      try {
        const actual = await journal.getItem(journalKey);
        if (actual === null) {
          if (state !== null) uncertain = true;
        } else {
          const observed = validateEnvelope(JSON.parse(actual), familyToken);
          state = observed;
          if (JSON.stringify(observed) === bytes) {
            uncertain = false;
            return;
          }
        }
      } catch {
        uncertain = true;
      }
      throw new Error(
        uncertain
          ? 'Photo metadata could not be confirmed. Files have been retained until recovery.'
          : 'Photo metadata could not be saved. Please try again.',
      );
    }
  }

  function session(handle, allowClosed = false) {
    const saved = shared.drafts.get(handle?.id);
    if (
      !saved ||
      saved.handle !== handle ||
      saved.binding !== binding ||
      (!allowClosed && (saved.closed || disposed))
    )
      throw new Error('This photo draft is no longer active.');
    return saved;
  }
  function pin(record, photo) {
    const key = photoKey(photo);
    record.staged.add(key);
    if (!shared.pins.has(key)) shared.pins.set(key, new Set());
    shared.pins.get(key).add(record);
  }
  function unpin(record, key) {
    record.staged.delete(key);
    const pins = shared.pins.get(key);
    pins?.delete(record);
    if (pins?.size === 0) shared.pins.delete(key);
  }
  function updatePhase(key, phase) {
    return persist({
      ...state,
      entries: state.entries.map((entry) =>
        photoKey(entry.photo) === key ? { ...entry, phase } : entry,
      ),
    });
  }

  async function cleanup() {
    if (uncertain || !state)
      return outcome(
        0,
        state?.entries.length ?? 0,
        true,
        'Photo cleanup is pending because saved ownership is not confirmed.',
      );
    return ledgerStorage.withRetainedPhotoReferences(async (snapshot) => {
      if (!snapshot.complete) return outcome(0, state.entries.length, true, snapshot.reason);
      const references = new Map();
      try {
        for (const photo of snapshot.references) {
          validatePhotoRef(photo);
          const key = photoKey(photo);
          if (references.has(key) && !samePhotoRef(references.get(key), photo))
            throw new Error('Ambiguous photo references.');
          references.set(key, photo);
        }
      } catch {
        return outcome(
          0,
          state.entries.length,
          true,
          'Saved photo references are ambiguous. Files have been retained.',
        );
      }
      let deleted = 0,
        retained = 0,
        pending = false;
      for (const original of [...state.entries]) {
        const key = photoKey(original.photo);
        if (shared.pins.get(key)?.size) {
          retained++;
          continue;
        }
        if (references.has(key)) {
          retained++;
          if (!samePhotoRef(references.get(key), original.photo)) pending = true;
          continue;
        }
        try {
          if (original.phase !== 'cleanup') await updatePhase(key, 'cleanup');
          try {
            await files.removeOwned(original.photo);
          } catch {
            /* Verify an uncertain delete by checking its target. */
          }
          if ((await files.inspectOwned(original.photo)) !== null) {
            pending = true;
            retained++;
            continue;
          }
          await persist({
            ...state,
            entries: state.entries.filter((entry) => photoKey(entry.photo) !== key),
          });
          deleted++;
        } catch {
          pending = true;
          retained++;
          if (uncertain) break;
        }
      }
      return outcome(
        deleted,
        retained,
        pending,
        pending
          ? 'Your records are unchanged. Some owned photo cleanup is pending.'
          : 'Owned photo cleanup is complete; referenced and active draft photos were retained.',
      );
    });
  }

  function closeRecord(record) {
    record.closed = true;
  }
  async function closeAfterCopies(record) {
    for (const key of [...record.staged]) unpin(record, key);
    if (shared.drafts.get(record.handle.id) === record) shared.drafts.delete(record.handle.id);
    activeDrafts.delete(record);
    closedDrafts.add(record.handle);
    await load(true);
    return cleanup();
  }

  return {
    familyToken,
    journalKey,
    initialize() {
      return queued(async () => {
        try {
          await load(true);
          return await cleanup();
        } catch {
          return outcome(
            0,
            state?.entries.length ?? 0,
            true,
            'Photo ownership could not be opened. Files were retained; retry when storage is available.',
          );
        }
      });
    },
    beginDraft(ownerIncarnationId) {
      if (disposed || !identifier(ownerIncarnationId))
        throw new Error('Choose an active wallet before selecting a photo.');
      const id = newId('draft');
      if (!identifier(id) || shared.drafts.has(id))
        throw new Error('The photo draft identifier could not be created.');
      const handle = Object.freeze({ id, ownerIncarnationId }),
        record = { handle, binding, closed: false, staged: new Set() };
      shared.drafts.set(id, record);
      activeDrafts.add(record);
      return handle;
    },
    stage(handle, picked) {
      let record;
      try {
        record = session(handle);
        if (
          !object(picked) ||
          typeof picked.uri !== 'string' ||
          picked.uri.length > 4096 ||
          !/^(?:file|content):\/\//.test(picked.uri)
        )
          throw new Error('Choose a local image from the system photo picker.');
      } catch (error) {
        return Promise.reject(error);
      }
      const sourceUri = picked.uri;
      return queued(async () => {
        await load(true);
        session(handle);
        const info = validatePhotoInspection(await files.inspectSource(sourceUri));
        session(handle);
        const id = newId('photo');
        const photo = validatePhotoRef(
          {
            id,
            ownerIncarnationId: handle.ownerIncarnationId,
            fileName: `${id}.${MIME_EXTENSIONS[info.mimeType]}`,
            ...info,
          },
          handle.ownerIncarnationId,
        );
        const key = photoKey(photo);
        if (state.entries.length >= MAX_PHOTO_ENTRIES)
          throw new Error(
            'Photo storage has reached its managed-file limit. Finish pending cleanup before adding another image.',
          );
        if (
          state.entries.some((entry) => photoKey(entry.photo) === key) ||
          (await files.inspectOwned(photo)) !== null
        )
          throw new Error('This photo filename is already in use. Please try again.');
        session(handle);
        const createdAtMs = now();
        if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0 || createdAtMs > 8640000000000000)
          throw new Error('Photo storage requires a valid creation time.');
        await persist({
          ...state,
          entries: [...state.entries, { photo, phase: 'copying', createdAtMs }],
        });
        pin(record, photo);
        try {
          session(handle);
          await files.copyIntoOwned(sourceUri, photo);
          const actual = await files.inspectOwned(photo);
          if (actual === null) throw new Error('The copied image is missing.');
          validatePhotoInspection(actual);
          if (
            ['mimeType', 'width', 'height', 'byteSize'].some(
              (field) => actual[field] !== photo[field],
            )
          )
            throw new Error('The copied image did not match the selected image.');
          session(handle);
          await updatePhase(key, 'ready');
          session(handle);
          return Object.freeze({ ...photo });
        } catch (error) {
          unpin(record, key);
          if (!uncertain && state.entries.some((entry) => photoKey(entry.photo) === key)) {
            try {
              await updatePhase(key, 'cleanup');
              await cleanup();
            } catch {
              /* Durable copy intent remains recoverable. */
            }
          }
          throw new Error(
            record.closed || disposed
              ? 'This photo selection was canceled. Its owned files will be cleaned up safely.'
              : 'The image could not be copied and verified. Your previous transaction remains unchanged; retry the selection.',
          );
        }
      });
    },
    closeDraft(handle) {
      if (object(handle) && closedDrafts.has(handle)) return Promise.resolve(outcome());
      let record;
      try {
        record = session(handle, true);
      } catch (error) {
        return Promise.reject(error);
      }
      closeRecord(record);
      return queued(() => closeAfterCopies(record), true).catch(() =>
        outcome(
          0,
          record.staged.size,
          true,
          'The draft was closed, but its owned photo cleanup needs a retry.',
        ),
      );
    },
    queueCleanup(photos) {
      let captured;
      try {
        if (!Array.isArray(photos)) throw new Error('Choose valid owned photos for cleanup.');
        captured = photos.map((photo) => ({ ...validatePhotoRef(photo) }));
      } catch (error) {
        return Promise.reject(error);
      }
      return queued(async () => {
        try {
          await load(true);
          let unknown = 0;
          const keys = new Set();
          for (const photo of captured) {
            const key = photoKey(photo),
              entry = state.entries.find((item) => photoKey(item.photo) === key);
            if (!entry) {
              // A previous close/root cleanup may already have removed this target.
              // An absent journal entry permits inspection only, never deletion.
              try {
                if ((await files.inspectOwned(photo)) === null) continue;
              } catch {
                /* Unknown existence remains retained/pending. */
              }
              unknown++;
              continue;
            }
            if (!samePhotoRef(entry.photo, photo)) {
              unknown++;
              continue;
            }
            keys.add(key);
          }
          if (keys.size)
            await persist({
              ...state,
              entries: state.entries.map((entry) =>
                keys.has(photoKey(entry.photo)) ? { ...entry, phase: 'cleanup' } : entry,
              ),
            });
          const result = await cleanup();
          return unknown
            ? {
                ...result,
                retained: result.retained + unknown,
                pending: true,
                message:
                  'Some files could not be confirmed as managed by this photo family and were retained.',
              }
            : result;
        } catch {
          return outcome(
            0,
            captured.length,
            true,
            'Photo cleanup could not be confirmed. Files have been retained.',
          );
        }
      });
    },
    retryCleanup() {
      return queued(async () => {
        try {
          await load(true);
          return await cleanup();
        } catch {
          return outcome(
            0,
            state?.entries.length ?? 0,
            true,
            'Photo cleanup is pending until saved ownership can be read.',
          );
        }
      });
    },
    async inspect(photo) {
      validatePhotoRef(photo);
      const info = await files.inspectOwned(photo);
      return info === null ? null : validatePhotoInspection(info);
    },
    uriFor(photo) {
      validatePhotoRef(photo);
      return files.uriFor(photo);
    },
    drain() {
      return shared.tail;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const closing = [...activeDrafts];
      closing.forEach(closeRecord);
      void queued(async () => {
        for (const record of closing) {
          for (const key of [...record.staged]) unpin(record, key);
          if (shared.drafts.get(record.handle.id) === record)
            shared.drafts.delete(record.handle.id);
          activeDrafts.delete(record);
          closedDrafts.add(record.handle);
        }
        try {
          await load(true);
          await cleanup();
        } catch {
          /* Preserve owned copy/cleanup intent for the next binding. */
        }
      }, true);
    },
  };
}

module.exports = { MAX_PHOTO_ENTRIES, photoFamilyToken, createPhotoManager };
