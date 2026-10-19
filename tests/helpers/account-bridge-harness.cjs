const path = require('node:path');
const { loadSource, ledger, clock, model, owner, identity } = require('./account-hook-harness.cjs');
const storageCore = require('../../src/core/storage'),
  achievements = require('../../src/core/achievements'),
  commit = require('../../src/core/commitLedger');
const accountCore = require('../../src/accounts/coordinator'),
  familyStore = require('../../src/accounts/familyStorage'),
  profiles = require('../../src/accounts/profileStore');
function fixture(options = {}) {
  const bytes = options.bytes ?? new Map(),
    log = [],
    faults = { get: null, set: null },
    scope = { kind: 'test', namespace: 'account-root-bridge' };
  const storage = {
    async getItem(key) {
      if (faults.get) await faults.get(key);
      return bytes.get(key) ?? null;
    },
    async setItem(key, value) {
      if (faults.set) await faults.set(key, value);
      bytes.set(key, value);
    },
    async removeItem(key) {
      bytes.delete(key);
    },
  };
  const bridgeModule = loadSource(
    path.join(__dirname, '../../src/accounts/financialBridge.ts'),
    {},
    { setTimeout, clearTimeout },
  );
  const presentation = loadSource(
    path.join(__dirname, '../../src/accounts/accountPresentation.ts'),
    {
      './identity': identity,
      '../core/model': model,
    },
  );
  const runtimeModule = loadSource(
    path.join(__dirname, '../../src/accounts/appRuntime.ts'),
    {
      '@react-native-async-storage/async-storage': storage,
      './coordinator': accountCore,
      './familyStorage': familyStore,
      './profileStore': profiles,
      './identity': identity,
      './financialBridge': bridgeModule,
      './accountPresentation': presentation,
      '../cloud/everydayStore': require('../../src/cloud/everydayStore'),
      '../cloud/everydayFormat': require('../../src/cloud/everydayFormat'),
      '../cloud/firebasePorts': { createFirebasePorts: options.createCloudPorts },
      '../cloud/everydayFiles': {
        createEverydayPhotoServices: () => ({
          async read() {
            throw Error('No synthetic photos configured');
          },
          async hydrate() {},
        }),
      },
      '../ui/useLedger': {
        localLedgerScope: scope,
        createLocalInitialLedger: () => ledger('Guest'),
        getLocalLedgerClock: clock,
      },
    },
    {
      process: {
        env: { EXPO_PUBLIC_LOCAL_AUTH_EMULATOR: options.enabledMissingSdk ? '1' : undefined },
      },
    },
  );
  let user = options.initialUser ?? null,
    guard = null,
    authPending = false,
    service = 'available',
    authReads = 0,
    mutations = 0,
    editor = false,
    suspended = false,
    cleanupFailure = false,
    photoFailure = false,
    reminderFailure = false,
    closeFailure = false,
    detached = false;
  const listeners = new Set(),
    paused = new Map();
  const confirmation = () => ({
    user,
    persistence: 'confirmed',
    service,
    mutationPending: authPending,
  });
  const auth = {
    async initialize(before) {
      guard = before;
      log.push('sdk-initialize');
      if (!controller.getIdentityState().identityPending)
        throw Error('SDK initialized before financial lease');
      return confirmation();
    },
    async confirmIdentity() {
      authReads++;
      return confirmation();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async signIn(input) {
      mutations++;
      log.push('sdk-sign-in');
      await guard();
      if (options.authWork) await options.authWork;
      if (input.password === 'wrong')
        throw Object.assign(Error('Synthetic rejection'), { code: 'auth/invalid-credential' });
      user = { uid: input.email.split('@')[0], email: input.email, displayName: null };
    },
    async register(input) {
      mutations++;
      log.push('sdk-register');
      await guard();
      user = { uid: input.email.split('@')[0], email: input.email, displayName: null };
    },
    async signOut() {
      mutations++;
      log.push('sdk-sign-out');
      await guard();
      user = null;
    },
    async updateDisplayName(uid, name) {
      await guard();
      if (user?.uid !== uid) throw Error('Wrong UID');
      user = { ...user, displayName: name };
    },
  };
  const sdkApp = {},
    sdkUsers = new WeakMap(),
    sdkAuth = {
      get currentUser() {
        if (!user) return null;
        let value = sdkUsers.get(user);
        if (!value) {
          value = {
            uid: user.uid,
            async getIdToken() {
              return 'synthetic-token';
            },
          };
          sdkUsers.set(user, value);
        }
        return value;
      },
    };
  if (options.cloudConfiguration)
    auth.getSdkContext = () => ({
      app: sdkApp,
      auth: sdkAuth,
      configuration: options.cloudConfiguration,
      uid: user?.uid,
    });
  const runtime = runtimeModule.createAccountAppRuntime({
    scope,
    storage,
    auth: options.unconfigured ? null : auth,
    cloudConfiguration: options.cloudConfiguration,
    getClock: clock,
    createGuestLedger: () => ledger('Guest'),
    timeoutMs: options.timeoutMs ?? 100,
  });
  const runtimeCore = loadSource(path.join(__dirname, '../../src/ui/ledgerRuntime.js'), {
    '../core/model': model,
    '../core/storage': storageCore,
    '../core/achievements': achievements,
    '../core/commitLedger': commit,
    '../reminders/store': owner,
    '../accounts/identity': identity,
  });
  const settings = runtime.ledgerOptions;
  const controller = runtimeCore.createLedgerRuntime({
    runtime: settings.runtime,
    family: settings.initialFamily,
    storage: settings.initialStorage,
    createInitialLedger: settings.createInitialLedger,
    getClock: settings.getClock,
  });
  let bound = null,
    unbind = null;
  function refresh() {
    if (detached) return;
    const view = controller.getSnapshot(),
      token = view.ownerToken;
    const photoUnavailable =
      photoFailure === true ||
      (typeof photoFailure === 'string' &&
        view.family.actor.kind === 'firebase' &&
        view.family.actor.uid === photoFailure);
    const reminderUnavailable =
      reminderFailure === true ||
      (typeof reminderFailure === 'string' &&
        view.family.actor.kind === 'firebase' &&
        view.family.actor.uid === reminderFailure);
    const finance = {
      ...view,
      getClock: controller.getClock,
      getIdentityState: controller.getIdentityState,
      acquireIdentityLease: controller.acquireIdentityLease,
      isIdentityLeaseReady: controller.isIdentityLeaseReady,
      adoptIdentityTarget: controller.adoptIdentityTarget,
      releaseIdentityLease: controller.releaseIdentityLease,
      restore: () => controller.restore(view.bindingToken, token),
      save: (next, message) => controller.save(view.bindingToken, token, next, message),
      clearSaveError: () => controller.clearSaveError(view.bindingToken),
    };
    const photos = {
      ownerToken: token,
      familyToken: identity.encodeDataFamily(view.family),
      photos: suspended ? undefined : {},
      suspended,
      suspendForIdentity(expected) {
        log.push('photo-suspend');
        if (expected !== controller.getIdentityState().ownerToken)
          return Promise.resolve({ pending: true });
        suspended = true;
        refresh();
        return Promise.resolve({ pending: photoUnavailable });
      },
      resumeAfterIdentity(family) {
        if (
          identity.encodeDataFamily(family) !==
          identity.encodeDataFamily(controller.getIdentityState().family)
        )
          return false;
        suspended = false;
        log.push('photo-resume');
        refresh();
        return true;
      },
      async readyForIdentity(expected, isCurrent) {
        return {
          pending:
            photoUnavailable ||
            expected !== controller.getIdentityState().ownerToken ||
            !isCurrent(),
        };
      },
    };
    const reminders = {
      coordinator: token
        ? {
            ownerToken: token,
            async initialize() {
              log.push('reminder-store-recheck');
              refresh();
              return { ok: !reminderFailure, pending: !!reminderFailure };
            },
          }
        : null,
      state: token
        ? {
            loading: false,
            loadError: reminderUnavailable ? 'Synthetic reminder store unavailable' : '',
            ownerPaused: paused.get(token) === true,
          }
        : null,
      identityOpening: reminderUnavailable,
      startupError: '',
      retryStartup() {},
      getBaselineKeys: () => [],
      async quiesceForIdentity(expected) {
        log.push('reminder-quiesce');
        if (expected !== controller.getIdentityState().ownerToken)
          return { ok: false, pending: true, message: '' };
        paused.set(expected, true);
        refresh();
        return { ok: !cleanupFailure, pending: cleanupFailure, message: '' };
      },
      async resumeForIdentity(expected) {
        log.push('reminder-resume');
        paused.set(expected, false);
        refresh();
        return { ok: true, pending: false, message: '' };
      },
      async readyForIdentity(expected, isCurrent) {
        return {
          ok:
            expected === controller.getIdentityState().ownerToken &&
            isCurrent() &&
            !paused.get(expected),
          pending: false,
          message: '',
        };
      },
    };
    bound = {
      ledger: finance,
      photos,
      reminders,
      hasOpenEditor: () => editor,
      closeEditor() {
        editor = false;
        log.push('editor-close');
      },
      closeExports() {
        log.push('exports-close');
        if (closeFailure) throw Error('Synthetic close failure');
      },
    };
    unbind = runtime.bridge.bind(bound);
  }
  controller.subscribe(refresh);
  refresh();
  return {
    runtime,
    appModule: runtimeModule,
    controller,
    auth,
    scope,
    bytes,
    storage,
    faults,
    log,
    refresh,
    get binding() {
      return bound;
    },
    get mutations() {
      return mutations;
    },
    get user() {
      return user;
    },
    setCleanupFailure(value) {
      cleanupFailure = value;
    },
    setPhotoFailure(value) {
      photoFailure = value;
    },
    setReminderFailure(value) {
      reminderFailure = value;
    },
    setCloseFailure(value) {
      closeFailure = value;
    },
    setEditor(value) {
      editor = value;
    },
    detach() {
      detached = true;
      unbind();
    },
    attach() {
      detached = false;
      refresh();
    },
    visible() {
      const account = runtime.presentation.getSnapshot(),
        finance = controller.getSnapshot();
      return (
        account.phase === 'ready' &&
        account.persistence === 'confirmed' &&
        account.activeOwnerToken === finance.ownerToken &&
        !finance.identityPending &&
        !finance.loading &&
        !finance.loadError
      );
    },
    ownerFor(uid) {
      return {
        scope,
        actor: uid
          ? options.cloudConfiguration
            ? {
                kind: 'firebase-hosted',
                projectId: options.cloudConfiguration.firebase.projectId,
                uid,
              }
            : { kind: 'firebase', uid }
          : { kind: 'local' },
      };
    },
    keyFor(uid) {
      return familyStore.familyStorageKeys(this.ownerFor(uid)).key;
    },
    async signIn(uid = 'A', password = 'synthetic-password') {
      return runtime.coordinator.signIn({ email: `${uid}@example.test`, password });
    },
    async saveExpense() {
      const view = controller.getSnapshot(),
        next = model.saveTransaction(
          view.ledger,
          model.transactionFromDraft(
            {
              type: 'expense',
              title: 'Synthetic expense',
              categoryId: 'expense-other',
              date: '2026-10-18',
              amount: '1.00',
            },
            'expense-one',
            view.ledger,
          ),
        );
      return controller.save(view.bindingToken, view.ownerToken, next, 'Saved');
    },
  };
}
module.exports = { fixture };
