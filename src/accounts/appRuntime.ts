import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Ledger, LedgerIdentityContext } from '../core/model';
import type { AchievementClock } from '../core/achievements';
import {
  createAccountCoordinator,
  type AccountAuthAdapter,
  type AccessResult,
} from './coordinator';
import { createFamilyLedgerStorage } from './familyStorage';
import { createProfileStore } from './profileStore';
import { encodeDataFamily, type DataFamily, type DataScope } from './identity';
import { createFinancialAccountBridge } from './financialBridge';
import { createAccountPresentation } from './accountPresentation';
import type { LocalResetController } from '../ui/accountUiTypes';
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
type Auth = AccountAuthAdapter & { createResetSession?(): LocalResetController };
declare const process: { env: { EXPO_PUBLIC_LOCAL_AUTH_EMULATOR?: string } };

export function createAccountAppRuntime(options: {
  scope: DataScope;
  storage: Storage;
  auth: Auth | null;
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
  const storageForFamily = (target: DataFamily) => {
    const token = encodeDataFamily(target);
    let store = stores.get(token);
    if (!store) {
      store = createFamilyLedgerStorage(checkedStorage, target, { identityContext });
      stores.set(token, store);
    }
    return store;
  };
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
    auth: options.auth,
    financial: bridge.financial,
    storageForFamily,
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
    createResetSession: options.auth?.createResetSession
      ? () => options.auth!.createResetSession!()
      : undefined,
  });
  return {
    bridge,
    coordinator,
    presentation,
    storageForFamily,
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
    if (process.env.EXPO_PUBLIC_LOCAL_AUTH_EMULATOR === '1') {
      try {
        const { createLocalFirebaseAuthAdapter } =
          require('./firebaseNative') as typeof import('./firebaseNative');
        auth = createLocalFirebaseAuthAdapter({
          runtime: {},
          scope: localLedgerScope,
          storage: AsyncStorage,
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
      getClock: getLocalLedgerClock,
      validateConfiguration: validateLocalLedgerConfiguration,
      createGuestLedger: createLocalInitialLedger,
    });
  }
  return defaultRuntime;
}
