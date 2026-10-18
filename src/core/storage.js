const { validateLedger, migrateLedger, collectStoredPhotoReferences } = require('./model');
const { photoKey, samePhotoRef } = require('./transactionContext');

const STORAGE_KEY = '@mymoney/core/v5';
const PREVIOUS_STORAGE_KEY = '@mymoney/core/v4';
const VERSION_3_STORAGE_KEY = '@mymoney/core/v3';
const VERSION_2_STORAGE_KEY = '@mymoney/core/v2';
const LEGACY_STORAGE_KEY = '@mymoney/local-demo/v1';
const MIGRATION_STORAGE_KEYS = Object.freeze([
  PREVIOUS_STORAGE_KEY,
  VERSION_3_STORAGE_KEY,
  VERSION_2_STORAGE_KEY,
  LEGACY_STORAGE_KEY,
]);
// A reference scan and owned-file deletion share this queue with all financial writes.
const queues = new Map();
function exclusive(key, work) {
  const before = queues.get(key) ?? Promise.resolve();
  const run = before.then(work),
    tail = run.then(
      () => undefined,
      () => undefined,
    );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

function createLedgerStorage(adapter, options = {}) {
  const key = options.key ?? STORAGE_KEY;
  if (options.legacyKey !== undefined && options.legacyKeys !== undefined)
    throw new Error('Provide one legacy key or an ordered legacy-key list, not both.');
  const sources =
    options.legacyKeys !== undefined
      ? options.legacyKeys
      : options.legacyKey !== undefined
        ? options.legacyKey === null
          ? []
          : [options.legacyKey]
        : key === STORAGE_KEY
          ? MIGRATION_STORAGE_KEYS
          : [];
  if (
    typeof key !== 'string' ||
    !key.trim() ||
    MIGRATION_STORAGE_KEYS.includes(key) ||
    !Array.isArray(sources) ||
    sources.some((source) => typeof source !== 'string' || !source.trim() || source === key) ||
    new Set(sources).size !== sources.length
  )
    throw new Error('Choose distinct, nonempty storage keys for the wallet and its legacy source.');
  const legacyKeys = [...sources];
  const readCurrentUnlocked = async () => {
    const text = await adapter.getItem(key);
    return text === null ? null : validateLedger(JSON.parse(text));
  };
  const referencesUnlocked = async () => {
    try {
      const references = new Map();
      for (const sourceKey of [key, ...legacyKeys]) {
        const text = await adapter.getItem(sourceKey);
        if (text === null) {
          if (sourceKey === key)
            return {
              complete: false,
              reason: 'The active saved wallet is missing. Photos have been retained.',
            };
          continue;
        }
        const saved = JSON.parse(text);
        if (sourceKey === key) validateLedger(saved);
        for (const photo of collectStoredPhotoReferences(saved)) {
          const id = photoKey(photo);
          if (references.has(id) && !samePhotoRef(references.get(id), photo))
            throw new Error('Ambiguous retained photo metadata.');
          references.set(id, photo);
        }
      }
      return { complete: true, references: [...references.values()] };
    } catch {
      return {
        complete: false,
        reason: 'Saved photo references could not be confirmed. Photos have been retained.',
      };
    }
  };
  return {
    key,
    readCurrent() {
      return exclusive(key, readCurrentUnlocked);
    },
    load() {
      return exclusive(key, async () => {
        const current = await readCurrentUnlocked();
        if (current !== null) return current;
        for (const source of legacyKeys) {
          const raw = await adapter.getItem(source);
          if (raw === null) continue;
          const migrated = migrateLedger(JSON.parse(raw), options.identityContext);
          await adapter.setItem(key, JSON.stringify(migrated));
          return migrated;
        }
        return null;
      });
    },
    save(ledger) {
      // Capture before a prior cleanup/write can outlive this caller's mutable draft.
      let captured;
      try {
        captured = JSON.parse(JSON.stringify(validateLedger(ledger)));
        validateLedger(captured);
      } catch (error) {
        return Promise.reject(error);
      }
      return exclusive(key, async () => {
        await adapter.setItem(key, JSON.stringify(captured));
        return captured;
      });
    },
    withRetainedPhotoReferences(work) {
      if (typeof work !== 'function')
        return Promise.reject(new Error('A photo reference callback is required.'));
      return exclusive(key, async () => work(await referencesUnlocked()));
    },
  };
}

async function loadOrCreateLedger(storage, createInitialLedger) {
  const saved = await storage.load();
  if (saved !== null) return { ledger: saved, created: false };
  const initial = validateLedger(createInitialLedger());
  const ledger = await storage.save(initial);
  return { ledger, created: true };
}

module.exports = {
  loadOrCreateLedger,
  STORAGE_KEY,
  PREVIOUS_STORAGE_KEY,
  VERSION_3_STORAGE_KEY,
  VERSION_2_STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  MIGRATION_STORAGE_KEYS,
  createLedgerStorage,
};
