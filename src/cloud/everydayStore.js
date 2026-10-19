const { validateDataFamily } = require('../accounts/identity');
const { photoKey, samePhotoRef } = require('../core/transactionContext');
const { isEmptyTarget } = require('./backupFormat');
const { sha256Hex } = require('./hash');
const {
  everydayKeys,
  checkedLedger,
  ledgerPhotos,
  decodeRecord,
  makeRecord,
  operationId,
  validateOperation,
} = require('./everydayFormat');
const queues = new Map();
const clone = (value) => JSON.parse(JSON.stringify(value));
function exclusive(key, work) {
  const before = queues.get(key) ?? Promise.resolve();
  const result = before.then(work),
    tail = result.then(
      () => {},
      () => {},
    );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return result;
}
const error = (code, message) => Object.assign(new Error(message), { code });
function createEverydayCloudStore(options) {
  const family = validateDataFamily(options.family),
    keys = everydayKeys(family);
  const owner = { projectId: family.actor.projectId, uid: family.actor.uid };
  const device = options.deviceStorage;
  if (
    !device ||
    ['getItem', 'setItem', 'removeItem'].some((k) => typeof device[k] !== 'function') ||
    ['ports', 'assertCurrent', 'now', 'newId'].some((k) => typeof options[k] !== 'function')
  )
    throw new Error('Cloud wallet storage requires scoped device and server adapters.');
  let cache = null,
    draft = null,
    busy = false,
    status = 'idle',
    message = '',
    photosPending = 0,
    offlineSince = null;
  let state = Object.freeze({
    status,
    busy,
    message,
    revision: null,
    readOnly: true,
    draft: null,
    photosPending,
  });
  const listeners = new Set();
  const current = () => options.assertCurrent(family);
  const notify = () => {
    const next = {
      status,
      busy,
      message,
      revision: cache?.record.revision ?? null,
      readOnly: status !== 'online' || !!draft,
      photosPending,
      draft: draft
        ? {
            token: draft.operationId,
            phase: draft.phase,
            baseRevision: draft.baseRevision,
            transactions: draft.ledger.transactions.length,
            photos: ledgerPhotos(draft.ledger).length,
          }
        : null,
    };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = Object.freeze(next);
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  };
  const checkedCache = (value) => {
    if (
      !value ||
      value.version !== 1 ||
      value.familyToken !== keys.familyToken ||
      Object.keys(value).sort().join(',') !== 'confirmedAtMs,familyToken,record,version' ||
      !Number.isSafeInteger(value.confirmedAtMs) ||
      value.confirmedAtMs < 0
    )
      throw error(
        'CACHE_INVALID',
        'The last confirmed cloud wallet cannot be read. Existing data is retained.',
      );
    decodeRecord(value.record, owner);
    return value;
  };
  const checkedDraft = (value) => {
    if (
      !value ||
      value.version !== 1 ||
      value.familyToken !== keys.familyToken ||
      Object.keys(value).sort().join(',') !==
        'baseHash,baseRevision,createdAtMs,familyToken,ledger,operationId,phase,record,version' ||
      !['draft', 'submitted', 'conflict'].includes(value.phase) ||
      !Number.isSafeInteger(value.baseRevision) ||
      value.baseRevision < 0 ||
      (value.baseHash !== null && !/^[a-f0-9]{64}$/.test(value.baseHash)) ||
      !Number.isSafeInteger(value.createdAtMs) ||
      value.createdAtMs < 0
    )
      throw error(
        'DRAFT_INVALID',
        'Saved cloud draft recovery is unavailable. Existing data is retained.',
      );
    operationId(value.operationId);
    checkedLedger(value.ledger);
    if (value.record) {
      const decoded = decodeRecord(value.record, owner);
      if (
        value.record.operationId !== value.operationId ||
        value.record.revision !== value.baseRevision + 1 ||
        JSON.stringify(decoded.ledger) !== JSON.stringify(value.ledger)
      )
        throw error('DRAFT_INVALID', 'The saved cloud draft does not match its operation.');
    } else if (value.phase !== 'draft')
      throw error('DRAFT_INVALID', 'The submitted cloud draft is incomplete.');
    return value;
  };
  async function readLocal() {
    try {
      const [rawCache, rawDraft] = await Promise.all([
        device.getItem(keys.cache),
        device.getItem(keys.draft),
      ]);
      current();
      const nextCache = rawCache === null ? null : checkedCache(JSON.parse(rawCache));
      const nextDraft = rawDraft === null ? null : checkedDraft(JSON.parse(rawDraft));
      cache = nextCache;
      draft = nextDraft;
    } catch {
      status = 'unavailable';
      message = 'Saved cloud wallet recovery could not be read. No data was replaced.';
      notify();
      throw error('LOCAL_UNAVAILABLE', message);
    }
  }
  async function writeExact(key, value) {
    current();
    const raw = value === null ? null : JSON.stringify(value);
    try {
      if (raw === null) await device.removeItem(key);
      else await device.setItem(key, raw);
    } catch {}
    if ((await device.getItem(key)) !== raw)
      throw error(
        'LOCAL_UNCONFIRMED',
        'Device persistence is unconfirmed. Reconcile the cloud wallet before continuing.',
      );
    current();
  }
  async function retainRecord(value) {
    const record = decodeRecord(value, owner).record;
    const next = {
      version: 1,
      familyToken: keys.familyToken,
      record,
      confirmedAtMs: options.now(),
    };
    await writeExact(keys.cache, next);
    cache = next;
    return decodeRecord(record, owner);
  }
  async function retainDraft(value) {
    if (value !== null) checkedDraft(value);
    await writeExact(keys.draft, value);
    draft = value;
    notify();
  }
  async function serverRecord() {
    current();
    const value = await options.ports().readWallet(keys.walletId);
    current();
    return value === null ? null : decodeRecord(value, owner).record;
  }
  async function receiptFor(pending) {
    const value = await options.ports().readOperation(keys.walletId, pending.operationId);
    current();
    return value === null ? null : validateOperation(value, owner, pending.operationId);
  }
  async function reconcileSubmitted(record) {
    if (!draft || draft.phase !== 'submitted') return;
    const receipt = await receiptFor(draft);
    if (receipt) {
      if (
        !draft.record ||
        receipt.payloadHash !== draft.record.payloadHash ||
        receipt.revision !== draft.record.revision ||
        !record ||
        record.revision < receipt.revision
      )
        throw error('REMOTE_INCONSISTENT', 'The cloud save receipt does not match its wallet.');
      await retainRecord(record);
      await retainDraft(null);
      return;
    }
    if (record && record.revision > draft.baseRevision) {
      await retainRecord(record);
      await retainDraft({ ...draft, phase: 'conflict' });
      return;
    }
    throw error(
      'SAVE_UNKNOWN',
      'The submitted save is still unconfirmed. Retry that same operation in Cloud Wallet.',
    );
  }
  async function readConfirmed(allowOffline) {
    await readLocal();
    if (
      allowOffline &&
      cache &&
      draft?.phase !== 'submitted' &&
      status === 'offline' &&
      offlineSince !== null &&
      options.now() - offlineSince < 15000
    )
      return decodeRecord(cache.record, owner);
    let record;
    try {
      record = await serverRecord();
      offlineSince = null;
      await reconcileSubmitted(record);
      if (record) {
        const value = await retainRecord(record);
        status = draft ? (draft.phase === 'conflict' ? 'conflict' : 'draft') : 'online';
        message = draft
          ? 'A saved cloud draft needs an explicit decision.'
          : 'Cloud wallet is up to date.';
        notify();
        return value;
      }
      if (cache)
        throw error(
          'REMOTE_MISSING',
          'The cloud wallet is missing. Its last confirmed device copy was retained.',
        );
      status = draft ? 'draft' : 'online';
      message = 'The cloud account has no wallet yet.';
      notify();
      return null;
    } catch (cause) {
      if (draft?.phase === 'submitted') {
        status = 'needs-recovery';
        message = 'A submitted cloud save is unconfirmed. Resolve it before editing.';
        notify();
        throw error('SAVE_UNKNOWN', message);
      }
      if (
        allowOffline &&
        cache &&
        !['REMOTE_INCONSISTENT', 'LOCAL_UNCONFIRMED', 'REMOTE_MISSING'].includes(cause?.code)
      ) {
        offlineSince = options.now();
        status = 'offline';
        message =
          'Showing the last server-confirmed wallet. Financial edits require a server connection.';
        notify();
        return decodeRecord(cache.record, owner);
      }
      status = 'unavailable';
      message = 'The cloud wallet could not be confirmed. Existing device data was retained.';
      notify();
      throw error('CLOUD_UNAVAILABLE', message);
    }
  }
  async function hydrate(decoded) {
    if (!decoded || !decoded.photos.length || !options.files || status === 'offline')
      return decoded?.ledger ?? null;
    const started = Date.now();
    const withinHydrationBudget = () => {
      current();
      if (Date.now() - started > 30000)
        throw error('PHOTO_PENDING', 'Photo downloads can continue on the next explicit refresh.');
    };
    try {
      await options.files.hydrate(
        family,
        api,
        decoded.photos,
        (item) => {
          withinHydrationBudget();
          return options.ports().getPhoto(keys.walletId, item.sha256, item.photo.byteSize);
        },
        withinHydrationBudget,
      );
      current();
      photosPending = 0;
    } catch {
      current(); // Identity retirement is not an optional photo-download failure.
      photosPending = decoded.photos.length;
      message =
        'Financial records are confirmed. Some attached photos still need to download; refresh when connected.';
    }
    current();
    notify();
    return decoded.ledger;
  }
  async function makePlan(pending) {
    if (pending.record) return pending;
    const photos = [];
    for (const photo of ledgerPhotos(pending.ledger)) {
      if (!options.files)
        throw error('PHOTO_UNAVAILABLE', 'Attached photos require the configured file adapter.');
      current();
      const bytes = await options.files.read(family, photo);
      current();
      if (!(bytes instanceof Uint8Array) || bytes.length !== photo.byteSize)
        throw error('PHOTO_UNAVAILABLE', 'An attached photo could not be read completely.');
      photos.push({ photo, sha256: sha256Hex(bytes) });
    }
    const record = makeRecord({
      ledger: pending.ledger,
      photos,
      owner,
      revision: pending.baseRevision + 1,
      id: pending.operationId,
      nowMs: pending.createdAtMs,
    });
    const next = { ...pending, record };
    await retainDraft(next);
    return next;
  }
  async function uploadPhotos(plan) {
    const decoded = decodeRecord(plan.record, owner),
      ports = options.ports();
    for (const item of decoded.photos) {
      current();
      const found = await ports.headPhoto(keys.walletId, item.sha256);
      current();
      if (
        found &&
        (found.size !== item.photo.byteSize ||
          found.sha256 !== item.sha256 ||
          found.contentType !== item.photo.mimeType)
      )
        throw error('PHOTO_CHANGED', 'The cloud photo metadata differs from the saved draft.');
      if (!found) {
        const bytes = await options.files.read(family, item.photo);
        current();
        if (bytes.length !== item.photo.byteSize || sha256Hex(bytes) !== item.sha256)
          throw error(
            'PHOTO_CHANGED',
            'An attached photo changed after this cloud draft was prepared.',
          );
        await ports.putPhoto(keys.walletId, item.sha256, bytes, item.photo.mimeType);
        current();
      }
      const actual = await ports.getPhoto(keys.walletId, item.sha256, item.photo.byteSize);
      current();
      if (actual.length !== item.photo.byteSize || sha256Hex(actual) !== item.sha256)
        throw error('PHOTO_CHANGED', 'An uploaded photo did not pass its integrity check.');
    }
  }
  async function submit(pending) {
    current();
    const plan = await makePlan(pending);
    const record = await serverRecord();
    const receipt = await receiptFor(plan);
    if (receipt) {
      if (
        receipt.payloadHash !== plan.record.payloadHash ||
        receipt.revision !== plan.record.revision ||
        !record ||
        record.revision < receipt.revision
      )
        throw error('REMOTE_INCONSISTENT', 'The saved operation conflicts with its cloud receipt.');
      const actual = await retainRecord(record);
      await retainDraft(null);
      status = 'online';
      message = 'The cloud save was confirmed by its operation receipt.';
      notify();
      return actual.ledger;
    }
    if (
      (record?.revision ?? 0) !== plan.baseRevision ||
      (record?.payloadHash ?? null) !== plan.baseHash
    ) {
      if (record) await retainRecord(record);
      await retainDraft({ ...plan, phase: 'conflict' });
      status = 'conflict';
      message =
        'Another device changed the wallet. Your draft is retained and has not overwritten it.';
      notify();
      throw error('REVISION_CONFLICT', message);
    }
    await uploadPhotos(plan);
    const submitted = { ...plan, phase: 'submitted' };
    await retainDraft(submitted); // Confirm durable intent before the financial server transaction.
    current();
    let committed;
    try {
      committed = await options.ports().commitWallet(keys.walletId, {
        baseRevision: plan.baseRevision,
        baseHash: plan.baseHash,
        record: plan.record,
      });
      current();
    } catch {
      status = 'needs-recovery';
      message =
        'The server save outcome is not yet confirmed. The same operation is retained for recovery.';
      notify();
      throw error('SAVE_UNKNOWN', message);
    }
    const decoded = decodeRecord(committed, owner);
    if (
      decoded.record.operationId !== plan.operationId ||
      decoded.record.payloadHash !== plan.record.payloadHash ||
      decoded.record.revision !== plan.record.revision
    )
      throw error('SAVE_UNKNOWN', 'The server did not confirm this exact save.');
    await retainRecord(decoded.record);
    await retainDraft(null);
    status = 'online';
    message = 'Saved to your Firebase wallet.';
    notify();
    return decoded.ledger;
  }
  async function saveInner(next, expected) {
    await readLocal();
    current();
    const candidate = checkedLedger(next);
    if (expected !== undefined) {
      const old = checkedLedger(expected);
      if (
        cache
          ? JSON.stringify(decodeRecord(cache.record, owner).ledger) !== JSON.stringify(old)
          : !isEmptyTarget(old) || JSON.stringify(old) !== JSON.stringify(candidate)
      )
        throw error(
          'STALE_EDITOR',
          'The wallet changed since this editor opened. Reopen it before saving.',
        );
    } else if (cache) {
      throw error(
        'EXPECTED_REQUIRED',
        'Cloud edits require the exact previously confirmed wallet.',
      );
    } else if (candidate.transactions.length || candidate.budgets.length || candidate.goal) {
      throw error(
        'EXPLICIT_COPY_REQUIRED',
        'Existing records need an explicit copy preview before entering the cloud wallet.',
      );
    }
    if (draft) {
      if (draft.phase === 'submitted')
        throw error('SAVE_UNKNOWN', 'Reconcile the submitted cloud save before editing.');
      if (JSON.stringify(draft.ledger) !== JSON.stringify(candidate))
        throw error(
          'DRAFT_EXISTS',
          'Resolve the existing cloud draft before saving a different edit.',
        );
      if (draft.phase === 'conflict')
        throw error(
          'REVISION_CONFLICT',
          'The cloud version changed. Review the retained draft first.',
        );
    } else {
      const plan = {
        version: 1,
        familyToken: keys.familyToken,
        operationId: operationId(options.newId()),
        baseRevision: cache?.record.revision ?? 0,
        baseHash: cache?.record.payloadHash ?? null,
        createdAtMs: options.now(),
        phase: 'draft',
        ledger: candidate,
        record: null,
      };
      await retainDraft(plan);
    }
    return submit(draft);
  }
  const job = (work) =>
    exclusive(keys.cache, async () => {
      busy = true;
      notify();
      try {
        return await work();
      } finally {
        busy = false;
        notify();
      }
    });
  const api = {
    key: keys.cache,
    kind: 'firebase-live',
    isReadOnly: () => state.readOnly,
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load() {
      return hydrate(await job(() => readConfirmed(true)));
    },
    async readCurrent() {
      return hydrate(await job(() => readConfirmed(draft?.phase !== 'submitted')));
    },
    save(next) {
      return job(() => saveInner(next));
    },
    saveWithExpected(previous, next) {
      return job(() => saveInner(next, previous));
    },
    async refresh() {
      return hydrate(await job(() => readConfirmed(false)));
    },
    retryDraft(token) {
      return job(async () => {
        await readLocal();
        if (!draft || draft.operationId !== token)
          throw error('STALE_DRAFT', 'This recovery draft changed. Reopen Cloud Wallet.');
        return submit(draft);
      });
    },
    discardDraft(token) {
      return job(async () => {
        await readLocal();
        if (!draft || draft.operationId !== token || draft.phase === 'submitted')
          throw error('DRAFT_BLOCKED', 'Only a confirmed, unsubmitted draft can be discarded.');
        await retainDraft(null);
        status = cache ? 'offline' : 'idle';
        message = 'The unsubmitted draft was discarded. Confirmed records were kept.';
        notify();
      });
    },
    readDraft() {
      return job(async () => {
        await readLocal();
        return draft ? clone(draft) : null;
      });
    },
    withRetainedPhotoReferences(work) {
      return job(async () => {
        let snapshot;
        try {
          await readLocal();
          const found = new Map();
          const add = (value) => {
            for (const photo of ledgerPhotos(value)) {
              const key = photoKey(photo);
              if (found.has(key) && !samePhotoRef(found.get(key), photo)) throw Error();
              found.set(key, photo);
            }
          };
          if (cache) add(decodeRecord(cache.record, owner).ledger);
          if (draft) add(draft.ledger);
          const legacy = await options.legacyStorage.readCurrent();
          if (legacy) add(legacy);
          snapshot =
            !cache && !legacy && !draft
              ? { complete: false, reason: 'Cloud photo ownership is not yet confirmed.' }
              : { complete: true, references: [...found.values()] };
        } catch {
          snapshot = {
            complete: false,
            reason: 'Cloud or retained local photo references could not be confirmed.',
          };
        }
        return work(snapshot);
      });
    },
  };
  return api;
}
module.exports = { createEverydayCloudStore };
