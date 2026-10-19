import { useEffect, useLayoutEffect, useState } from 'react';
import { AppState } from 'react-native';
import { getAccountAppRuntime } from '../accounts/appRuntime';
import { encodeDataFamily } from '../accounts/identity';
import type { ActivatedWallet } from '../accounts/coordinator';
import type { ReminderNotificationData } from '../reminders/coordinator';
import { useLedger } from './useLedger';
import { useWalletPhotos } from './useWalletPhotos';
import { useWalletReminders } from './useWalletReminders';
import { useExportSession } from './useExportSession';
import { useServiceConnection } from '../services/useServiceConnection';
import { useCloudWallet } from './useCloudWallet';
import { useReceiptSession } from './useReceiptSession';
import { useAssistantSession } from './useAssistantSession';
import { useAccountView } from './useAccountView';
import { canShowAccountWallet } from './AccountAccessGate';
import type { AccountUiState } from './accountUiTypes';

export function useAccountRoot({
  hasOpenEditor,
  closeEditor,
  onReminderOpen,
  runtime = getAccountAppRuntime(),
}: {
  hasOpenEditor(): boolean;
  closeEditor(): void;
  onReminderOpen(data: ReminderNotificationData): void;
  runtime?: ReturnType<typeof getAccountAppRuntime>;
}) {
  const finance = useLedger(runtime.ledgerOptions);
  const accountState = useAccountView(runtime.presentation);
  const [mountConfirmed, setMountConfirmed] = useState(false);
  const financialAllowed =
    mountConfirmed &&
    !finance.loading &&
    !finance.loadError &&
    !finance.uncertain &&
    !finance.identityPending &&
    canShowAccountWallet(accountState, finance.ownerToken);
  const owner = finance.ledger
    ? { ...finance.family, incarnationId: finance.ledger.wallet.incarnationId }
    : null;
  const ownerActive = !finance.loading && !finance.loadError && !!finance.ledger;
  const photos = useWalletPhotos(finance.ledger, ownerActive, {
    family: finance.family,
    ledgerStorage: finance.storage,
  });
  const exports = useExportSession({
    ledger: finance.ledger,
    owner,
    active: financialAllowed,
    photos: photos.photos,
  });
  const companion = useServiceConnection({ auth: runtime.getAuthenticatedServiceBinding() });
  const assistant = useAssistantSession({
    ledger: finance.ledger,
    owner,
    active: financialAllowed,
    connection: companion,
    historyStorage: runtime.deviceStorage,
  });
  const receipts = useReceiptSession({
    ledger: finance.ledger,
    owner,
    active: ownerActive,
    visible: financialAllowed,
    photos: photos.photos,
    connection: companion,
    getToday: () => finance.getClock().today,
    onPhotoCleanupMessage: photos.onCleanupMessage,
  });
  const cloudWallet = useCloudWallet({
    finance,
    accountState,
    runtime,
    active: financialAllowed,
    hasOpenEditor: () => hasOpenEditor() || receipts.hasOpenDraft(),
  });
  const reminders = useWalletReminders({
    ledger: finance.ledger,
    active: ownerActive,
    family: finance.family,
    getClock: finance.getClock,
    registerTransitionGuard: finance.registerTransitionGuard,
    registerCommitObserver: finance.registerCommitObserver,
    autoResumePaused: false,
    presentationActive: financialAllowed,
    isOwnerCurrent: () => finance.getIdentityState().ownerToken === finance.ownerToken,
    onOpen: (data) => {
      exports.close();
      assistant.close();
      void receipts.close();
      closeEditor();
      onReminderOpen(data);
    },
  });
  useLayoutEffect(() =>
    runtime.bridge.bind({
      ledger: finance,
      photos,
      reminders,
      hasOpenEditor: () => hasOpenEditor() || receipts.hasOpenDraft(),
      closeEditor: () => {
        closeEditor();
        void receipts.close();
      },
      closeExports: () => {
        exports.close();
        assistant.close();
      },
    }),
  );
  useEffect(() => {
    let active = true;
    setMountConfirmed(false);
    void runtime.initializeView().finally(() => {
      if (active) setMountConfirmed(true);
    });
    return () => {
      active = false;
    };
  }, [runtime]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') runtime.presentation.refresh();
    });
    return () => subscription.remove();
  }, [runtime]);
  useEffect(() => {
    const saved = finance.ledger,
      view = runtime.coordinator.getSnapshot();
    if (
      !saved ||
      finance.identityPending ||
      finance.loading ||
      finance.loadError ||
      view.phase !== 'ready' ||
      !view.family ||
      encodeDataFamily(view.family) !== encodeDataFamily(finance.family)
    )
      return;
    let active = true;
    const isCurrent = () =>
      active && !runtime.bridge.hasHeldLease() && finance.getIdentityState().ledger === saved;
    const target: ActivatedWallet = {
      family: finance.family,
      owner: owner!,
      ownerToken: finance.ownerToken!,
      ledger: saved,
      storage: finance.storage,
    };
    void runtime.bridge.confirmCommittedOwner(target, isCurrent).then((ready) => {
      if (ready && isCurrent()) runtime.coordinator.observeCommittedWallet(finance.family, saved);
    });
    return () => {
      active = false;
    };
  }, [
    runtime,
    finance.ledger,
    finance.identityPending,
    finance.loading,
    finance.loadError,
    accountState.phase,
    accountState.activeOwnerToken,
  ]);
  let gateState: AccountUiState = accountState;
  if (!mountConfirmed)
    gateState = {
      ...accountState,
      phase: 'restoring',
      activeOwnerToken: null,
      busy: true,
      canRetry: false,
      canSignOut: false,
      message: 'Restoring the saved account session before opening a wallet.',
    };
  else if (accountState.phase === 'ready' && !financialAllowed)
    gateState = {
      ...accountState,
      phase: 'wallet-unavailable',
      activeOwnerToken: null,
      message:
        finance.saveError ||
        'The saved wallet or its owner preparation needs another check. Existing records are retained.',
    };
  return {
    finance,
    photos,
    reminders,
    exports,
    companion,
    cloudWallet,
    deviceStorage: runtime.deviceStorage,
    receipts,
    assistant,
    accountState,
    gateState,
    financialAllowed,
    controller: runtime.presentation,
  };
}
