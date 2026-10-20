const { encodeDataFamily, validateDataFamily } = require('../accounts/identity');
const { GOAL_KINDS } = require('../core/model');
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
    'The saved financial draft is unavailable. It has been retained; retry before editing.',
  );
};
function validateFormDraft(value) {
  if (
    !exact(value, ['kind', 'entityId', 'baseFingerprint', 'fields']) ||
    !['budget', 'goal'].includes(value.kind) ||
    !id(value.entityId) ||
    !/^[a-f0-9]{64}$/.test(value.baseFingerprint)
  )
    invalid();
  const fields = value.fields;
  if (value.kind === 'budget') {
    if (
      !exact(fields, ['categoryId', 'amount', 'period', 'anchorDate']) ||
      !text(fields.categoryId, 120) ||
      !text(fields.amount, 15) ||
      !text(fields.anchorDate, 10) ||
      !['week', 'month', 'year'].includes(fields.period)
    )
      invalid();
  } else if (
    !exact(fields, ['kind', 'amount']) ||
    !GOAL_KINDS.some((item) => item.value === fields.kind) ||
    !text(fields.amount, 15)
  )
    invalid();
  return clone(value);
}
function createFinancialFormDraftStore(storage, { family, incarnationId, kind, targetId = null }) {
  const familyKey = encodeDataFamily(validateDataFamily(family));
  if (
    !storage ||
    typeof storage.getItem !== 'function' ||
    typeof storage.setItem !== 'function' ||
    !id(incarnationId) ||
    !['budget', 'goal'].includes(kind) ||
    (targetId !== null && !id(targetId))
  )
    throw new Error('Choose an active wallet for this financial draft.');
  const owner = { familyKey, incarnationId, kind, targetId };
  const key = '@mymoney/financial-form-draft/v1/' + encodeURIComponent(JSON.stringify(owner));
  let queue = queues.get(storage);
  if (!queue) {
    queue = new Map();
    queues.set(storage, queue);
  }
  const serial = (work) => {
    const run = (queue.get(key) || Promise.resolve()).catch(() => {}).then(work);
    queue.set(key, run);
    return run.finally(() => {
      if (queue.get(key) === run) queue.delete(key);
    });
  };
  const check = (value) => {
    const record = validateFormDraft(value);
    if (record.kind !== kind || (targetId !== null && record.entityId !== targetId)) invalid();
    return record;
  };
  const decode = (raw) => {
    if (raw === null) return { revision: 0, record: null };
    if (typeof raw !== 'string' || raw.length > 10000) invalid();
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      invalid();
    }
    if (
      !exact(envelope, ['version', 'owner', 'revision', 'record']) ||
      envelope.version !== 1 ||
      JSON.stringify(envelope.owner) !== JSON.stringify(owner) ||
      !Number.isSafeInteger(envelope.revision) ||
      envelope.revision < 1
    )
      invalid();
    return {
      revision: envelope.revision,
      record: envelope.record === null ? null : check(envelope.record),
    };
  };
  const commit = async (record, expected) => {
    const old = decode(await storage.getItem(key));
    if (
      !Number.isSafeInteger(expected) ||
      old.revision !== expected ||
      old.revision >= Number.MAX_SAFE_INTEGER
    )
      throw new Error('This draft changed in another editor. Reopen it before continuing.');
    const next = { revision: old.revision + 1, record },
      raw = JSON.stringify({ version: 1, owner, ...next });
    try {
      await storage.setItem(key, raw);
    } catch {
      let actual;
      try {
        actual = await storage.getItem(key);
      } catch {
        throw new Error('The financial draft save could not be confirmed.');
      }
      if (actual !== raw)
        throw new Error('The financial draft was not saved. Keep this form open and retry.');
    }
    if ((await storage.getItem(key)) !== raw)
      throw new Error('The financial draft save could not be confirmed.');
    return clone(next);
  };
  return Object.freeze({
    key,
    owner: Object.freeze(owner),
    load: () => serial(async () => decode(await storage.getItem(key))),
    save(record, expected) {
      const captured = check(record);
      return serial(() => commit(captured, expected));
    },
    discard: (expected) => serial(() => commit(null, expected)),
  });
}
/** A serialized writer coalesces typing while preserving the latest unsaved text after errors. */
function createFormDraftWriter(store, initial) {
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
      const value = validateFormDraft(record),
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
            'The financial change was saved, but its older draft could not be cleared. Close and review the retained draft before editing again.',
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
module.exports = { validateFormDraft, createFinancialFormDraftStore, createFormDraftWriter };
