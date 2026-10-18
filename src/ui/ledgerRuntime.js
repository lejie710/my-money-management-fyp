const { validateLedger } = require('../core/model');
const { loadOrCreateLedger } = require('../core/storage');
const { reconcileAchievements } = require('../core/achievements');
const { commitLedger } = require('../core/commitLedger');
const { encodeReminderOwner } = require('../reminders/store');
const { encodeDataFamily, validateDataFamily } = require('../accounts/identity');
const runtimes = new WeakMap();
function checkedStorage(storage) {
  if (
    !storage ||
    !['load', 'save', 'readCurrent', 'withRetainedPhotoReferences'].every(
      (name) => typeof storage[name] === 'function',
    )
  )
    throw new Error('A family-bound ledger storage adapter is required.');
  return storage;
}
function ownerToken(family, ledger) {
  return ledger
    ? encodeReminderOwner({ ...family, incarnationId: ledger.wallet.incarnationId })
    : null;
}

/** Shared synchronous financial state survives hook remounts of the same runtime. */
function createLedgerRuntime({
  runtime,
  family,
  storage,
  createInitialLedger,
  getClock,
  validateConfiguration = () => {},
  trace = () => {},
}) {
  if (
    !runtime ||
    typeof runtime !== 'object' ||
    typeof createInitialLedger !== 'function' ||
    typeof getClock !== 'function'
  )
    throw new Error('A stable financial runtime, seed and clock are required.');
  const initialFamily = validateDataFamily(family),
    initialToken = encodeDataFamily(initialFamily);
  checkedStorage(storage);
  const found = runtimes.get(runtime);
  if (found) {
    if (
      found.initialToken !== initialToken ||
      found.initialStorage !== storage ||
      found.getClock !== getClock ||
      found.createInitialLedger !== createInitialLedger
    )
      throw new Error('This financial runtime was already configured for another initial binding.');
    return found.controller;
  }
  let binding = { family: initialFamily, familyToken: initialToken, storage, seeded: false };
  let ledger = null,
    writeInFlight = false,
    uncertain = false,
    lease = null,
    adoptionUncertain = false,
    uncertainTarget = null;
  let initialRestore = null;
  const listeners = new Set(),
    observers = new Set();
  let transition = null;
  let view = Object.freeze({
    ledger: null,
    loading: true,
    loadError: false,
    saving: false,
    saveError: '',
    status: '',
    family: binding.family,
    storage: binding.storage,
    ownerToken: null,
    bindingToken: binding,
    identityPending: false,
    uncertain: false,
  });
  const publish = (changes) => {
    view = Object.freeze({
      ...view,
      ...changes,
      family: binding.family,
      storage: binding.storage,
      bindingToken: binding,
      ownerToken: ownerToken(binding.family, ledger),
      identityPending: lease !== null,
      uncertain: uncertain || adoptionUncertain,
    });
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  };
  const isBound = (token) => token === binding;
  const setDurable = (captured, durable, changes = {}) => {
    ledger = validateLedger(durable);
    // Every restore/adoption/incarnation replacement has a new callback generation.
    binding = { ...captured, seeded: true };
    publish({ ledger, ...changes });
  };
  function notifyObservers(previous, committed, clock, captured) {
    for (const entry of [...observers]) {
      if (entry.familyToken !== captured.familyToken) continue;
      const failure = () => {
        if (
          binding === captured &&
          ledger?.wallet.incarnationId === committed.wallet.incarnationId &&
          !lease
        )
          publish({
            saveError:
              'Your financial records were saved. A local follow-up is pending; check Reminders or attachment cleanup.',
          });
      };
      try {
        Promise.resolve(entry.observer(previous, committed, clock)).catch(failure);
      } catch {
        failure();
      }
    }
  }
  async function restore(expectedBinding, expectedOwner) {
    if (
      !isBound(expectedBinding) ||
      ownerToken(binding.family, ledger) !== expectedOwner ||
      writeInFlight ||
      lease
    )
      return false;
    const captured = binding;
    writeInFlight = true;
    publish({ loading: true, loadError: false, saveError: '' });
    trace('restore-start');
    try {
      validateConfiguration();
      const existing = uncertain || captured.seeded ? await captured.storage.readCurrent() : null;
      if ((uncertain || captured.seeded) && !existing)
        throw new Error('The saved wallet is still unavailable.');
      const loaded = existing
        ? { ledger: existing, created: false }
        : await loadOrCreateLedger(captured.storage, createInitialLedger);
      if (!isBound(captured)) return false;
      let durable = loaded.ledger,
        warning = '';
      const reconciliation = reconcileAchievements(durable, getClock());
      if (reconciliation.changed) {
        const committed = await commitLedger({
          current: durable,
          next: reconciliation.ledger,
          storage: captured.storage,
        });
        if (!isBound(captured)) return false;
        if (committed.blocked) {
          uncertain = true;
          throw new Error(committed.message);
        }
        durable = committed.ledger;
        if (!committed.ok)
          warning =
            'Saved records are available, but the milestone update is pending. Open Achievements and choose Recheck milestones.';
      }
      uncertain = false;
      setDurable(captured, durable, {
        loading: false,
        loadError: false,
        saveError: warning,
        status: loaded.created
          ? durable.mode === 'sample'
            ? 'Sample transactions loaded. Try adding or editing an entry.'
            : 'Your wallet is ready.'
          : 'Saved records are ready.',
      });
      trace('result-ready');
      return true;
    } catch {
      if (isBound(captured)) publish({ loadError: true, loading: false });
      trace('restore-failed');
      return false;
    } finally {
      writeInFlight = false;
      if (binding === captured && view.loading) publish({ loading: false });
      trace('restore-finished');
    }
  }
  async function save(expectedBinding, expectedOwner, next, message) {
    if (
      !isBound(expectedBinding) ||
      ownerToken(binding.family, ledger) !== expectedOwner ||
      writeInFlight ||
      lease ||
      uncertain ||
      adoptionUncertain ||
      view.loadError ||
      !ledger
    )
      return false;
    const captured = binding,
      previous = ledger;
    writeInFlight = true;
    publish({ saving: true, saveError: '' });
    try {
      validateConfiguration();
      const clock = getClock(),
        candidate = reconcileAchievements(next, clock).ledger;
      const guard = transition?.familyToken === captured.familyToken ? transition.guard : null;
      const committed = await commitLedger({
        current: previous,
        next: candidate,
        storage: captured.storage,
        transition: guard,
      });
      if (!isBound(captured)) return false;
      ledger = committed.ledger;
      uncertain = committed.blocked;
      if (ledger.wallet.incarnationId !== previous.wallet.incarnationId)
        binding = { ...captured, seeded: true };
      publish({
        ledger,
        loadError: committed.blocked,
        saving: false,
        saveError: committed.ok ? '' : committed.message,
        status: committed.ok ? committed.message || message : view.status,
      });
      if (!committed.ok) return false;
      notifyObservers(previous, committed.ledger, clock, binding);
      return true;
    } catch (cause) {
      if (isBound(captured))
        publish({
          saveError:
            cause instanceof Error ? cause.message : 'Check the data and try saving again.',
        });
      return false;
    } finally {
      writeInFlight = false;
      if (view.saving) publish({ saving: false });
    }
  }
  const controller = {
    getSnapshot: () => view,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new Error('A ledger listener is required.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    initialize() {
      if (!initialRestore && !ledger && !lease) initialRestore = restore(binding, null);
      return initialRestore ?? Promise.resolve(!!ledger);
    },
    restore,
    save,
    getClock,
    clearSaveError(expectedBinding) {
      if (isBound(expectedBinding)) publish({ saveError: '' });
    },
    registerTransitionGuard(expectedBinding, guard) {
      if (!isBound(expectedBinding)) return () => {};
      const entry = { guard, familyToken: binding.familyToken };
      transition = entry;
      return () => {
        if (transition === entry) transition = null;
      };
    },
    registerCommitObserver(expectedBinding, observer) {
      if (!isBound(expectedBinding)) return () => {};
      const entry = { observer, familyToken: binding.familyToken };
      observers.add(entry);
      return () => observers.delete(entry);
    },
    acquireIdentityLease() {
      try {
        validateConfiguration();
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : 'The local data configuration is invalid.';
        publish({ loading: false, loadError: true, saveError: message });
        return { ok: false, message };
      }
      if (writeInFlight || uncertain || adoptionUncertain || view.loadError)
        return {
          ok: false,
          message:
            'Finish the current financial operation and confirm saved records before changing accounts.',
        };
      if (lease) return { ok: false, message: 'An account identity lease is already held.' };
      lease = Object.freeze({});
      publish({});
      return { ok: true, lease };
    },
    isIdentityLeaseReady(expectedLease) {
      return (
        !!lease &&
        lease === expectedLease &&
        !writeInFlight &&
        !uncertain &&
        !adoptionUncertain &&
        !view.loadError
      );
    },
    async adoptIdentityTarget(expectedLease, target, isCurrent) {
      if (
        !lease ||
        lease !== expectedLease ||
        writeInFlight ||
        typeof isCurrent !== 'function' ||
        !isCurrent()
      )
        return {
          ok: false,
          pending: true,
          message: 'The account activation is no longer current.',
        };
      let targetFamily, durable, targetStorage, targetToken;
      try {
        validateConfiguration();
        targetFamily = validateDataFamily(target.family);
        targetStorage = checkedStorage(target.storage);
        durable = validateLedger(target.ledger);
        targetToken = ownerToken(targetFamily, durable);
        if (target.ownerToken !== targetToken)
          throw new Error('The target owner does not match its saved wallet.');
      } catch {
        return {
          ok: false,
          pending: false,
          message: 'The target account wallet could not be validated.',
        };
      }
      if (adoptionUncertain && uncertainTarget !== encodeDataFamily(targetFamily))
        return {
          ok: false,
          pending: true,
          walletWriteUnconfirmed: true,
          message: 'Confirm the previous target wallet write before activating another family.',
        };
      writeInFlight = true;
      try {
        let warning = '';
        const reconciliation = reconcileAchievements(durable, getClock());
        if (reconciliation.changed) {
          const committed = await commitLedger({
            current: durable,
            next: reconciliation.ledger,
            storage: targetStorage,
          });
          if (committed.blocked) {
            adoptionUncertain = true;
            uncertainTarget = encodeDataFamily(targetFamily);
            publish({});
            return {
              ok: false,
              pending: true,
              walletWriteUnconfirmed: true,
              message: committed.message,
            };
          }
          durable = committed.ledger;
          if (!committed.ok)
            warning =
              'Saved records are available, but the milestone update is pending. Open Achievements and choose Recheck milestones.';
        }
        if (lease !== expectedLease || !isCurrent())
          return {
            ok: false,
            pending: true,
            message: 'The account changed while its saved wallet was opening.',
          };
        // Reconfirm exact bytes even when there was no reconciliation write.
        const actual = await targetStorage.readCurrent();
        if (
          !actual ||
          JSON.stringify(validateLedger(actual)) !== JSON.stringify(validateLedger(durable))
        ) {
          adoptionUncertain = true;
          uncertainTarget = encodeDataFamily(targetFamily);
          publish({});
          return {
            ok: false,
            pending: true,
            walletWriteUnconfirmed: true,
            message: 'The target wallet could not be confirmed from its active store.',
          };
        }
        if (lease !== expectedLease || !isCurrent())
          return {
            ok: false,
            pending: true,
            message: 'The account changed while its saved wallet was opening.',
          };
        uncertain = false;
        adoptionUncertain = false;
        uncertainTarget = null;
        setDurable(
          {
            family: targetFamily,
            familyToken: encodeDataFamily(targetFamily),
            storage: targetStorage,
            seeded: true,
          },
          durable,
          {
            loading: false,
            loadError: false,
            saving: false,
            saveError: warning,
            status: 'Saved records are ready.',
          },
        );
        return { ok: true, pending: false, durableLedger: ledger, message: warning };
      } catch {
        adoptionUncertain = true;
        uncertainTarget = encodeDataFamily(targetFamily);
        publish({});
        return {
          ok: false,
          pending: true,
          walletWriteUnconfirmed: true,
          message:
            'The target saved wallet could not be confirmed. Reopen its active stored records.',
        };
      } finally {
        writeInFlight = false;
      }
    },
    releaseIdentityLease(expectedLease, expectedOwnerToken) {
      if (
        !lease ||
        lease !== expectedLease ||
        writeInFlight ||
        uncertain ||
        adoptionUncertain ||
        ownerToken(binding.family, ledger) !== expectedOwnerToken
      )
        return false;
      lease = null;
      publish({});
      return true;
    },
    getIdentityState() {
      return {
        family: binding.family,
        storage: binding.storage,
        ledger,
        ownerToken: ownerToken(binding.family, ledger),
        identityPending: lease !== null,
        writeInFlight,
        uncertain: uncertain || adoptionUncertain,
        bindingToken: binding,
      };
    },
  };
  runtimes.set(runtime, {
    initialToken,
    initialStorage: storage,
    getClock,
    createInitialLedger,
    controller,
  });
  return controller;
}
module.exports = { createLedgerRuntime };
