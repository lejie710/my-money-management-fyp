import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createEmptyLedger, type Ledger } from '../core/model';
import { createLedgerStorage } from '../core/storage';
import { captureAchievementClock, type AchievementClock } from '../core/achievements';
import type { LedgerTransitionGuard } from '../core/commitLedger';
import {
  createVerificationLedger,
  validateTestScenario,
  verificationClock,
} from '../verification/fixtures';
import type { ReminderScope } from '../reminders/coordinator';
import { encodeDataFamily, type DataFamily } from '../accounts/identity';
import { createLedgerRuntime, type LedgerStorage, type CommitObserver } from './ledgerRuntime';
export type { CommitObserver } from './ledgerRuntime';

declare const process: {
  env: { EXPO_PUBLIC_TEST_DATA_NAMESPACE?: string; EXPO_PUBLIC_TEST_SCENARIO?: string };
};
const testNamespace = process.env.EXPO_PUBLIC_TEST_DATA_NAMESPACE;
const testScenario = process.env.EXPO_PUBLIC_TEST_SCENARIO;
export const localLedgerScope: ReminderScope = testNamespace
  ? { kind: 'test', namespace: testNamespace }
  : { kind: 'canonical' };
export const localLedgerFamily: DataFamily = { scope: localLedgerScope, actor: { kind: 'local' } };
export const validateLocalLedgerConfiguration = () => {
  validateTestScenario(testNamespace, testScenario);
};
export const getLocalLedgerClock = (): AchievementClock => {
  try {
    return verificationClock(testNamespace, testScenario) ?? captureAchievementClock();
  } catch {
    // Recovery screens still need a date. Configuration validation separately
    // refuses storage access and identity activation before using a fixture.
    return captureAchievementClock();
  }
};
const defaultClock = getLocalLedgerClock;
const trace = (stage: string) => {
  if (testNamespace) console.info(`[FYP storage trace] ${stage}`);
};
const storageAdapter = testNamespace
  ? {
      async getItem(key: string) {
        trace('read-start');
        try {
          const value = await AsyncStorage.getItem(key);
          trace('read-complete');
          return value;
        } catch (error) {
          trace('read-failed');
          throw error;
        }
      },
      async setItem(key: string, value: string) {
        trace('write-start');
        try {
          await AsyncStorage.setItem(key, value);
          trace('write-complete');
        } catch (error) {
          trace('write-failed');
          throw error;
        }
      },
    }
  : AsyncStorage;
export const localLedgerStorage = createLedgerStorage(
  storageAdapter,
  testNamespace
    ? {
        key: `@mymoney/test/${testNamespace}/v5`,
        legacyKeys: [4, 3, 2, 1].map((version) => `@mymoney/test/${testNamespace}/v${version}`),
      }
    : undefined,
);
export const createLocalInitialLedger = () => {
  const scenario = validateTestScenario(testNamespace, testScenario);
  return scenario ? createVerificationLedger(testNamespace!, scenario) : createEmptyLedger();
};
const defaultSeed = createLocalInitialLedger;
const defaultRuntime = {};
export type SaveLedger = (next: Ledger, message: string) => Promise<boolean>;
export type UseLedgerOptions = {
  runtime?: object;
  deferInitialRestore?: boolean;
  initialFamily?: DataFamily;
  initialStorage?: LedgerStorage;
  createInitialLedger?: () => Ledger;
  getClock?: () => AchievementClock;
  validateConfiguration?: () => void;
};

export function useLedger(options: UseLedgerOptions = {}) {
  const runtime = options.runtime ?? defaultRuntime;
  const family = options.initialFamily ?? localLedgerFamily;
  const familyToken = encodeDataFamily(family);
  const storage = options.initialStorage ?? localLedgerStorage;
  const seed = options.createInitialLedger ?? defaultSeed;
  const clock = options.getClock ?? defaultClock;
  const validateConfiguration = options.validateConfiguration ?? validateLocalLedgerConfiguration;
  if (
    familyToken !== encodeDataFamily(localLedgerFamily) &&
    (!options.initialStorage || !options.createInitialLedger)
  )
    throw new Error(
      'A non-default initial family needs its own storage and initial-ledger factory.',
    );
  const controller = useMemo(
    () =>
      createLedgerRuntime({
        runtime,
        family,
        storage,
        createInitialLedger: seed,
        getClock: clock,
        validateConfiguration,
        trace,
      }),
    [runtime, familyToken, storage, seed, clock, validateConfiguration],
  );
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (!options.deferInitialRestore) {
      trace('restore-effect');
      void controller.initialize();
    }
  }, [controller, options.deferInitialRestore]);
  const save = useCallback<SaveLedger>(
    (next, message) => controller.save(state.bindingToken, state.ownerToken, next, message),
    [controller, state.bindingToken, state.ownerToken],
  );
  const restore = useCallback(
    () => controller.restore(state.bindingToken, state.ownerToken),
    [controller, state.bindingToken, state.ownerToken],
  );
  const registerTransitionGuard = useCallback(
    (guard: LedgerTransitionGuard) => controller.registerTransitionGuard(state.bindingToken, guard),
    [controller, state.bindingToken],
  );
  const registerCommitObserver = useCallback(
    (observer: CommitObserver) => controller.registerCommitObserver(state.bindingToken, observer),
    [controller, state.bindingToken],
  );
  const clearSaveError = useCallback(
    () => controller.clearSaveError(state.bindingToken),
    [controller, state.bindingToken],
  );
  return {
    ...state,
    save,
    restore,
    registerTransitionGuard,
    registerCommitObserver,
    clearSaveError,
    getClock: controller.getClock,
    compareAndSave: controller.compareAndSave,
    acquireIdentityLease: controller.acquireIdentityLease,
    adoptIdentityTarget: controller.adoptIdentityTarget,
    isIdentityLeaseReady: controller.isIdentityLeaseReady,
    releaseIdentityLease: controller.releaseIdentityLease,
    getIdentityState: controller.getIdentityState,
  };
}
