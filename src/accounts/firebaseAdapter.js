// All SDK calls are injected;
// firebaseNative.ts supplies only the public Firebase app/auth entry points.
const {
  encodeDataScope,
  projectAccountUser,
  normalizeCredentials,
  normalizeDisplayName,
  safeAuthMessage,
} = require('./identity');
const { createGuardedAuthPersistence } = require('./guardedPersistence');
const { createLocalResetController } = require('./localReset');
const bindings = new WeakMap();
const CONFIG = Object.freeze({ apiKey: 'demo-fyp-local', projectId: 'demo-fyp-local' });
const EMULATOR_URL = 'http://127.0.0.1:9099';
const SDK_METHODS = [
  'getApps',
  'initializeApp',
  'deleteApp',
  'initializeAuth',
  'getReactNativePersistence',
  'connectAuthEmulator',
  'beforeAuthStateChanged',
  'onAuthStateChanged',
  'signInWithEmailAndPassword',
  'createUserWithEmailAndPassword',
  'signOut',
  'updateProfile',
  'sendPasswordResetEmail',
  'verifyPasswordResetCode',
  'confirmPasswordReset',
];
function createFirebaseAuthAdapter({
  runtime,
  scope,
  storage,
  sdk,
  timeoutMs = 20000,
  fetchImpl = globalThis.fetch,
}) {
  if (
    !runtime ||
    typeof runtime !== 'object' ||
    !sdk ||
    SDK_METHODS.some((name) => typeof sdk[name] !== 'function')
  )
    throw new Error('A stable local account runtime and Firebase SDK are required.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new Error('Choose a bounded local account wait.');
  const scopeToken = encodeDataScope(scope);
  const existing = bindings.get(runtime);
  if (existing) {
    if (
      existing.scopeToken !== scopeToken ||
      existing.storage !== storage ||
      existing.fetchImpl !== fetchImpl ||
      SDK_METHODS.some((name) => existing.sdk[name] !== sdk[name])
    )
      throw new Error(
        'The account runtime belongs to another storage scope or SDK binding. Restart with the intended scope.',
      );
    return existing.adapter;
  }
  const appName = `mymoney-local-${encodeURIComponent(scopeToken)}`;
  const prefix = `@mymoney/auth/v1/${encodeURIComponent(scopeToken)}/`;
  // Pinned SDK13 native persistence key; verified against its installed source/tests.
  const sessionKey = `firebase:authUser:${CONFIG.apiKey}:${appName}`;
  const guard = createGuardedAuthPersistence(storage, { prefix, sessionKey });
  let app = null,
    auth = null,
    initializing = false,
    initialized = false,
    restartRequired = false;
  let initialization = null,
    beforeChange = null,
    ownMutation = false,
    middlewarePending = false;
  let initializationWaitTimedOut = false;
  let contextRevision = 0,
    resetBusy = false,
    resetNeedsSignal = false;
  let service = 'unchecked',
    firstAuthSignal = true,
    lastBlocked = false;
  const listeners = new Set();
  const notify = () => {
    if (!initialized && initializing) return;
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  };
  const restartError = () =>
    new Error(
      'Local account persistence is unavailable. Retained session data needs an app restart after storage is available.',
    );
  const safeError = (error, operation) => {
    const value = new Error(safeAuthMessage(error, operation));
    if (typeof error?.code === 'string' && /^auth\/[a-z0-9-]{1,80}$/.test(error.code))
      value.code = error.code;
    return value;
  };
  const serialized = (user) => {
    if (user === null) return null;
    if (!user || typeof user.toJSON !== 'function') throw restartError();
    const value = JSON.stringify(user.toJSON());
    if (typeof value !== 'string') throw restartError();
    return value;
  };
  const pending = () => initializing || ownMutation || middlewarePending || resetBusy;
  const unavailable = () => {
    let user = null;
    try {
      user = projectAccountUser(auth?.currentUser ?? null);
    } catch {
      restartRequired = true;
    }
    return Object.freeze({
      user,
      persistence: 'unconfirmed',
      service,
      mutationPending: pending(),
      recovery: restartRequired || guard.getState().blocked ? 'restart' : 'retry',
    });
  };
  const waitBounded = (promise) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      promise.then(
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        () => {
          clearTimeout(timer);
          resolve(false);
        },
      );
    });
  guard.subscribe(() => {
    const blocked = guard.getState().blocked;
    if (blocked && !lastBlocked) {
      lastBlocked = true;
      restartRequired = true;
      notify();
    }
  });

  function start() {
    initializing = true;
    // Start preflight before SDK hydration, but do not await it: emulator and
    // middleware must be attached synchronously after initializeAuth.
    const preflight = guard.preflight();
    try {
      if (sdk.getApps().some((candidate) => candidate.name === appName)) throw restartError();
      app = sdk.initializeApp(CONFIG, appName);
      if (
        app.name !== appName ||
        app.options?.apiKey !== CONFIG.apiKey ||
        app.options?.projectId !== CONFIG.projectId ||
        Object.keys(app.options).some((key) => !Object.hasOwn(CONFIG, key))
      )
        throw restartError();
      auth = sdk.initializeAuth(app, { persistence: sdk.getReactNativePersistence(guard.storage) });
      sdk.connectAuthEmulator(auth, EMULATOR_URL, { disableWarnings: true });
      if (
        auth.emulatorConfig?.host !== '127.0.0.1' ||
        auth.emulatorConfig?.port !== 9099 ||
        auth.emulatorConfig?.protocol !== 'http'
      )
        throw restartError();
      sdk.beforeAuthStateChanged(
        auth,
        async (next) => {
          if ((auth.currentUser?.uid ?? null) === (next?.uid ?? null)) return;
          contextRevision++;
          middlewarePending = true;
          try {
            if (!beforeChange) throw restartError();
            await beforeChange();
          } catch {
            middlewarePending = false;
            notify();
            throw new Error(
              'Account change is waiting for the saved wallet and its local operations.',
            );
          }
        },
        () => {
          middlewarePending = false;
          notify();
        },
      );
      sdk.onAuthStateChanged(auth, () => {
        contextRevision++;
        middlewarePending = false;
        if (firstAuthSignal) {
          firstAuthSignal = false;
          return;
        }
        notify();
      });
      initialization = Promise.all([preflight, auth.authStateReady()])
        .then(async () => {
          if (!(await guard.finishInitialization(serialized(auth.currentUser)))) {
            restartRequired = true;
            return;
          }
          initialized = true;
        })
        .catch(() => {
          restartRequired = true;
        })
        .finally(() => {
          initializing = false;
          if (initializationWaitTimedOut) notify();
        });
    } catch {
      restartRequired = true;
      // A fresh app with failed emulator setup must not remain a usable default endpoint.
      if (app?.name === appName) {
        try {
          Promise.resolve(sdk.deleteApp(app)).catch(() => {});
        } catch {}
      }
      initialization = preflight
        .catch(() => {})
        .finally(() => {
          initializing = false;
          if (initializationWaitTimedOut) notify();
        });
    }
  }

  async function confirmIdentity() {
    if (resetBusy) resetNeedsSignal = true;
    if (!initialized || !auth || pending() || restartRequired || guard.getState().blocked)
      return unavailable();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await guard.drain();
        if (pending()) return unavailable();
        const user = auth.currentUser,
          expected = serialized(user);
        const projected = projectAccountUser(user);
        const confirmed = await guard.confirm(expected);
        if (pending()) return unavailable();
        if (auth.currentUser !== user || serialized(auth.currentUser) !== expected) continue;
        if (confirmed && guard.getState().phase === 'ready')
          return Object.freeze({
            user: projected,
            persistence: 'confirmed',
            service,
            mutationPending: false,
            recovery: 'retry',
          });
        await Promise.resolve();
      } catch {
        restartRequired = true;
        return unavailable();
      }
    }
    restartRequired = true;
    return unavailable();
  }

  async function mutate(operation, work) {
    if (!initialized || !auth || restartRequired || guard.getState().blocked) throw restartError();
    if (pending()) {
      if (resetBusy) resetNeedsSignal = true;
      throw new Error(
        'An account operation is still settling. Check the saved session before trying again.',
      );
    }
    contextRevision++;
    ownMutation = true;
    try {
      await work();
      if (operation !== 'sign-out') service = 'available';
    } catch (error) {
      if (error?.code === 'auth/network-request-failed') service = 'unavailable';
      else if (
        [
          'auth/invalid-credential',
          'auth/wrong-password',
          'auth/user-not-found',
          'auth/email-already-in-use',
          'auth/weak-password',
          'auth/too-many-requests',
        ].includes(error?.code)
      )
        service = 'available';
      throw safeError(error, operation);
    } finally {
      ownMutation = false;
      middlewarePending = false;
      notify();
    }
  }
  const adapter = {
    initialize(beforeIdentityChange) {
      if (typeof beforeIdentityChange !== 'function')
        return Promise.reject(new Error('A financial identity-change guard is required.'));
      beforeChange = beforeIdentityChange;
      if (!initialization) start();
      return waitBounded(initialization).then((settled) => {
        if (!settled && initializing) initializationWaitTimedOut = true;
        return confirmIdentity();
      });
    },
    confirmIdentity,
    subscribe(listener) {
      if (typeof listener !== 'function')
        throw new Error('An account change listener is required.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    signIn(input) {
      const value = normalizeCredentials(input);
      return mutate('sign-in', () =>
        sdk.signInWithEmailAndPassword(auth, value.email, value.password),
      );
    },
    register(input) {
      const value = normalizeCredentials(input);
      return mutate('register', () =>
        sdk.createUserWithEmailAndPassword(auth, value.email, value.password),
      );
    },
    signOut() {
      return mutate('sign-out', () => sdk.signOut(auth));
    },
    updateDisplayName(expectedUid, name) {
      const value = normalizeDisplayName(name);
      return mutate('profile', () => {
        if (!auth.currentUser || auth.currentUser.uid !== expectedUid)
          throw new Error('The active account changed before the profile update.');
        return sdk.updateProfile(auth.currentUser, { displayName: value });
      });
    },
    createResetSession() {
      if (!initialized || !auth || pending() || restartRequired || guard.getState().blocked)
        throw restartError();
      const revision = contextRevision;
      return createLocalResetController({
        sdk,
        auth: () => auth,
        fetchImpl,
        isCurrent: () =>
          initialized &&
          !initializing &&
          !ownMutation &&
          !middlewarePending &&
          !restartRequired &&
          !guard.getState().blocked &&
          contextRevision === revision,
        async runExclusive(work) {
          if (pending() || contextRevision !== revision)
            throw new Error('The account binding is still settling.');
          resetBusy = true;
          try {
            return await work();
          } finally {
            resetBusy = false;
            if (resetNeedsSignal || contextRevision !== revision) {
              resetNeedsSignal = false;
              notify();
            }
          }
        },
      });
    },
  };
  bindings.set(runtime, { scopeToken, storage, sdk, fetchImpl, adapter });
  return adapter;
}
module.exports = { createFirebaseAuthAdapter, CONFIG, EMULATOR_URL };
