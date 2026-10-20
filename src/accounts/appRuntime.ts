import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Ledger, LedgerIdentityContext } from '../core/model';
import type { AchievementClock } from '../core/achievements';
import {
  createAccountCoordinator,
  type AccountAuthAdapter,
  type AccessResult,
} from './coordinator';
import { createFamilyLedgerStorage, familyStorageKeys } from './familyStorage';
import { createProfileStore } from './profileStore';
import { encodeDataFamily, type DataFamily, type DataScope } from './identity';
import { createFinancialAccountBridge } from './financialBridge';
import { createAccountPresentation } from './accountPresentation';
import type { CloudConfiguration } from '../cloud/config';
import type { LocalFirebaseAuthAdapter } from './firebaseAdapter';
import type { LocalResetController } from '../ui/accountUiTypes';
import type { LedgerStorage } from '../ui/ledgerRuntime';
import type { EverydayCloudStore } from '../cloud/everydayStore';
import {
  localLedgerScope,
  createLocalInitialLedger,
  getLocalLedgerClock,
  validateLocalLedgerConfiguration,
} from '../ui/useLedger';

type Storage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};
type Auth = AccountAuthAdapter & {
  createResetSession?(): LocalResetController;
  requestPasswordReset?(email: string): Promise<void>;
  getSdkContext?: LocalFirebaseAuthAdapter['getSdkContext'];
};
declare const process: {
  env: { EXPO_PUBLIC_LOCAL_AUTH_EMULATOR?: string; EXPO_PUBLIC_FIREBASE_MODE?: string };
};

export function createAccountAppRuntime(options: {
  scope: DataScope;
  storage: Storage;
  auth: Auth | null;
  cloudConfiguration?: CloudConfiguration | null;
  cloudConfigurationError?: string;
  getClock(): AchievementClock;
  createGuestLedger(): Ledger;
  timeoutMs?: number;
  validateConfiguration?: () => void;
}) {
  const checkedStorage: Storage = {
    async getItem(key) {
      options.validateConfiguration?.();
      return options.storage.getItem(key);
    },
    async setItem(key, value) {
      options.validateConfiguration?.();
      return options.storage.setItem(key, value);
    },
    async removeItem(key) {
      options.validateConfiguration?.();
      return options.storage.removeItem(key);
    },
  };
  const bridge = createFinancialAccountBridge({ timeoutMs: options.timeoutMs });
  const stores = new Map<string, ReturnType<typeof createFamilyLedgerStorage>>(),
    profiles = new Map<string, ReturnType<typeof createProfileStore>>();
  const family: DataFamily = { scope: options.scope, actor: { kind: 'local' } };
  const identityContext: LedgerIdentityContext = {
    get clock() {
      return options.getClock();
    },
  };
  const localStorageForFamily = (target: DataFamily) => {
    const token = encodeDataFamily(target);
    let store = stores.get(token);
    if (!store) {
      store = createFamilyLedgerStorage(checkedStorage, target, { identityContext });
      stores.set(token, store);
    }
    return store;
  };
  const cloudStores = new Map<string, EverydayCloudStore>();
  const isCloudFamily = (target: DataFamily) =>
    !!options.cloudConfiguration &&
    target.actor.kind === 'firebase-hosted' &&
    target.actor.projectId === options.cloudConfiguration.firebase.projectId;
  const everydayStorageForFamily = (target: DataFamily): EverydayCloudStore => {
    if (
      !isCloudFamily(target) ||
      target.actor.kind !== 'firebase-hosted' ||
      !options.auth?.getSdkContext
    )
      throw new Error('This account does not have a configured cloud wallet.');
    const token = encodeDataFamily(target);
    let store = cloudStores.get(token);
    if (!store) {
      const { createEverydayCloudStore } =
        require('../cloud/everydayStore') as typeof import('../cloud/everydayStore');
      const { createFirebasePorts } =
        require('../cloud/firebasePorts') as typeof import('../cloud/firebasePorts');
      const { createEverydayPhotoServices } =
        require('../cloud/everydayFiles') as typeof import('../cloud/everydayFiles');
      const owner = { projectId: target.actor.projectId, uid: target.actor.uid };
      const getContext = () => {
        const context = options.auth!.getSdkContext!();
        if (
          context.uid !== owner.uid ||
          context.configuration.firebase.projectId !== owner.projectId
        )
          throw new Error('The cloud account changed.');
        return context;
      };
      store = createEverydayCloudStore({
        family: target,
        deviceStorage: checkedStorage,
        legacyStorage: localStorageForFamily(target),
        ports: () => createFirebasePorts(getContext, owner),
        files: createEverydayPhotoServices(),
        assertCurrent: () => {
          getContext();
        },
        now: () => options.getClock().nowMs,
        newId: () =>
          'wallet-' +
          Date.now().toString(36) +
          '-' +
          Math.random().toString(36).slice(2, 12) +
          '-' +
          Math.random().toString(36).slice(2, 12),
      });
      cloudStores.set(token, store);
    }
    return store;
  };
  const storageForFamily = (target: DataFamily): LedgerStorage =>
    isCloudFamily(target) ? everydayStorageForFamily(target) : localStorageForFamily(target);
  const storageKeyForFamily = (target: DataFamily) =>
    isCloudFamily(target)
      ? (
          require('../cloud/everydayFormat') as typeof import('../cloud/everydayFormat')
        ).everydayKeys(target).cache
      : familyStorageKeys(target).key;
  const profileForFamily = (target: DataFamily) => {
    const token = encodeDataFamily(target);
    let store = profiles.get(token);
    if (!store) {
      store = createProfileStore(checkedStorage, target, () => options.getClock().today);
      profiles.set(token, store);
    }
    return store;
  };
  const coordinator = createAccountCoordinator({
    runtime: {},
    scope: options.scope,
    firebaseProjectId: options.cloudConfiguration?.firebase.projectId,
    auth: options.auth,
    financial: bridge.financial,
    storageForFamily,
    storageKeyForFamily,
    profileForFamily,
    createGuestLedger: options.createGuestLedger,
    identityContext,
  });
  let pendingInitialization: Promise<AccessResult> | null = null,
    pendingRetry: Promise<AccessResult> | null = null;
  const retry = () => {
    if (pendingRetry) return pendingRetry;
    pendingRetry = (async () => {
      if (!(await bridge.recoverSavedWallet()))
        return {
          ok: false,
          pending: true,
          message:
            'The saved financial operation is still unconfirmed. Recheck when device storage is available.',
        };
      return coordinator.retry();
    })().finally(() => {
      pendingRetry = null;
    });
    return pendingRetry;
  };
  const presentation = createAccountPresentation({
    coordinator,
    today: () => options.getClock().today,
    retry,
    requestPasswordReset:
      options.cloudConfiguration && options.auth?.requestPasswordReset
        ? options.auth.requestPasswordReset
        : undefined,
    createResetSession:
      !options.cloudConfiguration && options.auth?.createResetSession
        ? () => options.auth!.createResetSession!()
        : undefined,
  });
  const getAuthenticatedServiceBinding = () => {
    const view = coordinator.getSnapshot();
    if (
      !options.cloudConfiguration ||
      !options.auth?.getSdkContext ||
      view.phase !== 'ready' ||
      view.persistence !== 'confirmed' ||
      !view.user ||
      !view.activeOwnerToken
    )
      return null;
    try {
      const captured = options.auth.getSdkContext();
      const user = captured.auth.currentUser;
      const viewToken = presentation.getSnapshot().viewToken;
      const ownerToken = view.activeOwnerToken;
      if (!user || user.uid !== view.user.uid || captured.uid !== user.uid) return null;
      const isCurrent = () => {
        try {
          const current = coordinator.getSnapshot();
          const sdk = options.auth!.getSdkContext!();
          return (
            current.phase === 'ready' &&
            current.persistence === 'confirmed' &&
            current.activeOwnerToken === ownerToken &&
            current.user?.uid === captured.uid &&
            presentation.getSnapshot().viewToken === viewToken &&
            sdk.app === captured.app &&
            sdk.auth === captured.auth &&
            sdk.auth.currentUser === user &&
            sdk.uid === captured.uid &&
            sdk.configuration.firebase.projectId === captured.configuration.firebase.projectId
          );
        } catch {
          return false;
        }
      };
      return Object.freeze({
        projectId: captured.configuration.firebase.projectId,
        uid: captured.uid,
        ownerToken,
        viewToken,
        isCurrent,
        async getIdToken(forceRefresh = false) {
          if (!isCurrent()) throw new Error('The signed-in account changed. Reopen this tool.');
          const token = await user.getIdToken(forceRefresh);
          if (!isCurrent()) throw new Error('The signed-in account changed. Reopen this tool.');
          return token;
        },
      });
    } catch {
      return null;
    }
  };
  return {
    bridge,
    coordinator,
    presentation,
    deviceStorage: checkedStorage,
    getAuthenticatedServiceBinding,
    storageForFamily,
    localStorageForFamily,
    everydayStorageForFamily,
    retryAccount: retry,
    cloud: {
      configuration: options.cloudConfiguration ?? null,
      error: options.cloudConfigurationError ?? '',
      getSdkContext: options.auth?.getSdkContext,
    },
    ledgerOptions: {
      runtime: {},
      deferInitialRestore: true,
      initialFamily: family,
      initialStorage: storageForFamily(family),
      createInitialLedger: options.createGuestLedger,
      getClock: options.getClock,
      validateConfiguration: options.validateConfiguration,
    },
    initializeView() {
      if (!pendingInitialization)
        pendingInitialization = coordinator.initialize().finally(() => {
          pendingInitialization = null;
        });
      return pendingInitialization;
    },
  };
}
let defaultRuntime: ReturnType<typeof createAccountAppRuntime> | null = null;
export function getAccountAppRuntime() {
  if (!defaultRuntime) {
    let auth: Auth | null = null;
    const cloud: { configuration: CloudConfiguration | null; error: string } =
      process.env.EXPO_PUBLIC_FIREBASE_MODE && process.env.EXPO_PUBLIC_FIREBASE_MODE !== 'off'
        ? (
            require('../cloud/nativeConfig') as typeof import('../cloud/nativeConfig')
          ).configuredFirebase()
        : { configuration: null, error: '' };
    if (cloud.configuration || process.env.EXPO_PUBLIC_LOCAL_AUTH_EMULATOR === '1') {
      try {
        const { createLocalFirebaseAuthAdapter } =
          require('./firebaseNative') as typeof import('./firebaseNative');
        auth = createLocalFirebaseAuthAdapter({
          runtime: {},
          scope: localLedgerScope,
          storage: AsyncStorage,
          configuration: cloud.configuration ?? undefined,
        });
      } catch {
        const unavailable = async () => ({
          user: null,
          persistence: 'unconfirmed' as const,
          service: 'unavailable' as const,
          mutationPending: false,
          recovery: 'restart' as const,
        });
        const blocked = async () => {
          throw new Error(
            'Local account access is unavailable in this running build. Restart the updated app.',
          );
        };
        auth = {
          initialize: unavailable,
          confirmIdentity: unavailable,
          subscribe: () => () => {},
          signIn: blocked,
          register: blocked,
          signOut: blocked,
          updateDisplayName: blocked,
        };
      }
    }
    defaultRuntime = createAccountAppRuntime({
      scope: localLedgerScope,
      storage: AsyncStorage,
      auth,
      cloudConfiguration: cloud.configuration,
      cloudConfigurationError: cloud.error,
      getClock: getLocalLedgerClock,
      validateConfiguration: validateLocalLedgerConfiguration,
      createGuestLedger: createLocalInitialLedger,
    });
  }
  return defaultRuntime;
}
