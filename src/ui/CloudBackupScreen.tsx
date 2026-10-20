import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { Action, Choice, FormError, Screen } from './components';
import { useTheme } from './theme';
import { formatMoney } from '../core/model';
import type { BackupController, CloudPreview } from '../cloud/backupCoordinator';

const quantity = (count: number, noun: string) =>
  String(count) + ' ' + noun + (count === 1 ? '' : 's');
function Preview({ value, liveWallet = false }: { value: CloudPreview; liveWallet?: boolean }) {
  const { colors, ui } = useTheme();
  return (
    <View style={[ui.card, ui.gap]}>
      <Text style={ui.heading}>
        {value.kind === 'backup'
          ? 'Back up this wallet?'
          : value.kind === 'guest-copy'
            ? 'Copy your guest wallet?'
            : 'Restore this backup?'}
      </Text>
      <Text style={[ui.body, ui.smallGap]}>
        {value.walletName} · {value.currency}
      </Text>
      <Text style={ui.body}>
        {quantity(value.transactions, 'transaction')} · {quantity(value.budgets, 'budget')} ·{' '}
        {value.hasGoal ? 'Savings goal included' : 'No savings goal'}
      </Text>
      <Text style={ui.body}>{quantity(value.photos, 'photo attachment')}</Text>
      <Text style={[ui.heading, ui.smallGap]}>
        {formatMoney(value.balanceMinor, value.currency)}
      </Text>
      <Text style={[ui.hint, ui.smallGap]}>
        {value.kind === 'backup'
          ? 'Financial records, notes and person/place labels will be stored in your configured Firebase project. Photos follow your selection.'
          : liveWallet
            ? 'Restoring saves these records and selected attachments into your unchanged empty Firebase wallet. Other devices can retrieve the restored wallet. Scheduled notifications are not copied.'
            : 'Only an unchanged empty account wallet can receive these records. Sessions and scheduled notifications are not copied.'}
      </Text>
    </View>
  );
}
export function CloudBackupScreen({
  controller,
  onBack,
  onAccount,
  liveWallet = false,
  onCloudWallet,
}: {
  controller: BackupController;
  onBack(): void;
  onAccount?(): void;
  liveWallet?: boolean;
  onCloudWallet?(): void;
}) {
  const { colors, ui } = useTheme();
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [photos, setPhotos] = useState(false),
    [discardAcknowledgement, setDiscardAcknowledgement] = useState<string | null>(null);
  const discardTarget = state.pending?.backupId ?? (state.journalBlocked ? 'unavailable' : null);
  const discardConfirmed = discardTarget !== null && discardAcknowledgement === discardTarget;
  useEffect(() => {
    if (state.setup.configured && state.setup.signedIn) void controller.open();
    return () => controller.cancel();
  }, [controller, state.setup.configured, state.setup.signedIn]);
  const ready = state.setup.configured && state.setup.signedIn;
  return (
    <Screen>
      <Action
        label="Back to Connections"
        secondary
        disabled={state.busy}
        onPress={onBack}
        testID="cloud-back"
      />
      <Text style={[ui.title, ui.gap]}>Cloud Backup</Text>
      <Text style={[ui.body, ui.smallGap]}>
        {liveWallet
          ? 'Keep a separate recovery snapshot of your Firebase wallet. Everyday account edits already save to Firebase.'
          : 'Keep a deliberate copy of your wallet. Ordinary edits stay on this device.'}
      </Text>
      {!state.setup.configured ? (
        <View style={[ui.card, ui.gap]}>
          <Text style={ui.heading}>Optional Firebase setup</Text>
          <Text style={[ui.body, ui.smallGap]}>
            {state.setup.error ||
              'Configure your own Firebase project using the repository setup guide. No account, key or cloud connection is required for everyday tracking.'}
          </Text>
        </View>
      ) : (
        <Text style={[ui.hint, ui.gap]}>
          Project: {state.setup.projectId}
          {state.setup.mode === 'emulator' ? ' · Local emulator verification' : ''}
        </Text>
      )}
      {state.setup.configured && !state.setup.signedIn ? (
        <Text style={[ui.body, ui.gap]}>
          Sign in through Connections → Account before backing up. Signing in keeps the guest wallet
          separate. Existing guest records are copied only after your confirmation.
        </Text>
      ) : null}
      {state.setup.configured && !state.setup.signedIn && onAccount ? (
        <View style={ui.gap}>
          <Action label="Open account sign-in" onPress={onAccount} testID="cloud-open-account" />
        </View>
      ) : null}
      <FormError message={state.error} testID="cloud-error" />
      {state.message ? (
        <Text style={[ui.body, ui.gap]} accessibilityLiveRegion="polite" testID="cloud-status">
          {state.message}
        </Text>
      ) : null}
      {state.cleanupPending ? (
        <View style={ui.gap}>
          <Text style={ui.body} testID="cloud-cleanup-status">
            {state.cleanupMessage}
          </Text>
          <Action
            label="Retry photo cleanup"
            secondary
            disabled={state.busy}
            onPress={() => {
              void controller.retryCleanup();
            }}
            testID="cloud-retry-cleanup"
          />
        </View>
      ) : null}
      {ready ? (
        <>
          <View style={ui.gap}>
            <Choice
              label="Include photo attachments"
              selected={photos}
              disabled={state.busy}
              onPress={() => setPhotos((value) => !value)}
              testID="cloud-include-photos"
            />
          </View>
          <Text style={[ui.hint, ui.smallGap]}>
            Up to 100 photos, 50 MiB combined; wallet snapshot up to 5 MiB. Unselected photos are
            explicitly excluded.
          </Text>
          {state.pending || state.journalBlocked ? (
            <View style={[ui.card, ui.gap]}>
              <Text style={ui.heading}>Pending backup</Text>
              <Text style={[ui.body, ui.smallGap]}>
                {state.pending
                  ? `${state.pending.transactions} captured transactions · ${state.pending.photos} photos`
                  : 'Pending backup state is unavailable. Recheck it before creating another backup.'}
              </Text>
              <Action
                label={state.pending ? 'Resume and reconcile backup' : 'Recheck pending backup'}
                disabled={state.busy}
                onPress={() => {
                  void controller.resumeBackup();
                }}
                testID="cloud-resume"
              />
              <Choice
                label="Discard the pending local operation; keep any cloud objects"
                selected={discardConfirmed}
                disabled={state.busy}
                onPress={() => setDiscardAcknowledgement(discardConfirmed ? null : discardTarget)}
              />
              <Action
                label="Discard pending operation"
                danger
                secondary
                disabled={state.busy || !discardConfirmed}
                onPress={() => {
                  const latest = controller.getSnapshot();
                  const latestTarget =
                    latest.pending?.backupId ?? (latest.journalBlocked ? 'unavailable' : null);
                  if (!discardConfirmed || latestTarget !== discardTarget) return;
                  void controller.discardPending(
                    discardTarget === 'unavailable' ? null : discardTarget,
                  );
                  setDiscardAcknowledgement(null);
                }}
                testID="cloud-discard-pending"
              />
            </View>
          ) : null}
          <View style={ui.gap}>
            <Action
              label="Preview cloud backup"
              disabled={state.busy || !!state.pending || state.journalBlocked}
              onPress={() => {
                void controller.previewBackup(photos);
              }}
              testID="cloud-preview-backup"
            />
          </View>
          {liveWallet ? (
            <View style={ui.smallGap}>
              <Text style={ui.hint}>
                Use Cloud wallet to preview and confirm a copy of existing device records into an
                empty Firebase wallet.
              </Text>
              {onCloudWallet ? (
                <Action
                  label="Open Cloud wallet"
                  secondary
                  disabled={state.busy}
                  onPress={onCloudWallet}
                  testID="cloud-open-live-wallet"
                />
              ) : null}
            </View>
          ) : (
            <>
              <View style={ui.smallGap}>
                <Action
                  label="Preview guest wallet copy"
                  secondary
                  disabled={state.busy}
                  onPress={() => {
                    void controller.previewGuestCopy(photos);
                  }}
                  testID="cloud-preview-guest"
                />
              </View>
              <Text style={[ui.hint, ui.smallGap]}>
                Guest copying requires an empty account wallet. The original guest wallet stays on
                this device; copying does not upload it.
              </Text>
            </>
          )}
          {state.preview ? (
            <>
              <Preview value={state.preview} liveWallet={liveWallet} />
              <View style={ui.gap}>
                <Action
                  label={
                    state.preview.kind === 'backup'
                      ? 'Confirm cloud backup'
                      : state.preview.kind === 'guest-copy'
                        ? 'Confirm copy to empty wallet'
                        : liveWallet
                          ? 'Confirm restore to Firebase wallet'
                          : 'Confirm restore to empty wallet'
                  }
                  disabled={state.busy || (liveWallet && state.preview.kind === 'guest-copy')}
                  onPress={() => {
                    if (liveWallet && state.preview?.kind === 'guest-copy') return;
                    void (state.preview!.kind === 'backup'
                      ? controller.confirmBackup()
                      : state.preview!.kind === 'guest-copy'
                        ? controller.confirmGuestCopy()
                        : controller.confirmRestore());
                  }}
                  testID="cloud-confirm-preview"
                />
              </View>
              <View style={ui.smallGap}>
                <Action
                  label="Keep current wallet"
                  secondary
                  disabled={state.busy}
                  onPress={controller.clearPreview}
                  testID="cloud-cancel-preview"
                />
              </View>
            </>
          ) : null}
          <View style={ui.gap}>
            <Action
              label="Load completed backups"
              secondary
              disabled={state.busy}
              onPress={() => {
                void controller.listBackups();
              }}
              testID="cloud-list"
            />
          </View>
          {state.backups.map((item) => (
            <View key={item.backupId} style={[ui.card, ui.gap]}>
              <Text style={ui.heading}>{new Date(item.createdAtMs).toLocaleString()}</Text>
              <Text style={[ui.body, ui.smallGap]}>
                {item.currency} · {quantity(item.transactionCount, 'transaction')} ·{' '}
                {quantity(item.photoCount, 'photo')}
              </Text>
              <Action
                label="Preview restore"
                secondary
                disabled={state.busy}
                onPress={() => {
                  void controller.previewRestore(item);
                }}
                testID={`cloud-restore-${item.backupId}`}
              />
            </View>
          ))}
          {state.busy ? (
            <View style={ui.gap}>
              <Action
                label="Cancel pending network work"
                secondary
                onPress={controller.cancel}
                testID="cloud-cancel"
              />
            </View>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
