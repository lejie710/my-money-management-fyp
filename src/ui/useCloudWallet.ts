import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { getAccountAppRuntime } from '../accounts/appRuntime';
import { encodeDataFamily } from '../accounts/identity';
import { createEverydayCloudController } from '../cloud/everydayController';
import { createBackupFileServices } from '../cloud/nativeFiles';
import type { useLedger } from './useLedger';
import type { AccountUiState } from './accountUiTypes';

export function useCloudWallet(options: {
  finance: ReturnType<typeof useLedger>;
  accountState: AccountUiState;
  runtime: ReturnType<typeof getAccountAppRuntime>;
  active: boolean;
  hasOpenEditor(): boolean;
}) {
  const latest = useRef(options);
  latest.current = options;
  const controller = useMemo(
    () =>
      createEverydayCloudController({
        getSetup() {
          const { runtime } = latest.current;
          const configuration = runtime.cloud.configuration;
          const view = runtime.coordinator.getSnapshot();
          const family =
            configuration && view.persistence === 'confirmed' && view.user
              ? {
                  scope: runtime.ledgerOptions.initialFamily.scope,
                  actor: {
                    kind: 'firebase-hosted' as const,
                    projectId: configuration.firebase.projectId,
                    uid: view.user.uid,
                  },
                }
              : null;
          return {
            configured: !!configuration,
            signedIn: !!family,
            family,
            ownerToken: view.activeOwnerToken,
            sessionToken: runtime.presentation.getSnapshot().viewToken,
          };
        },
        storeFor: (family) => latest.current.runtime.everydayStorageForFamily(family),
        getBinding() {
          const current = latest.current;
          const actual = current.finance.getIdentityState();
          return actual.ledger && actual.ownerToken
            ? {
                family: actual.family,
                ledger: actual.ledger,
                ownerToken: actual.ownerToken,
                bindingToken: actual.bindingToken,
                identityPending: actual.identityPending,
                allowed:
                  current.active &&
                  !actual.identityPending &&
                  !actual.writeInFlight &&
                  !actual.uncertain &&
                  !current.hasOpenEditor(),
                compareAndSave: current.finance.compareAndSave,
              }
            : null;
        },
        async readLocal(source, target) {
          const family =
            source === 'guest'
              ? { scope: target.scope, actor: { kind: 'local' as const } }
              : target;
          return {
            family,
            ledger: await latest.current.runtime.localStorageForFamily(family).readCurrent(),
          };
        },
        async refreshAccount() {
          if (latest.current.hasOpenEditor())
            throw new Error('Close the current editor before refreshing.');
          return latest.current.runtime.retryAccount();
        },
        async retryOperation(family, token) {
          const current = latest.current;
          if (current.hasOpenEditor()) return false;
          const actual = current.finance.getIdentityState();
          if (
            encodeDataFamily(actual.family) === encodeDataFamily(family) &&
            actual.ledger &&
            !actual.identityPending
          ) {
            const result = await current.finance.retryCloudDraft(token);
            if (result) await current.runtime.retryAccount();
            return result;
          }
          return (await current.runtime.coordinator.retryCloudDraft(token)).ok;
        },
        files: createBackupFileServices(),
        newId: () =>
          'preview-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12),
      }),
    [options.runtime],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(
    () => controller.ownerChanged(),
    [
      controller,
      options.accountState.viewToken,
      options.accountState.phase,
      options.finance.ownerToken,
      options.finance.bindingToken,
      options.finance.identityPending,
    ],
  );
  const retirementTimers = useRef(new Map<typeof controller, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = retirementTimers.current.get(controller);
    if (pending) clearTimeout(pending);
    retirementTimers.current.delete(controller);
    return () => {
      const timer = setTimeout(() => {
        retirementTimers.current.delete(controller);
        controller.dispose();
      }, 0);
      retirementTimers.current.set(controller, timer);
    };
  }, [controller]);
  return { controller, state };
}
