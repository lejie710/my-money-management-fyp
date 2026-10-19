const { encodeDataFamily } = require('../accounts/identity');
const { checkedLedger, ledgerPhotos } = require('./everydayFormat');
const { sha256Hex } = require('./hash');
const { isEmptyTarget, summary } = require('./backupFormat');
const { photoKey } = require('../core/transactionContext');
function createEverydayCloudController(options) {
  let busy = false,
    preview = null,
    feedback = '',
    error = '',
    feedbackOwner = null;
  let storeSubscription = null,
    subscribedFamily = null,
    disposed = false,
    state = null;
  let epoch = 0,
    observed = null;
  const listeners = new Set();
  const cleanupByFamily = new Map();
  const context = () => {
    const setup = options.getSetup();
    const token = setup.signedIn && setup.family ? encodeDataFamily(setup.family) : null;
    const binding = options.getBinding();
    const identity = {
      token,
      session: setup.sessionToken,
      binding: binding?.bindingToken ?? null,
      pending: binding?.identityPending ?? false,
    };
    if (!observed || Object.keys(identity).some((key) => identity[key] !== observed[key])) {
      epoch++;
      observed = identity;
      preview = null;
      feedback = '';
      error = '';
      feedbackOwner = null;
    }
    return { setup, token, binding, epoch, store: token ? options.storeFor(setup.family) : null };
  };
  const getSnapshot = () => {
    const { setup, token, store, binding } = context();
    const current = store?.getSnapshot();
    const allowed = !!binding?.allowed && !!token && encodeDataFamily(binding.family) === token;
    const shown = preview?.familyToken === token ? preview.view : null;
    const activeBusy = busy || !!current?.busy;
    const next = {
      configured: setup.configured,
      signedIn: !!token,
      ownerToken: setup.ownerToken,
      readOnly: current?.readOnly ?? true,
      busy: activeBusy,
      status: current?.status ?? 'unconfigured',
      revision: current?.revision ?? null,
      message: feedbackOwner === token && feedback ? feedback : (current?.message ?? ''),
      error: feedbackOwner === token ? error : '',
      photosPending: current?.photosPending ?? 0,
      draft: current?.draft ?? null,
      preview: shown,
      cleanupPending: !!token && cleanupByFamily.has(token),
      cleanupMessage: token ? (cleanupByFamily.get(token) ?? '') : '',
      canRefresh: !!token && !activeBusy,
      canCopy: allowed && !activeBusy && !current?.readOnly && isEmptyTarget(binding.ledger),
      canRetryDraft:
        !!token && !activeBusy && !!current?.draft && current.draft.phase !== 'conflict',
      canDiscardDraft:
        !!token && !activeBusy && !!current?.draft && current.draft.phase !== 'submitted',
    };
    if (!state || JSON.stringify(state) !== JSON.stringify(next)) state = Object.freeze(next);
    return state;
  };
  const emit = () => {
    if (disposed) return;
    getSnapshot();
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  };
  const bound = (start) => {
    const live = context();
    if (disposed || live.token !== start.token || live.epoch !== start.epoch)
      throw new Error('The cloud account changed.');
  };
  async function run(work) {
    const start = context();
    if (disposed || busy || !start.token || !start.store) return false;
    busy = true;
    error = '';
    feedback = '';
    feedbackOwner = start.token;
    emit();
    try {
      const result = await work(start, () => bound(start));
      if (result !== 'committed') bound(start);
      return true;
    } catch {
      if (context().token === start.token && epoch === start.epoch) {
        error =
          'The cloud wallet action was not confirmed. Existing records and any recovery draft were retained.';
        feedbackOwner = start.token;
      }
      return false;
    } finally {
      busy = false;
      emit();
    }
  }
  const api = {
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ownerChanged() {
      const current = context();
      if (current.token !== subscribedFamily) {
        storeSubscription?.();
        storeSubscription = current.store?.subscribe(emit) ?? null;
        subscribedFamily = current.token;
        preview = null;
        feedback = '';
        error = '';
        feedbackOwner = current.token;
      }
      emit();
    },
    dispose() {
      disposed = true;
      storeSubscription?.();
      listeners.clear();
      preview = null;
    },
    refresh() {
      return run(async ({ store }, current) => {
        await store.refresh();
        current();
        const result = await options.refreshAccount();
        if (result?.ok === false) throw Error();
        context();
        return 'committed';
      });
    },
    previewCopy(source) {
      if (!['local-account', 'guest'].includes(source)) return Promise.resolve(false);
      return run(async ({ setup, token, store }, current) => {
        const binding = options.getBinding();
        if (
          !binding?.allowed ||
          encodeDataFamily(binding.family) !== token ||
          !isEmptyTarget(binding.ledger) ||
          store.getSnapshot().readOnly
        )
          throw Error();
        const saved = await options.readLocal(source, setup.family);
        current();
        if (!saved.ledger) throw Error();
        const ledger = checkedLedger(saved.ledger);
        if (isEmptyTarget(ledger)) throw Error();
        const view = { token: options.newId(), source, ...summary(ledger) };
        preview = {
          view,
          familyToken: token,
          epoch,
          sourceFamily: saved.family,
          sourceJson: JSON.stringify(ledger),
          ownerToken: binding.ownerToken,
          targetJson: JSON.stringify(binding.ledger),
        };
        feedback =
          'Review this copy before any records or photos are uploaded. The device source will be kept.';
      });
    },
    confirmCopy(token) {
      return run(async ({ setup, token: familyToken, store }, current) => {
        const captured = preview;
        const binding = options.getBinding();
        if (
          !captured ||
          captured.view.token !== token ||
          captured.familyToken !== familyToken ||
          captured.epoch !== epoch ||
          !binding?.allowed ||
          binding.ownerToken !== captured.ownerToken ||
          JSON.stringify(binding.ledger) !== captured.targetJson ||
          !isEmptyTarget(binding.ledger)
        )
          throw Error();
        const saved = await options.readLocal(captured.view.source, setup.family);
        current();
        if (!saved.ledger || JSON.stringify(checkedLedger(saved.ledger)) !== captured.sourceJson)
          throw Error();
        const remote = await store.refresh();
        current();
        if (!remote || JSON.stringify(remote) !== captured.targetJson || !isEmptyTarget(remote))
          throw Error();
        let candidate = checkedLedger(saved.ledger),
          staged = null;
        try {
          if (encodeDataFamily(saved.family) !== familyToken && ledgerPhotos(candidate).length) {
            const prepared = [];
            const bytes = new Map(),
              hashes = new Map();
            for (const photo of ledgerPhotos(candidate)) {
              const raw = await options.files.read(saved.family, photo);
              current();
              const hash = sha256Hex(raw);
              if (!bytes.has(hash))
                prepared.push({ sha256: hash, mimeType: photo.mimeType, byteSize: photo.byteSize });
              bytes.set(hash, raw);
              hashes.set(photoKey(photo), hash);
            }
            staged = await options.files.stage(
              setup.family,
              store,
              candidate.wallet.incarnationId,
              prepared,
              (item) => Promise.resolve(bytes.get(item.sha256)),
              current,
            );
            current();
            candidate.transactions = candidate.transactions.map((row) =>
              row.context?.photo
                ? {
                    ...row,
                    context: {
                      ...row.context,
                      photo: staged.refs[hashes.get(photoKey(row.context.photo))],
                    },
                  }
                : row,
            );
            checkedLedger(candidate);
          }
          current();
          preview = null;
          const okay = await binding.compareAndSave(
            captured.ownerToken,
            captured.targetJson,
            candidate,
            'Copied the reviewed wallet to Firebase. The original device wallet was kept.',
          );
          if (!okay) throw Error();
          // compareAndSave owns the financial lease. Its confirmed save may itself replace
          // the wallet incarnation; never revive the old preview or publish stale feedback.
          const live = context();
          if (live.token === familyToken && live.epoch === captured.epoch)
            feedback = 'The reviewed copy was confirmed by Firebase. The device source was kept.';
          return 'committed';
        } catch (cause) {
          if (cause?.cleanupPending)
            cleanupByFamily.set(familyToken, 'Owned photo cleanup needs another check.');
          throw cause;
        } finally {
          if (staged) {
            let result;
            try {
              result = await staged.close();
            } catch {
              result = { pending: true };
            }
            if (result?.pending) {
              cleanupByFamily.set(familyToken, 'Owned photo cleanup needs another check.');
              if (context().token === familyToken && epoch === captured.epoch)
                feedback =
                  'The wallet outcome is retained. Temporary photo cleanup needs another check.';
            }
          }
        }
      });
    },
    retryCleanup() {
      return run(async ({ setup, token, store }, current) => {
        if (typeof options.files.retryCleanup !== 'function') throw Error();
        const result = await options.files.retryCleanup(setup.family, store);
        current();
        if (result.pending) cleanupByFamily.set(token, 'Owned photo cleanup needs another check.');
        else cleanupByFamily.delete(token);
      });
    },
    cancelPreview() {
      if (!busy) {
        preview = null;
        feedback = '';
        emit();
      }
    },
    retryDraft(token) {
      return run(async ({ setup, store }, current) => {
        if (store.getSnapshot().draft?.token !== token) throw Error();
        preview = null;
        if (!(await options.retryOperation(setup.family, token))) throw Error();
        context();
        return 'committed';
      });
    },
    discardDraft(token) {
      return run(async ({ store }, current) => {
        if (
          store.getSnapshot().draft?.token !== token ||
          store.getSnapshot().draft.phase === 'submitted'
        )
          throw Error();
        await store.discardDraft(token);
        current();
        await options.refreshAccount();
        context();
        return 'committed';
      });
    },
  };
  return api;
}
module.exports = { createEverydayCloudController };
