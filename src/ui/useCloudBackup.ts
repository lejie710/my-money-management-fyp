import { useEffect, useMemo, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAccountAppRuntime } from '../accounts/appRuntime';
import { createBackupCoordinator, type BackupBinding } from '../cloud/backupCoordinator';
import { createFirebasePorts } from '../cloud/firebasePorts';
import { createCloudTransport } from '../cloud/transport';
import { createBackupFileServices } from '../cloud/nativeFiles';
import type { AccountUiState } from './accountUiTypes';
import type { useLedger } from './useLedger';
export function useCloudBackup(options: {
  finance: ReturnType<typeof useLedger>;
  accountState: AccountUiState;
  active: boolean;
  hasOpenEditor(): boolean;
}) {
  const latest = useRef(options);
  latest.current = options;
  const runtime = getAccountAppRuntime();
  const controller = useMemo(
    () =>
      createBackupCoordinator({
        getBinding() {
          const current = latest.current,
            actual = current.finance.getIdentityState();
          return actual.ledger
            ? {
                ...actual,
                ledger: actual.ledger,
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
        getSetup() {
          const current = latest.current,
            actual = current.finance.getIdentityState();
          return {
            configured: !!runtime.cloud.configuration,
            signedIn: actual.family.actor.kind === 'firebase-hosted' && current.active,
            projectId: runtime.cloud.configuration?.firebase.projectId ?? null,
            mode: runtime.cloud.configuration?.mode ?? null,
            error: runtime.cloud.error,
            sessionToken: runtime.presentation.getSnapshot().viewToken,
          };
        },
        async readGuest() {
          const family = {
            scope: latest.current.finance.getIdentityState().family.scope,
            actor: { kind: 'local' as const },
          };
          return { family, ledger: await runtime.storageForFamily(family).readCurrent() };
        },
        files: createBackupFileServices(),
        storage: AsyncStorage,
        transportFor(owner) {
          if (!runtime.cloud.getSdkContext) throw new Error('Cloud backup is not configured.');
          return createCloudTransport({
            owner,
            sdk: createFirebasePorts(runtime.cloud.getSdkContext, owner),
          });
        },
        newId: (kind) =>
          `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`,
      }),
    [runtime],
  );
  useEffect(
    () => controller.ownerChanged(),
    [
      controller,
      options.finance.ownerToken,
      options.finance.bindingToken,
      options.accountState.viewToken,
      options.active,
      options.accountState.busy,
      options.accountState.service,
    ],
  );
  useEffect(() => () => controller.cancel(), [controller]);
  return { controller };
}
