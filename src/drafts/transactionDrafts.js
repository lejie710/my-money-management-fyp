const { encodeDataFamily, validateDataFamily } = require('../accounts/identity');
const { validateLedger } = require('../core/model');
const { sha256Hex } = require('../cloud/hash');
const { utf8 } = require('../cloud/backupFormat');
const queues = new WeakMap();
const clone = (value) => JSON.parse(JSON.stringify(value));
const exact = (value, keys) =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const text = (value, max) => typeof value === 'string' && value.length <= max;
const id = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value);
const invalid = () => {
  throw new Error(
    'The saved entry draft is unavailable. It has been retained; retry before continuing.',
  );
};
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function ledgerFingerprint(ledger) {
  return sha256Hex(utf8(JSON.stringify(canonical(validateLedger(ledger)))));
}
function validateDraft(value) {
  if (
    !exact(value, ['baseFingerprint', 'transactionId', 'fields', 'details', 'photoIntent']) ||
    !/^[a-f0-9]{64}$/.test(value.baseFingerprint) ||
    !id(value.transactionId)
  )
    invalid();
  const f = value.fields,
    details = value.details;
  if (
    !exact(f, ['type', 'title', 'categoryId', 'amount', 'date']) ||
    !['income', 'expense', 'debt'].includes(f.type) ||
    !text(f.title, 80) ||
    !text(f.categoryId, 120) ||
    !text(f.amount, 15) ||
    !text(f.date, 10)
  )
    invalid();
  if (
    !exact(details, ['notes', 'person', 'place']) ||
    !text(details.notes, 2000) ||
    !['keep', 'remove', 'repick'].includes(value.photoIntent)
  )
    invalid();
  if (
    details.person !== null &&
    (!exact(details.person, ['name', 'source']) ||
      !text(details.person.name, 120) ||
      !['manual', 'contacts', 'recorded'].includes(details.person.source))
  )
    invalid();
  if (
    details.place !== null &&
    (!exact(details.place, ['label', 'source']) ||
      !text(details.place.label, 240) ||
      !['manual', 'device', 'map', 'recorded'].includes(details.place.source))
  )
    invalid();
  return clone(value);
}
function createTransactionDraftStore(storage, { family, incarnationId, transactionId = null }) {
  const familyKey = encodeDataFamily(validateDataFamily(family));
  if (
    !storage ||
    typeof storage.getItem !== 'function' ||
    typeof storage.setItem !== 'function' ||
    !id(incarnationId) ||
    (transactionId !== null && !id(transactionId))
  )
    throw new Error('Choose an active wallet for the entry draft.');
  const owner = { familyKey, incarnationId, transactionId };
  const key = '@mymoney/transaction-draft/v1/' + encodeURIComponent(JSON.stringify(owner));
  let shared = queues.get(storage);
  if (!shared) {
    shared = new Map();
    queues.set(storage, shared);
  }
  const serial = (work) => {
    const result = (shared.get(key) || Promise.resolve()).catch(() => {}).then(work);
    shared.set(key, result);
    return result.finally(() => {
      if (shared.get(key) === result) shared.delete(key);
    });
  };
  const decode = (raw) => {
    if (raw === null) return { revision: 0, record: null };
    if (typeof raw !== 'string' || raw.length > 20000) invalid();
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      invalid();
    }
    if (
      !exact(value, ['version', 'owner', 'revision', 'record']) ||
      value.version !== 1 ||
      JSON.stringify(value.owner) !== JSON.stringify(owner) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1
    )
      invalid();
    const record = value.record === null ? null : validateDraft(value.record);
    if (record && transactionId !== null && record.transactionId !== transactionId) invalid();
    return { revision: value.revision, record };
  };
  const commit = async (record, expectedRevision) => {
    const old = decode(await storage.getItem(key));
    if (
      !Number.isSafeInteger(expectedRevision) ||
      old.revision !== expectedRevision ||
      old.revision >= Number.MAX_SAFE_INTEGER
    )
      throw new Error('This entry draft changed in another editor. Reopen it before continuing.');
    const next = { revision: old.revision + 1, record };
    const raw = JSON.stringify({ version: 1, owner, ...next });
    try {
      await storage.setItem(key, raw);
    } catch {
      let actual;
      try {
        actual = await storage.getItem(key);
      } catch {
        throw new Error('The draft save could not be confirmed. Retry to reopen its saved state.');
      }
      if (actual !== raw)
        throw new Error('The entry draft was not saved. Keep this editor open and retry.');
    }
    if ((await storage.getItem(key)) !== raw)
      throw new Error('The draft save could not be confirmed. Retry to reopen its saved state.');
    return clone(next);
  };
  return Object.freeze({
    key,
    owner: Object.freeze(owner),
    load: () => serial(async () => decode(await storage.getItem(key))),
    save(record, expectedRevision) {
      const copy = validateDraft(record);
      if (transactionId !== null && copy.transactionId !== transactionId) invalid();
      return serial(() => commit(copy, expectedRevision));
    },
    discard: (expectedRevision) => serial(() => commit(null, expectedRevision)),
  });
}
/** A serialized writer coalesces typing while preserving the latest unsaved text after errors. */
function createDraftWriter(store, initial) {
  let revision = initial.revision,
    confirmed = initial.record ? JSON.stringify(initial.record) : null;
  let pending = null,
    running = null,
    retired = false;
  let view = Object.freeze({ saving: false, error: '', saved: initial.record !== null, revision });
  const listeners = new Set();
  const publish = (next) => {
    view = Object.freeze({ ...view, ...next });
    for (const fn of listeners) fn();
  };
  const run = () => {
    if (running) return running;
    if (!pending) return Promise.resolve(!view.error);
    publish({ saving: true, error: '' });
    running = Promise.resolve()
      .then(async () => {
        while (pending) {
          const value = pending;
          pending = null;
          try {
            const result = await store.save(value, revision);
            revision = result.revision;
            confirmed = JSON.stringify(result.record);
            publish({ saved: true, revision, error: '' });
          } catch {
            // Recover a completed write whose readback failed before retrying its exact generation.
            try {
              const result = await store.load();
              if (JSON.stringify(result.record) === JSON.stringify(value)) {
                revision = result.revision;
                confirmed = JSON.stringify(result.record);
                publish({ saved: true, revision, error: '' });
                continue;
              }
            } catch {}
            if (!pending) pending = value;
            publish({
              error:
                'This draft has not been confirmed saved. Keep this editor open and retry saving the draft.',
            });
            return false;
          }
        }
        return true;
      })
      .finally(() => {
        running = null;
        publish({ saving: false });
      });
    return running;
  };
  return Object.freeze({
    getSnapshot: () => view,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    enqueue(record) {
      if (retired) return;
      const value = validateDraft(record),
        raw = JSON.stringify(value);
      if (!pending && !running && raw === confirmed) return;
      pending = value;
      if (!view.error) void run();
    },
    flush: () => run(),
    async discard() {
      if (pending || running) {
        if (!(await run())) return false;
      }
      const expected = revision;
      try {
        const next = await store.discard(expected);
        revision = next.revision;
        confirmed = null;
        pending = null;
        publish({ saved: false, revision, error: '' });
        return true;
      } catch {
        publish({
          error:
            'The transaction was saved, but its older draft could not be cleared. Reopen this draft before recording another entry.',
        });
        return false;
      }
    },
    activate() {
      retired = false;
    },
    retire() {
      retired = true;
    },
  });
}
module.exports = {
  ledgerFingerprint,
  validateDraft,
  createTransactionDraftStore,
  createDraftWriter,
};
