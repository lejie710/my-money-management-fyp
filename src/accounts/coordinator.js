const { createEmptyLedger, createDemoLedger, validateLedger } = require('../core/model');
const { commitLedger } = require('../core/commitLedger');
const { encodeReminderOwner } = require('../reminders/store');
const {
  encodeDataScope,
  encodeDataFamily,
  familyForUser,
  projectAccountUser,
  normalizeCredentials,
  normalizeDisplayName,
  safeAuthMessage,
} = require('./identity');
const { familyStorageKeys } = require('./familyStorage');
const runtimes = new WeakMap();
const clone = (value) => JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const result = (ok, pending, message) => ({ ok, pending, message });
const unavailable = () =>
  result(
    false,
    true,
    'The account session could not be confirmed. Saved wallets are retained. Recheck the session before continuing.',
  );
function confirmed(value) {
  if (
    !value ||
    !['confirmed', 'unconfirmed'].includes(value.persistence) ||
    !['available', 'unavailable', 'unchecked'].includes(value.service) ||
    typeof value.mutationPending !== 'boolean' ||
    (value.recovery !== undefined && !['retry', 'restart'].includes(value.recovery))
  )
    throw new Error('Invalid identity confirmation.');
  return {
    user: projectAccountUser(value.user),
    persistence: value.persistence,
    service: value.service,
    mutationPending: value.mutationPending,
    recovery: value.recovery ?? 'retry',
  };
}
function sameUser(left, right) {
  return (left?.uid ?? null) === (right?.uid ?? null);
}

function createAccountCoordinator(options) {
  const scopeToken = encodeDataScope(options.scope);
  if (!options.runtime || typeof options.runtime !== 'object')
    throw new Error('A stable account runtime is required.');
  let cell = runtimes.get(options.runtime);
  if (cell) {
    if (
      cell.options.auth !== options.auth ||
      cell.options.financial !== options.financial ||
      cell.scopeToken !== scopeToken ||
      cell.options.storageForFamily !== options.storageForFamily ||
      cell.options.profileForFamily !== options.profileForFamily
    )
      throw new Error('An account runtime cannot change identity, scope or storage bindings.');
  } else {
    const auth = options.auth,
      financial = options.financial;
    if (
      !financial ||
      !['prepareIdentityChange', 'isIdentityLeaseReady', 'activate', 'resume', 'release'].every(
        (key) => typeof financial[key] === 'function',
      ) ||
      typeof options.storageForFamily !== 'function' ||
      typeof options.profileForFamily !== 'function' ||
      (auth !== null &&
        ![
          'initialize',
          'confirmIdentity',
          'subscribe',
          'signIn',
          'register',
          'signOut',
          'updateDisplayName',
        ].every((key) => typeof auth?.[key] === 'function'))
    )
      throw new Error('Account access needs explicit identity, financial and storage adapters.');
    cell = {
      options: { ...options, scope: freeze(clone(options.scope)) },
      scopeToken,
      listeners: new Set(),
      handles: 0,
      signal: 0,
      unsubscribe: null,
      busy: false,
      running: null,
      initialized: false,
      lease: null,
      active: null,
      activationAttempt: false,
      unknownWrites: new Set(),
      financialWork: 0,
      pendingName: null,
      pendingRegistration: null,
      lastConfirmation: null,
      view: null,
    };
    runtimes.set(options.runtime, cell);
    publish(cell, {
      phase: 'restoring',
      provider: auth ? 'local-emulator' : 'unconfigured',
      family: null,
      user: null,
      activeOwnerToken: null,
      operation: null,
      persistence: 'unconfirmed',
      sessionRestored: false,
      recovery: 'retry',
      service: 'unchecked',
      message: 'Opening the saved account session.',
      profileNamePending: false,
      profileExtras: null,
      profileExtrasStatus: 'none',
    });
  }
  if (cell.handles === 0 && !cell.busy && cell.initialized)
    publish(cell, {
      phase: 'restoring',
      activeOwnerToken: null,
      sessionRestored: false,
      message: 'Confirming the saved account session after reopening.',
    });
  let disposed = false;
  const subscriptions = new Set();
  cell.handles++;
  attach(cell);
  const invoke = (method, ...args) =>
    disposed
      ? Promise.resolve(result(false, true, 'This account view is closed.'))
      : method(cell, ...args);
  return {
    getSnapshot: () => cell.view,
    subscribe(listener) {
      if (disposed) return () => {};
      if (typeof listener !== 'function') throw new Error('A listener is required.');
      subscriptions.add(listener);
      cell.listeners.add(listener);
      return () => {
        subscriptions.delete(listener);
        cell.listeners.delete(listener);
      };
    },
    initialize: () => invoke(restore, true),
    retry: () => invoke(restore, false),
    signIn: (input) => invoke(mutate, 'sign-in', input),
    register: (input) => invoke(mutate, 'register', input),
    signOut: () => invoke(mutate, 'sign-out'),
    updateDisplayName: (name) => invoke(mutate, 'profile', name),
    saveProfileExtras: (extras) => invoke(saveExtras, extras),
    observeCommittedWallet(family, ledger) {
      if (
        disposed ||
        cell.lease ||
        !cell.active ||
        encodeDataFamily(family) !== encodeDataFamily(cell.active.family)
      )
        return false;
      const captured = clone(validateLedger(ledger)),
        owner = {
          ...clone(family),
          incarnationId: captured.wallet.incarnationId,
        };
      cell.active = {
        ...cell.active,
        ledger: captured,
        owner,
        ownerToken: encodeReminderOwner(owner),
      };
      if (cell.view.phase === 'ready') publish(cell, { activeOwnerToken: cell.active.ownerToken });
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const listener of subscriptions) cell.listeners.delete(listener);
      subscriptions.clear();
      cell.handles--;
      detachIfUnused(cell);
    },
  };
}
function publish(cell, changes = {}) {
  const next = { ...cell.view, ...changes },
    ready = next.phase === 'ready' && !cell.busy;
  const recoverySignOut =
    next.phase === 'wallet-unavailable' &&
    next.persistence === 'confirmed' &&
    cell.lease &&
    !cell.activationAttempt &&
    leaseReady(cell) &&
    !cell.busy;
  next.capabilities = {
    signIn: ready && !!cell.options.auth && !next.user,
    register: ready && !!cell.options.auth && !next.user,
    signOut: !!cell.options.auth && !!next.user && (ready || !!recoverySignOut),
    editProfile: ready && !!next.user,
    saveProfileExtras: ready && !!next.user && ['none', 'ready'].includes(next.profileExtrasStatus),
    retry: !cell.busy && next.recovery !== 'restart',
  };
  next.profileNamePending = !!cell.pendingName && next.user?.uid === cell.pendingName.uid;
  cell.view = freeze(clone(next));
  for (const listener of cell.listeners) {
    try {
      listener();
    } catch {
      /* UI observers cannot change the transition outcome. */
    }
  }
}
function attach(cell) {
  if (!cell.options.auth || cell.unsubscribe) return;
  cell.unsubscribe = cell.options.auth.subscribe(() => {
    cell.signal++;
    if (!cell.busy && cell.handles > 0) void restore(cell, false);
  });
}
function detachIfUnused(cell) {
  if (cell.handles === 0 && !cell.busy && cell.unsubscribe) {
    cell.unsubscribe();
    cell.unsubscribe = null;
  }
}
function run(cell, work) {
  if (cell.busy)
    return Promise.resolve(
      result(false, true, 'An account operation is still settling. Recheck when it finishes.'),
    );
  cell.busy = true;
  publish(cell);
  cell.running = Promise.resolve()
    .then(work)
    .catch(async () => {
      await acquire(cell, 'reconcile');
      publish(cell, {
        phase: 'session-unavailable',
        activeOwnerToken: null,
        operation: null,
        persistence: 'unconfirmed',
        message: unavailable().message,
      });
      return unavailable();
    })
    .finally(() => {
      cell.busy = false;
      cell.running = null;
      publish(cell);
      detachIfUnused(cell);
    });
  return cell.running;
}
async function acquire(cell, reason) {
  if (cell.lease) return true;
  let prepared;
  try {
    prepared = await cell.options.financial.prepareIdentityChange({
      reason,
      activeOwnerToken: cell.active?.ownerToken ?? null,
    });
  } catch {
    prepared = { ok: false };
  }
  if (!prepared?.ok || !prepared.lease || typeof prepared.lease !== 'object') return false;
  cell.lease = prepared.lease;
  cell.activationAttempt = false;
  return true;
}
function leaseReady(cell) {
  if (!cell.lease || cell.financialWork > 0 || cell.unknownWrites.size > 0) return false;
  try {
    return cell.options.financial.isIdentityLeaseReady(cell.lease) === true;
  } catch {
    return false;
  }
}
async function inspectIdentity(cell, initialize = false) {
  if (!cell.options.auth)
    return {
      user: null,
      persistence: 'confirmed',
      service: 'unchecked',
      mutationPending: false,
    };
  const value = confirmed(
    await (initialize
      ? cell.options.auth.initialize(async () => {
          if (cell.lease) {
            if (leaseReady(cell)) return;
            throw new Error('The financial lease is held but its writes are not settled.');
          }
          const oldView = cell.view;
          publish(cell, {
            phase: 'switching',
            activeOwnerToken: null,
            message: 'Confirming an account session change.',
          });
          if (!(await acquire(cell, 'reconcile')) || !leaseReady(cell)) {
            publish(cell, {
              ...oldView,
              message: 'An account change was blocked until the current financial work is settled.',
            });
            throw new Error('Financial access has not been released for an identity change.');
          }
        })
      : cell.options.auth.confirmIdentity()),
  );
  cell.initialized = true;
  return value;
}
async function readTarget(cell, family) {
  cell.financialWork++;
  try {
    return await readTargetUnlocked(cell, family);
  } finally {
    cell.financialWork--;
  }
}
async function readTargetUnlocked(cell, family) {
  const storage = cell.options.storageForFamily(family),
    token = encodeDataFamily(family);
  if (storage?.key !== familyStorageKeys(family).key)
    throw new Error('The wallet binding belongs to another family.');
  let ledger = cell.unknownWrites.has(token) ? await storage.readCurrent() : await storage.load();
  if (cell.unknownWrites.has(token) && ledger === null)
    throw new Error('The wallet creation outcome remains unconfirmed.');
  if (ledger === null) {
    const initial =
      family.actor.kind === 'local'
        ? (cell.options.createGuestLedger ?? createDemoLedger)()
        : createEmptyLedger({ name: 'My wallet', currency: 'MYR' }, cell.options.identityContext);
    const committed = await commitLedger({
      current: initial,
      next: initial,
      storage,
    });
    if (committed.blocked) {
      cell.unknownWrites.add(token);
      throw new Error('The wallet creation outcome remains unconfirmed.');
    }
    ledger = committed.ledger;
  }
  validateLedger(ledger);
  cell.unknownWrites.delete(token);
  const owner = { ...family, incarnationId: ledger.wallet.incarnationId };
  return {
    family: clone(family),
    owner,
    ownerToken: encodeReminderOwner(owner),
    ledger,
    storage,
  };
}
async function extrasFor(cell, family) {
  if (family.actor.kind === 'local') return { profileExtras: null, profileExtrasStatus: 'none' };
  try {
    const extras = await profileStore(cell, family).load();
    return {
      profileExtras: extras,
      profileExtrasStatus: extras ? 'ready' : 'none',
    };
  } catch {
    return { profileExtras: null, profileExtrasStatus: 'unavailable' };
  }
}
function profileStore(cell, family) {
  const storage = cell.options.profileForFamily(family);
  if (
    storage?.key !== `@mymoney/account-profile/v1/${encodeURIComponent(encodeDataFamily(family))}`
  )
    throw new Error('The profile binding belongs to another family.');
  return storage;
}
async function settle(cell, message = '') {
  for (let attempt = 0; attempt < 3; attempt++) {
    let identity;
    try {
      identity = await inspectIdentity(cell);
    } catch {
      identity = null;
    }
    if (!identity || identity.persistence !== 'confirmed' || identity.mutationPending) {
      cell.lastConfirmation = identity;
      const recovery = identity?.recovery ?? 'retry',
        message =
          recovery === 'restart'
            ? 'This running app could not safely restore the saved account session. Restart the app to try restoration again. Saved wallets have been retained.'
            : unavailable().message;
      publish(cell, {
        phase: 'session-unavailable',
        family: null,
        user: identity?.user ?? null,
        activeOwnerToken: null,
        operation: null,
        persistence: 'unconfirmed',
        recovery,
        service: identity?.service ?? 'unchecked',
        message,
        profileExtras: null,
        profileExtrasStatus: 'none',
      });
      return result(false, true, message);
    }
    cell.lastConfirmation = identity;
    if (cell.pendingRegistration) {
      if (identity.user?.email?.toLowerCase() === cell.pendingRegistration.email)
        cell.pendingName = {
          uid: identity.user.uid,
          name: cell.pendingRegistration.name,
        };
      cell.pendingRegistration = null;
    }
    const family = familyForUser(cell.options.scope, identity.user),
      signal = cell.signal;
    publish(cell, {
      phase: 'switching',
      family,
      user: identity.user,
      activeOwnerToken: null,
      persistence: 'confirmed',
      service: identity.service,
      profileExtras: null,
      profileExtrasStatus: 'none',
    });
    let target,
      canResume = false;
    try {
      if (
        cell.active &&
        encodeDataFamily(cell.active.family) === encodeDataFamily(family) &&
        !cell.activationAttempt
      ) {
        const saved = await cell.active.storage.readCurrent();
        if (saved === null) throw new Error('The previously active wallet is missing.');
        validateLedger(saved);
        const owner = { ...family, incarnationId: saved.wallet.incarnationId };
        target = {
          ...cell.active,
          ledger: saved,
          owner,
          ownerToken: encodeReminderOwner(owner),
        };
        canResume = target.ownerToken === cell.active.ownerToken;
      } else target = await readTarget(cell, family);
    } catch {
      publish(cell, {
        phase: 'wallet-unavailable',
        family,
        user: identity.user,
        activeOwnerToken: null,
        operation: null,
        persistence: 'confirmed',
        message:
          'This identity is confirmed, but its saved wallet is unavailable. Existing data has been retained. Recheck the wallet.',
      });
      return result(false, true, cell.view.message);
    }
    const beforeActivation = await inspectIdentity(cell);
    if (
      beforeActivation.persistence !== 'confirmed' ||
      beforeActivation.mutationPending ||
      !sameUser(beforeActivation.user, identity.user) ||
      cell.signal !== signal
    )
      continue;
    const isCurrent = () => cell.signal === signal && cell.lease !== null;
    cell.activationAttempt = true;
    const expectedOwnerToken = target.ownerToken;
    const expectedFamilyToken = encodeDataFamily(family);
    let activated;
    cell.financialWork++;
    try {
      activated = await cell.options.financial[canResume ? 'resume' : 'activate'](
        cell.lease,
        target,
        isCurrent,
      );
    } catch {
      activated = { ok: false, pending: true };
    } finally {
      cell.financialWork--;
    }
    if (activated?.walletWriteUnconfirmed) {
      cell.unknownWrites.add(expectedFamilyToken);
      activated = { ok: false, pending: true };
    }
    if (activated?.ok && !activated.pending) {
      try {
        if (
          encodeDataFamily(target.family) !== expectedFamilyToken ||
          target.ownerToken !== expectedOwnerToken ||
          encodeReminderOwner(target.owner) !== expectedOwnerToken ||
          target.storage.key !== familyStorageKeys(family).key ||
          encodeReminderOwner({
            ...family,
            incarnationId: validateLedger(target.ledger).wallet.incarnationId,
          }) !== expectedOwnerToken
        )
          throw new Error('The activated family changed unexpectedly.');
        if (activated.durableLedger !== undefined) {
          const durable = clone(validateLedger(activated.durableLedger));
          if (
            encodeReminderOwner({
              ...family,
              incarnationId: durable.wallet.incarnationId,
            }) !== expectedOwnerToken
          )
            throw new Error('Restore-time reconciliation changed wallet ownership.');
          const saved = await target.storage.readCurrent();
          if (saved === null || JSON.stringify(validateLedger(saved)) !== JSON.stringify(durable))
            throw new Error('The reconciled wallet was not confirmed in its family store.');
          target = { ...target, ledger: durable };
        }
      } catch {
        cell.unknownWrites.add(expectedFamilyToken);
        activated = { ok: false, pending: true };
      }
    }
    if (!activated?.ok || activated.pending) {
      publish(cell, {
        phase: 'wallet-unavailable',
        activeOwnerToken: null,
        operation: null,
        message:
          'Wallet activation or its saved reconciliation outcome could not be confirmed. Existing data is retained. Recheck before continuing.',
      });
      return result(false, true, cell.view.message);
    }
    const finalIdentity = await inspectIdentity(cell);
    if (
      finalIdentity.persistence !== 'confirmed' ||
      finalIdentity.mutationPending ||
      !sameUser(finalIdentity.user, identity.user) ||
      !isCurrent()
    )
      continue;
    const extras = await extrasFor(cell, family);
    const afterExtras = await inspectIdentity(cell);
    if (
      afterExtras.persistence !== 'confirmed' ||
      afterExtras.mutationPending ||
      !sameUser(afterExtras.user, identity.user) ||
      !isCurrent()
    )
      continue;
    if (
      cell.pendingName &&
      cell.pendingName.uid === afterExtras.user?.uid &&
      cell.pendingName.name === afterExtras.user?.displayName
    )
      cell.pendingName = null;
    cell.active = target;
    cell.lastConfirmation = afterExtras;
    cell.options.financial.release(cell.lease);
    cell.lease = null;
    cell.activationAttempt = false;
    publish(cell, {
      phase: 'ready',
      family,
      user: afterExtras.user,
      activeOwnerToken: target.ownerToken,
      operation: null,
      persistence: 'confirmed',
      sessionRestored: true,
      recovery: 'retry',
      service: afterExtras.service,
      message:
        message ||
        (afterExtras.user
          ? 'The account and its local wallet are ready.'
          : 'The guest wallet is ready.'),
      ...extras,
    });
    return result(true, false, cell.view.message);
  }
  publish(cell, {
    phase: 'session-unavailable',
    family: null,
    activeOwnerToken: null,
    operation: null,
    persistence: 'unconfirmed',
    message: unavailable().message,
  });
  return unavailable();
}
function restore(cell, initial) {
  return run(cell, async () => {
    publish(cell, {
      phase: initial ? 'restoring' : 'switching',
      activeOwnerToken: null,
      operation: null,
      message: 'Confirming the saved identity and wallet.',
    });
    if (!(await acquire(cell, initial ? 'restore' : 'reconcile'))) {
      publish(cell, {
        phase: 'session-unavailable',
        activeOwnerToken: null,
        message:
          'Finish or discard the open financial edit and resolve any pending save before changing account access.',
      });
      return result(false, true, cell.view.message);
    }
    if (!cell.initialized) {
      const initialIdentity = await inspectIdentity(cell, true);
      if (initialIdentity.persistence !== 'confirmed' || initialIdentity.mutationPending) {
        cell.lastConfirmation = initialIdentity;
        const recovery = initialIdentity.recovery ?? 'retry',
          message =
            recovery === 'restart'
              ? 'This running app could not safely restore the saved account session. Restart the app to try restoration again. Saved wallets have been retained.'
              : unavailable().message;
        publish(cell, {
          phase: 'session-unavailable',
          persistence: 'unconfirmed',
          activeOwnerToken: null,
          recovery,
          message,
        });
        return result(false, true, message);
      }
    }
    return settle(cell);
  });
}
function mutate(cell, operation, input) {
  const permission = {
    'sign-in': 'signIn',
    register: 'register',
    'sign-out': 'signOut',
    profile: 'editProfile',
  }[operation];
  if (!cell.view.capabilities[permission])
    return Promise.resolve(
      result(
        false,
        cell.busy || cell.view.phase !== 'ready',
        'This account action is not available until the current session and financial work are settled.',
      ),
    );
  let credentials, name;
  try {
    if (operation === 'sign-in' || operation === 'register')
      credentials = normalizeCredentials(input);
    if (operation === 'register') name = normalizeDisplayName(input.displayName);
    if (operation === 'profile') name = normalizeDisplayName(input);
  } catch (error) {
    return Promise.resolve(result(false, false, error.message));
  }
  const oldView = cell.view;
  return run(cell, async () => {
    publish(cell, {
      phase: 'switching',
      activeOwnerToken: null,
      operation,
      message: 'Finishing the current wallet before updating account access.',
    });
    if (!(await acquire(cell, 'mutation'))) {
      publish(cell, {
        ...oldView,
        activeOwnerToken: cell.active?.ownerToken ?? oldView.activeOwnerToken,
        operation: null,
        message:
          'Finish or discard the open financial edit and resolve any pending save before changing account access.',
      });
      return result(false, false, cell.view.message);
    }
    if (!leaseReady(cell)) {
      publish(cell, {
        phase: 'wallet-unavailable',
        activeOwnerToken: null,
        operation: null,
        message:
          'Financial work is still pending or unconfirmed. The account request was not started. Recheck the saved wallet first.',
      });
      return result(false, true, cell.view.message);
    }
    // An externally changed identity cannot borrow the previous UI's permission.
    const before = await inspectIdentity(cell);
    if (
      before.persistence !== 'confirmed' ||
      before.mutationPending ||
      !sameUser(before.user, oldView.user)
    ) {
      const reconciled = await settle(cell);
      return result(
        false,
        reconciled.pending,
        'The account session changed before this request began. The actual saved session has been rechecked; the requested action was not repeated.',
      );
    }
    let failure = null;
    try {
      if (operation === 'sign-in') await cell.options.auth.signIn(credentials);
      if (operation === 'register') {
        cell.pendingRegistration = {
          email: credentials.email.toLowerCase(),
          name,
        };
        await cell.options.auth.register(credentials);
      }
      if (operation === 'sign-out') await cell.options.auth.signOut();
      if (operation === 'profile') {
        cell.pendingName = { uid: before.user.uid, name };
        await cell.options.auth.updateDisplayName(before.user.uid, name);
      }
    } catch (error) {
      failure = safeAuthMessage(error, operation);
    }
    // Credentials are never stored on the runtime, view, journal, or result.
    const intendedEmail = credentials?.email.toLowerCase();
    credentials = null;
    let after;
    try {
      after = await inspectIdentity(cell);
    } catch {
      return settle(cell);
    }
    if (
      operation === 'register' &&
      after.persistence === 'confirmed' &&
      !after.mutationPending &&
      after.user?.email?.toLowerCase() === intendedEmail
    ) {
      cell.pendingName = { uid: after.user.uid, name };
      try {
        await cell.options.auth.updateDisplayName(after.user.uid, name);
      } catch {
        failure =
          'Your account was created. Its display name update is pending; open Profile to retry it.';
      }
    }
    const settled = await settle(cell);
    if (!settled.ok) return settled;
    const user = cell.view.user;
    const achieved =
      operation === 'sign-out'
        ? user === null
        : operation === 'profile'
          ? user?.uid === before.user.uid && user?.displayName === name
          : user?.email?.toLowerCase() === intendedEmail;
    const partial = operation === 'register' && achieved && cell.view.profileNamePending;
    const message = partial
      ? 'Your account was created and its local wallet is ready. The display name update is pending; open Profile to retry it.'
      : achieved
        ? operation === 'profile'
          ? 'Display name saved.'
          : 'Account access is confirmed. The selected local wallet is ready.'
        : failure ||
          'The requested identity change was not confirmed. The actual saved session is now shown.';
    publish(cell, { message });
    return result(!!achieved && !partial, partial, message);
  });
}
function saveExtras(cell, extras) {
  if (!cell.view.capabilities.saveProfileExtras)
    return Promise.resolve(
      result(false, true, 'Reopen the current account profile before changing local details.'),
    );
  const family = cell.view.family,
    user = cell.view.user;
  return run(cell, async () => {
    publish(cell, {
      operation: 'profile-extras',
      message: 'Saving optional local profile details.',
    });
    // The profile store owns exact fields/date validation and write readback.
    let saved;
    try {
      saved = await profileStore(cell, family).save(extras);
    } catch {
      publish(cell, {
        operation: null,
        message:
          'Check the optional profile details. The birthday must be a valid date no later than today.',
      });
      return result(false, false, cell.view.message);
    }
    const identity = await inspectIdentity(cell);
    if (
      identity.persistence !== 'confirmed' ||
      identity.mutationPending ||
      !sameUser(identity.user, user)
    ) {
      publish(cell, {
        phase: 'session-unavailable',
        activeOwnerToken: null,
        operation: null,
        persistence: 'unconfirmed',
        message: unavailable().message,
      });
      if (await acquire(cell, 'reconcile')) return settle(cell);
      return unavailable();
    }
    publish(cell, {
      operation: null,
      profileExtras: saved.extras,
      profileExtrasStatus: saved.pending ? 'uncertain' : saved.extras ? 'ready' : 'none',
      message: saved.message,
    });
    return result(saved.ok, saved.pending, saved.message);
  });
}
module.exports = { createAccountCoordinator };
