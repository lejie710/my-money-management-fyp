const { encodeDataFamily } = require('../accounts/identity');
const { validatePhotoRef } = require('../core/transactionContext');
const {
  makeSnapshot,
  validateSnapshot,
  restoreLedger,
  isEmptyTarget,
  summary,
  MAX_PHOTOS,
  MAX_TOTAL_PHOTO_BYTES,
} = require('./backupFormat');
const { sha256Hex } = require('./hash');
const { createPendingJournal } = require('./pendingJournal');
const clone = (v) => JSON.parse(JSON.stringify(v));
function createBackupCoordinator({
  getBinding,
  getSetup,
  readGuest,
  files,
  storage,
  transportFor,
  now = Date.now,
  newId,
}) {
  if ([getBinding, getSetup, readGuest, transportFor, newId].some((fn) => typeof fn !== 'function'))
    throw new Error('Backup needs explicit owner-bound services.');
  let view = {
      busy: false,
      message: '',
      error: '',
      preview: null,
      pending: null,
      journalBlocked: false,
      backups: [],
      cleanupPending: false,
      cleanupMessage: '',
      setup: getSetup(),
    },
    preview = null,
    pending = null,
    active = null,
    generation = 0,
    lastOwner = null,
    committing = null;
  const listeners = new Set();
  const cleanupByFamily = new Map();
  const cleanupState = () => {
    const current = getBinding();
    const pending = current ? cleanupByFamily.get(encodeDataFamily(current.family)) : null;
    return { cleanupPending: !!pending, cleanupMessage: pending || '' };
  };
  let safeViewCache = null;
  const publish = (changes) => {
    view = Object.freeze({ ...view, ...changes, ...cleanupState(), setup: getSetup() });
    for (const listener of listeners) listener();
  };
  const binding = () => {
    const value = getBinding();
    if (
      !value ||
      !value.allowed ||
      !value.ownerToken ||
      value.family.actor.kind !== 'firebase-hosted'
    )
      throw new Error('Sign in to the configured Firebase account before using Cloud Backup.');
    return value;
  };
  const owner = (b) => ({ projectId: b.family.actor.projectId, uid: b.family.actor.uid });
  const journalKey = (b) =>
    `@mymoney/cloud-pending/v1/${encodeURIComponent(encodeDataFamily(b.family))}`;
  const pendingSummary = (plan) =>
    plan
      ? {
          ...summary(plan.snapshot.ledger),
          createdAtMs: plan.snapshot.createdAtMs,
          backupId: plan.snapshot.backupId,
          photos: plan.snapshot.photos.length,
          includesPhotos: plan.snapshot.includesPhotos,
        }
      : null;
  const validatePlan = (plan, b) => {
    if (
      !plan ||
      Object.keys(plan).sort().join(',') !== 'photoSources,snapshot,sourceFamily' ||
      encodeDataFamily(plan.sourceFamily) !== encodeDataFamily(b.family) ||
      !Array.isArray(plan.photoSources) ||
      plan.photoSources.length > MAX_PHOTOS
    )
      throw new Error('Pending backup metadata is invalid. It has been retained.');
    plan.snapshot = validateSnapshot(plan.snapshot, owner(b));
    for (const row of plan.photoSources) {
      if (
        !row ||
        Object.keys(row).sort().join(',') !== 'photo,sha256' ||
        !plan.snapshot.photos.some((p) => p.sha256 === row.sha256)
      )
        throw new Error('Pending photo ownership is invalid.');
      validatePhotoRef(row.photo, plan.snapshot.ledger.wallet.incarnationId);
    }
    if (new Set(plan.photoSources.map((p) => p.sha256)).size !== plan.snapshot.photos.length)
      throw new Error('Pending photo references are incomplete.');
    return plan;
  };
  const check = (b, token, signal) => {
    if (
      token !== generation ||
      signal.aborted ||
      getBinding()?.ownerToken !== b.ownerToken ||
      !getBinding()?.allowed
    )
      throw new Error('The wallet or account changed. Reopen Cloud Backup.');
  };
  const journal = (b) =>
    createPendingJournal(storage, journalKey(b), (plan) => validatePlan(plan, b));
  const journalFailure = (error) => {
    if (error.code === 'PENDING' && error.plan) {
      pending = error.plan;
      publish({ pending: pendingSummary(pending), journalBlocked: false });
    } else if (error.code === 'UNAVAILABLE') publish({ journalBlocked: true });
    throw error;
  };
  async function readPending(b, token, signal) {
    try {
      const plan = await journal(b).read(() => check(b, token, signal));
      pending = plan;
      publish({ pending: pendingSummary(plan), journalBlocked: false });
      return plan;
    } catch (error) {
      check(b, token, signal);
      return journalFailure(error);
    }
  }
  async function run(work) {
    if (active) return false;
    const token = ++generation,
      abort = new AbortController();
    active = abort;
    publish({ busy: true, error: '', message: '' });
    try {
      await work(token, abort.signal);
      return true;
    } catch (error) {
      if (token === generation)
        publish({
          error: error instanceof Error ? error.message : 'Cloud work could not be confirmed.',
        });
      return false;
    } finally {
      if (active === abort) {
        active = null;
        publish({ busy: false });
      }
      if (committing === token) committing = null;
    }
  }
  async function capture(ledger, sourceFamily, b, includePhotos, token, signal) {
    const sources = [],
      items = [],
      byHash = new Map();
    let total = 0;
    const pictureRows = ledger.transactions.filter((row) => row.context?.photo);
    if (includePhotos && pictureRows.length > MAX_PHOTOS)
      throw new Error(
        'This wallet has more than 100 photo attachments. Choose a data-only backup explicitly.',
      );
    if (includePhotos)
      for (const row of pictureRows) {
        check(b, token, signal);
        const photo = row.context.photo,
          bytes = await files.read(sourceFamily, photo);
        check(b, token, signal);
        const hash = sha256Hex(bytes);
        let item = byHash.get(hash);
        if (!item) {
          total += bytes.length;
          if (total > MAX_TOTAL_PHOTO_BYTES)
            throw new Error('Selected photos exceed 50 MiB. Choose a data-only backup explicitly.');
          item = {
            sha256: hash,
            mimeType: photo.mimeType,
            width: photo.width,
            height: photo.height,
            byteSize: photo.byteSize,
            transactionIds: [],
          };
          byHash.set(hash, item);
          items.push(item);
          sources.push({ sha256: hash, photo: clone(photo) });
        }
        item.transactionIds.push(row.id);
      }
    return {
      snapshot: makeSnapshot({
        ledger,
        owner: owner(b),
        id: newId('backup'),
        createdAtMs: now(),
        photos: items,
        includePhotos,
      }),
      sourceFamily: clone(sourceFamily),
      photoSources: sources,
    };
  }
  async function upload(b, plan, token, signal) {
    const transport = transportFor(owner(b));
    await transport.backup(
      plan.snapshot,
      async (photo) => {
        check(b, token, signal);
        const source = plan.photoSources.find((row) => row.sha256 === photo.sha256);
        if (!source) throw new Error('The captured photo reference is missing.');
        return files.read(plan.sourceFamily, source.photo);
      },
      {
        signal,
        onProgress: (message) => {
          if (token === generation) publish({ message });
        },
      },
    );
    check(b, token, signal);
    await journal(b).clear(plan.snapshot.backupId, () => check(b, token, signal));
    check(b, token, signal);
    pending = null;
    preview = null;
    publish({
      pending: null,
      preview: null,
      message:
        'Cloud backup confirmed. Ordinary edits remain on this device until you back up again.',
    });
  }
  const controller = {
    getSnapshot() {
      let currentOwner = null;
      try {
        currentOwner = getBinding()?.ownerToken ?? null;
      } catch {}
      if (currentOwner === lastOwner) return view;
      if (safeViewCache?.source === view && safeViewCache.owner === currentOwner)
        return safeViewCache.snapshot;
      const snapshot = Object.freeze({
        ...view,
        busy: !!active,
        preview: null,
        pending: null,
        journalBlocked: false,
        backups: [],
        message: '',
        error: '',
        ...cleanupState(),
        setup: getSetup(),
      });
      safeViewCache = { source: view, owner: currentOwner, snapshot };
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ownerChanged() {
      const key = getBinding()?.ownerToken ?? null;
      if (lastOwner === key) {
        publish({});
        return;
      }
      lastOwner = key;
      generation++;
      if (committing === null) active?.abort();
      preview = null;
      pending = null;
      publish({
        busy: !!active,
        preview: null,
        pending: null,
        journalBlocked: false,
        backups: [],
        cleanupPending: false,
        cleanupMessage: '',
        message: '',
        error: '',
      });
    },
    open() {
      return run(async (token, signal) => {
        const b = binding();
        await readPending(b, token, signal);
      });
    },
    previewBackup(includePhotos) {
      return run(async (token, signal) => {
        const b = binding();
        if (await readPending(b, token, signal))
          throw new Error('Resume or discard the pending backup before starting another.');
        const bytes = JSON.stringify(b.ledger),
          plan = await capture(clone(b.ledger), b.family, b, includePhotos, token, signal);
        check(b, token, signal);
        preview = { kind: 'backup', ownerToken: b.ownerToken, targetBytes: bytes, plan };
        publish({
          preview: { kind: 'backup', ...pendingSummary(plan) },
          message: 'Review the captured records. Nothing has been uploaded.',
        });
      });
    },
    confirmBackup() {
      return run(async (token, signal) => {
        const b = binding(),
          selected = preview;
        if (
          !selected ||
          selected.kind !== 'backup' ||
          selected.ownerToken !== b.ownerToken ||
          selected.targetBytes !== JSON.stringify(b.ledger)
        )
          throw new Error('The wallet changed. Preview a fresh backup.');
        try {
          pending = await journal(b).begin(selected.plan, () => check(b, token, signal));
        } catch (error) {
          check(b, token, signal);
          journalFailure(error);
        }
        check(b, token, signal);
        publish({ pending: pendingSummary(pending), journalBlocked: false });
        await upload(b, pending, token, signal);
      });
    },
    resumeBackup() {
      return run(async (token, signal) => {
        const b = binding();
        const plan = await readPending(b, token, signal);
        if (!plan) throw new Error('No pending backup exists.');
        await upload(b, plan, token, signal);
      });
    },
    discardPending(expectedId) {
      return run(async (token, signal) => {
        const b = binding();
        const selectedId =
          expectedId === undefined ? (pending?.snapshot.backupId ?? null) : expectedId;
        try {
          await journal(b).clear(selectedId, () => check(b, token, signal));
        } catch (error) {
          check(b, token, signal);
          journalFailure(error);
        }
        check(b, token, signal);
        pending = null;
        preview = null;
        publish({
          pending: null,
          journalBlocked: false,
          preview: null,
          message:
            'Pending local backup state discarded. Any incomplete cloud objects remain private; no completed backup was deleted.',
        });
      });
    },
    listBackups() {
      return run(async (token, signal) => {
        const b = binding(),
          backups = await transportFor(owner(b)).list({ signal });
        check(b, token, signal);
        publish({
          backups,
          message: backups.length
            ? 'Showing the 50 newest completed backups.'
            : 'No completed cloud backups found.',
        });
      });
    },
    previewRestore(index) {
      return run(async (token, signal) => {
        const b = binding();
        if (!isEmptyTarget(b.ledger))
          throw new Error(
            'Restore requires an empty account wallet. Your current records were not changed.',
          );
        const targetBytes = JSON.stringify(b.ledger),
          snapshot = await transportFor(owner(b)).download(index, { signal });
        check(b, token, signal);
        preview = { kind: 'restore', ownerToken: b.ownerToken, targetBytes, snapshot };
        publish({
          preview: {
            kind: 'restore',
            ...summary(snapshot.ledger),
            photos: snapshot.photos.length,
            createdAtMs: snapshot.createdAtMs,
          },
          message: 'Review the backup. Your local wallet is unchanged.',
        });
      });
    },
    previewGuestCopy(includePhotos) {
      return run(async (token, signal) => {
        const b = binding();
        if (!isEmptyTarget(b.ledger))
          throw new Error(
            'Copying requires an empty account wallet. No records were merged or replaced.',
          );
        const source = await readGuest();
        check(b, token, signal);
        if (!source?.ledger) throw new Error('There is no saved guest wallet to copy.');
        const plan = await capture(source.ledger, source.family, b, includePhotos, token, signal);
        preview = {
          kind: 'guest-copy',
          ownerToken: b.ownerToken,
          targetBytes: JSON.stringify(b.ledger),
          guestBytes: JSON.stringify(source.ledger),
          plan,
          snapshot: plan.snapshot,
        };
        publish({
          preview: {
            kind: 'guest-copy',
            ...summary(source.ledger),
            photos: plan.snapshot.photos.length,
            includesPhotos: includePhotos,
          },
          message:
            'Copy to this empty account wallet. The guest wallet will stay unchanged; nothing will upload.',
        });
      });
    },
    confirmRestore() {
      return controller.confirmImport('restore');
    },
    confirmGuestCopy() {
      return controller.confirmImport('guest-copy');
    },
    confirmImport(kind) {
      return run(async (token, signal) => {
        const b = binding(),
          selected = preview;
        if (
          !selected ||
          selected.kind !== kind ||
          selected.ownerToken !== b.ownerToken ||
          selected.targetBytes !== JSON.stringify(b.ledger) ||
          !isEmptyTarget(b.ledger)
        )
          throw new Error('The target wallet changed. Preview again; nothing was replaced.');
        const snapshot = validateSnapshot(selected.snapshot, owner(b)),
          incarnationId = newId('wallet');
        let staged = null;
        try {
          staged = await files.stage(
            b.family,
            b.storage,
            incarnationId,
            snapshot.photos,
            async (photo) => {
              check(b, token, signal);
              if (kind === 'restore')
                return transportFor(owner(b)).photo(snapshot, photo, { signal });
              const source = selected.plan.photoSources.find((row) => row.sha256 === photo.sha256);
              return files.read(selected.plan.sourceFamily, source.photo);
            },
            () => check(b, token, signal),
          );
          check(b, token, signal);
          if (kind === 'guest-copy') {
            const source = await readGuest();
            check(b, token, signal);
            if (JSON.stringify(source?.ledger) !== selected.guestBytes)
              throw new Error('The guest wallet changed. Preview it again.');
          }
          const next = restoreLedger(snapshot, owner(b), incarnationId, staged.refs);
          check(b, token, signal);
          committing = token;
          const saved = await b.compareAndSave(
            b.ownerToken,
            selected.targetBytes,
            next,
            kind === 'restore'
              ? 'Cloud backup restored to this device.'
              : 'Guest wallet copied. The original guest wallet is unchanged.',
          );
          if (!saved)
            throw new Error(
              'The local save was not confirmed. Recheck saved records before trying again.',
            );
          preview = null;
          if (token === generation)
            publish({
              preview: null,
              message:
                kind === 'restore'
                  ? 'Cloud backup restored. No notifications or sessions were imported.'
                  : 'Guest wallet copied. Its original records remain separate. Use Backup to upload explicitly.',
            });
        } catch (error) {
          if (error?.cleanupPending) {
            cleanupByFamily.set(
              encodeDataFamily(b.family),
              error.cleanupMessage || 'Photo cleanup is still pending.',
            );
            publish({});
          }
          throw error;
        } finally {
          if (staged) {
            let cleanup;
            try {
              cleanup = await staged.close();
            } catch {
              cleanup = {
                pending: true,
                message:
                  'Owned photo cleanup is still unconfirmed. Saved financial records are retained.',
              };
            }
            if (cleanup?.pending) {
              cleanupByFamily.set(
                encodeDataFamily(b.family),
                cleanup.message || 'Some owned photo cleanup is pending.',
              );
              publish({});
            }
          }
        }
      });
    },
    retryCleanup() {
      return run(async (token, signal) => {
        const b = binding();
        if (typeof files.retryCleanup !== 'function')
          throw new Error('Reopen the wallet to retry its photo cleanup.');
        const result = await files.retryCleanup(b.family, b.storage);
        check(b, token, signal);
        if (result.pending) cleanupByFamily.set(encodeDataFamily(b.family), result.message);
        else cleanupByFamily.delete(encodeDataFamily(b.family));
        publish({ message: result.pending ? '' : 'Owned photo cleanup checked.' });
      });
    },
    clearPreview() {
      preview = null;
      publish({ preview: null, error: '', message: '' });
    },
    cancel() {
      if (committing !== null) return;
      generation++;
      active?.abort();
      preview = null;
      publish({
        busy: !!active,
        preview: null,
        message: 'Cancelled. Submitted cloud work may finish; pending backups are retained.',
        error: '',
      });
    },
  };
  return Object.freeze(controller);
}
module.exports = { createBackupCoordinator };
