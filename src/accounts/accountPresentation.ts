import type { AccountCoordinator, AccessView } from './coordinator';
import { encodeDataFamily } from './identity';
import { validDate } from '../core/model';
import type {
  AccountResult,
  AccountUiController,
  AccountUiState,
  LocalResetController,
} from '../ui/accountUiTypes';

let nextBinding = 0;
export type AccountPresentation = AccountUiController & {
  /** Refresh a foreground/day change without starting any account or storage operation. */
  refresh(): void;
  /** Removes only this projection's subscription; the root owns coordinator/SDK lifetime. */
  dispose(): void;
};

export function createAccountPresentation(options: {
  coordinator: AccountCoordinator;
  today(): string;
  createResetSession?: () => LocalResetController;
  requestPasswordReset?: (email: string) => Promise<void>;
  /** Optional root recovery wrapper; must remain a read/reconcile action. */
  retry?: () => Promise<AccountResult>;
}): AccountPresentation {
  const { coordinator } = options;
  const binding = ++nextBinding;
  const listeners = new Set<() => void>();
  let disposed = false;
  let revision = 0;
  let lastFamily: string | null = null;
  let lastOwner: string | null = null;
  let unknownIdentity = false;
  let lastRetirementToken: string | null = null;
  let lastSessionRetired = false;
  let fingerprint = '';
  let snapshot: AccountUiState;

  function project(view: AccessView): AccountUiState {
    const today = options.today();
    if (!validDate(today)) throw new Error('Account presentation requires a valid local date.');
    // A temporarily absent active owner is not a new account. Unknown identity is
    // a separate boundary, so old forms are retired even if recovery returns the same UID.
    const unknown = view.persistence === 'unconfirmed' && view.phase === 'session-unavailable';
    let changedContext = unknown !== unknownIdentity;
    unknownIdentity = unknown;
    const retirementToken =
      typeof view.sessionRetirementToken === 'string' && view.sessionRetirementToken
        ? view.sessionRetirementToken
        : null;
    const sessionRetired = view.sessionRetired === true;
    if (retirementToken !== lastRetirementToken || sessionRetired !== lastSessionRetired) {
      changedContext = true;
      lastRetirementToken = retirementToken;
      lastSessionRetired = sessionRetired;
    }
    if (view.persistence === 'confirmed' && view.family) {
      const family = encodeDataFamily(view.family);
      if (family !== lastFamily) {
        changedContext = true;
        lastFamily = family;
        lastOwner = null;
      }
      if (view.activeOwnerToken !== null && view.activeOwnerToken !== lastOwner) {
        changedContext = true;
        lastOwner = view.activeOwnerToken;
      }
    }
    if (changedContext) revision++;
    const busy =
      view.phase === 'restoring' ||
      view.phase === 'switching' ||
      view.operation !== null ||
      (!view.capabilities.retry && view.recovery !== 'restart');
    const operation = view.operation === 'profile-extras' ? 'profile' : view.operation;
    const profileLoading = view.phase === 'restoring' || view.phase === 'switching';
    const profileUnavailable = ['unavailable', 'uncertain'].includes(view.profileExtrasStatus);
    const profileError =
      view.profileExtrasStatus === 'uncertain'
        ? 'The local profile save could not be confirmed. Check saved profile details before editing them again.'
        : view.profileExtrasStatus === 'unavailable'
          ? 'Saved local profile details could not be read. Existing data has been retained.'
          : '';
    const user = view.user
      ? Object.freeze({
          uid: view.user.uid,
          email: view.user.email,
          displayName: view.user.displayName,
        })
      : null;
    const extras = view.profileExtras
      ? Object.freeze({
          gender: view.profileExtras.gender,
          birthDate: view.profileExtras.birthDate,
        })
      : null;
    return Object.freeze({
      viewToken: `account-view-${binding}-${revision}`,
      provider: view.provider !== 'unconfigured' ? 'configured' : 'unconfigured',
      cloudAccount: view.provider === 'firebase-cloud',
      phase: view.phase,
      user,
      persistence: view.persistence,
      activeOwnerToken: view.activeOwnerToken,
      sessionRestored: view.sessionRestored,
      service: view.service,
      busy,
      operation: operation ?? (busy ? 'reconcile' : null),
      message: view.message,
      error: '', // Coordinator messages are already safe and shown once by the UI.
      blockedReason: sessionRetired
        ? 'The unavailable saved sign-in was removed. Restart the app before continuing. Saved wallets, profiles and photos have been retained.'
        : view.capabilities.retireSession && retirementToken
          ? 'The saved sign-in cannot be restored. You can remove this unavailable sign-in without deleting saved wallets.'
          : view.recovery === 'restart'
            ? 'Restart required before account changes. Saved wallets have been retained.'
            : '',
      canRetireSavedSession:
        !!view.capabilities.retireSession && !!retirementToken && !sessionRetired && !busy,
      sessionRetirementToken: retirementToken,
      sessionRetired,
      canSignIn: view.capabilities.signIn,
      canRegister: view.capabilities.register,
      canSignOut: view.capabilities.signOut,
      canEditProfile: view.capabilities.editProfile,
      canSaveLocalProfile: view.capabilities.saveProfileExtras,
      canRequestReset:
        !!options.createResetSession &&
        view.provider === 'local-emulator' &&
        view.phase === 'ready' &&
        view.persistence === 'confirmed' &&
        !busy,
      canRequestEmailReset: !!options.requestPasswordReset && view.phase === 'ready' && !busy,
      canRetry: view.capabilities.retry,
      today,
      profile: Object.freeze({
        phase: profileLoading ? 'loading' : profileUnavailable ? 'unavailable' : 'ready',
        extras,
        displayNamePending: view.profileNamePending,
        error: profileError,
      }),
    });
  }

  function refresh() {
    if (disposed) return;
    const next = project(coordinator.getSnapshot());
    const nextFingerprint = JSON.stringify(next);
    if (fingerprint === nextFingerprint) return;
    snapshot = next;
    fingerprint = nextFingerprint;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Presentation observers cannot alter account state or other observers.
      }
    }
  }
  refresh();
  const unsubscribe = coordinator.subscribe(refresh);
  // Close the read/subscribe gap without causing another account operation.
  refresh();
  const inactive = (): Promise<AccountResult> =>
    Promise.resolve({
      ok: false,
      pending: false,
      message: 'This account view is closed. Open Account again to continue.',
    });
  const invoke = (work: () => Promise<AccountResult>) => (disposed ? inactive() : work());
  const retry = () => invoke(() => (options.retry ? options.retry() : coordinator.retry()));
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    signIn: (input) => invoke(() => coordinator.signIn(input)),
    register: (input) => invoke(() => coordinator.register(input)),
    signOut: () => invoke(() => coordinator.signOut()),
    retireSavedSession: (token) =>
      invoke(() => {
        const current = coordinator.getSnapshot();
        if (
          !token ||
          current.sessionRetirementToken !== token ||
          !current.capabilities.retireSession ||
          current.sessionRetired
        )
          return Promise.resolve({
            ok: false,
            pending: false,
            message: 'This saved sign-in confirmation is no longer current. Review Account again.',
          });
        return coordinator.retireSavedSession(token);
      }),
    updateDisplayName: (name) => invoke(() => coordinator.updateDisplayName(name)),
    saveLocalProfile: (extras) => invoke(() => coordinator.saveProfileExtras(extras)),
    retry,
    retryProfile: retry,
    async requestPasswordReset(email: string) {
      if (disposed || !snapshot.canRequestEmailReset || !options.requestPasswordReset)
        return {
          ok: false,
          pending: false,
          message: 'Password reset is unavailable in this account view.',
        };
      try {
        await options.requestPasswordReset(email);
        return {
          ok: true,
          pending: false,
          message:
            'Password reset requested. If this address can receive a reset, check its inbox. Delivery has not been confirmed.',
        };
      } catch {
        return {
          ok: false,
          pending: false,
          message:
            'The password reset request was not confirmed. Check the address and connection before trying again.',
        };
      }
    },
    createResetSession() {
      if (disposed || !snapshot.canRequestReset || !options.createResetSession)
        throw new Error('Local password reset is unavailable in the current account view.');
      return options.createResetSession();
    },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      unsubscribe();
    },
  };
}
