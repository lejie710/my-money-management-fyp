import React, { useRef, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Switch, Text, View } from 'react-native';
import {
  AutomaticPreferences,
  ReminderCoordinator,
  ReminderOperationResult,
  ReminderRow,
  ReminderViewState,
} from '../reminders/coordinator';
import { Action, FormError, Screen, Sheet } from './components';
import { ReminderEditor } from './ReminderEditor';
import { localReminderUnavailableReason } from '../reminders/expoAdapter';
import { deviceTimeZone, reminderTime } from './reminderDisplay';
import { colors, ui } from './theme';

export type RemindersScreenProps = {
  state: ReminderViewState | null;
  coordinator: ReminderCoordinator | null;
  sampleMode: boolean;
  getBaselineKeys: () => readonly string[];
  onBack: () => void;
  startupError?: string;
  startupPending?: boolean;
  onRetryStartup?: () => void;
  onResumeActiveOwner?: () => Promise<ReminderOperationResult>;
  transitionBusy?: boolean;
};
const statusLabels: Record<ReminderRow['status'], string> = {
  scheduled: 'Scheduled',
  paused: 'Paused',
  elapsed: 'Time passed',
  creating: 'Pending creation',
  editing: 'Pending change',
  deleting: 'Pending deletion',
  error: 'Needs attention',
};
const preferences: {
  key: keyof AutomaticPreferences;
  label: string;
  detail: string;
  testID: string;
}[] = [
  {
    key: 'budgets',
    label: 'Budget overruns',
    detail: 'One notice when saved spending first passes a budget’s limit for its period.',
    testID: 'automatic-budget-notices',
  },
  {
    key: 'goal',
    label: 'Savings target',
    detail: 'Notices when recorded balance moves near or reaches the current target.',
    testID: 'automatic-goal-notices',
  },
  {
    key: 'achievements',
    label: 'Earned achievements',
    detail: 'One notice after a new milestone is durably saved.',
    testID: 'automatic-achievement-notices',
  },
];

export function RemindersScreen({
  state,
  coordinator,
  sampleMode,
  getBaselineKeys,
  onBack,
  startupError,
  startupPending,
  onRetryStartup,
  onResumeActiveOwner,
  transitionBusy,
}: RemindersScreenProps) {
  const [editor, setEditor] = useState<{ reminder?: ReminderRow } | null>(null);
  const [deleting, setDeleting] = useState<ReminderRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  const run = async (name: string, action: () => Promise<ReminderOperationResult>) => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(name);
    setError('');
    try {
      const result = await action();
      if (result.ok && !result.pending) setMessage(result.message);
      else {
        setMessage('');
        setError(result.message);
      }
      return result;
    } catch {
      setError(
        'The operation outcome could not be confirmed. Refresh reminders to inspect the saved recovery state.',
      );
      return null;
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };
  const compatible = state && coordinator && state.ownerToken === coordinator.ownerToken;
  const blocked =
    !compatible || state.loading || !!state.loadError || state.ownerPaused || state.cleanupPending;
  const permissionReady =
    !!state && state.permission.status === 'granted' && state.permission.channelEnabled !== false;
  const runtimeUnavailable = state?.permission.status === 'unavailable';
  const unavailableMessage =
    localReminderUnavailableReason() ??
    'Local reminders are unavailable in this runtime. Refresh status to check again.';
  const pendingCreate = state?.reminders.some((row) => row.pendingAction === 'create') ?? false;
  const openSettings = () => {
    void Linking.openSettings().catch(() =>
      setError(
        'App settings could not be opened. Open the app notification settings manually and return.',
      ),
    );
  };

  return (
    <>
      <Screen>
        <View style={{ marginBottom: 18 }}>
          <Action
            label="Back to wallet"
            secondary
            disabled={!!busy}
            onPress={onBack}
            testID="reminders-back"
          />
        </View>
        <Text style={ui.title} accessibilityRole="header">
          Reminders
        </Text>
        <Text style={[ui.body, ui.smallGap]}>
          One-off local reminders for this wallet. Times below use {deviceTimeZone()}.
        </Text>
        {startupError ? (
          <View style={[ui.card, ui.gap]}>
            <FormError message={startupError} />
            <Action
              label={startupPending ? 'Checking…' : 'Retry previous-wallet cleanup'}
              disabled={startupPending}
              onPress={() => onRetryStartup?.()}
              testID="retry-retired-reminders"
            />
          </View>
        ) : null}
        {!compatible || state.loading ? (
          <View style={[ui.card, ui.gap]}>
            <ActivityIndicator color={colors.purple} />
            <Text style={[ui.body, ui.smallGap]}>Opening this wallet's saved reminders…</Text>
          </View>
        ) : state.loadError ? (
          <View style={[ui.card, ui.gap]}>
            <Text style={ui.heading}>Saved reminders could not be opened</Text>
            <FormError message={state.loadError} />
            <Text style={[ui.hint, ui.smallGap]}>
              Existing saved data is retained. This is not an empty reminder list.
            </Text>
            <View style={ui.gap}>
              <Action
                label={busy ? 'Checking…' : 'Retry loading reminders'}
                disabled={!!busy}
                onPress={() => {
                  void run('load', () => coordinator.initialize(getBaselineKeys()));
                }}
                testID="retry-reminder-load"
              />
            </View>
          </View>
        ) : (
          <>
            {state.cleanupPending || state.ownerPaused ? (
              <View style={[ui.card, ui.gap]} testID="reminder-cleanup-pending">
                <Text style={ui.heading}>Wallet reminder cleanup</Text>
                <Text style={[ui.body, ui.smallGap]}>
                  {state.cleanupPending
                    ? 'Some owned schedules still need cancellation. The wallet transition is not complete.'
                    : 'This wallet’s reminder operations are paused for a wallet transition.'}
                </Text>
                {state.cleanupPending ? (
                  <View style={ui.smallGap}>
                    <Action
                      label="Retry owned-schedule cleanup"
                      disabled={!!busy}
                      onPress={() => {
                        void run('cleanup', () => coordinator.quiesceAndCancelOwner());
                      }}
                      testID="retry-reminder-cleanup"
                    />
                  </View>
                ) : null}
                {state.ownerPaused && !state.cleanupPending && onResumeActiveOwner ? (
                  <View style={ui.smallGap}>
                    <Action
                      label="Resume this wallet's reminders"
                      disabled={!!busy || transitionBusy || startupPending}
                      onPress={() => {
                        void run('resume', onResumeActiveOwner);
                      }}
                      testID="resume-active-reminders"
                    />
                  </View>
                ) : null}
                <Text style={[ui.hint, ui.smallGap]}>
                  Resume only after the current saved wallet is confirmed, or return to Wallet to
                  retry its replacement.
                </Text>
              </View>
            ) : null}
            <View style={[ui.card, ui.gap]}>
              <Text style={ui.heading}>Notification permission</Text>
              <Text style={[ui.body, ui.smallGap]} testID="reminder-permission">
                {permissionReady
                  ? 'Local notifications are enabled.'
                  : state.permission.channelEnabled === false
                    ? 'The Android notification channel is disabled.'
                    : state.permission.status === 'denied'
                      ? 'Notification permission is denied.'
                      : state.permission.status === 'unavailable'
                        ? unavailableMessage
                        : 'Permission has not been granted yet.'}
              </Text>
              {!permissionReady && !runtimeUnavailable ? (
                <View style={ui.gap}>
                  {state.permission.canAskAgain && state.permission.channelEnabled !== false ? (
                    <Action
                      label="Enable local notifications"
                      disabled={!!busy || blocked}
                      onPress={() => {
                        void run('permission', () => coordinator.requestPermission());
                      }}
                      testID="enable-reminder-permission"
                    />
                  ) : (
                    <Action
                      label="Open app settings"
                      secondary
                      disabled={!!busy}
                      onPress={openSettings}
                      testID="reminder-open-settings"
                    />
                  )}
                </View>
              ) : null}
              <View style={ui.smallGap}>
                <Action
                  label={busy === 'refresh' ? 'Checking…' : 'Refresh reminder status'}
                  secondary
                  disabled={!!busy}
                  onPress={() => {
                    void run('refresh', () => coordinator.reconcile());
                  }}
                  testID="refresh-reminders"
                />
              </View>
            </View>
            <FormError message={error || state.lastError || ''} testID="reminders-error" />
            {message ? (
              <Text
                style={[ui.body, ui.gap]}
                accessibilityLiveRegion="polite"
                testID="reminders-status"
              >
                {message}
              </Text>
            ) : null}
            <View style={ui.gap}>
              <Action
                label="+ Add reminder"
                disabled={!!busy || blocked || pendingCreate || runtimeUnavailable}
                onPress={() => {
                  setError('');
                  setEditor({});
                }}
                testID="add-reminder"
              />
            </View>
            {pendingCreate ? (
              <Text style={[ui.hint, ui.smallGap]}>
                Resolve or delete the pending creation below before adding another reminder.
              </Text>
            ) : null}
            {state.reminders.length === 0 ? (
              <View style={[ui.card, ui.gap]} testID="reminders-empty">
                <Text style={ui.heading}>No saved reminders</Text>
                <Text style={[ui.body, ui.smallGap]}>
                  Add a title, message, and delay to schedule a one-off reminder. Permission is
                  requested only when you choose to enable it.
                </Text>
              </View>
            ) : (
              state.reminders.map((row) => {
                const rowBusy = state.busyReminderIds.includes(row.id) || !!busy;
                return (
                  <View key={row.id} style={[ui.card, ui.gap]} testID={`reminder-${row.id}`}>
                    <Text style={ui.heading}>{row.title}</Text>
                    <Text
                      style={[styles.rowStatus, row.status === 'error' && { color: colors.red }]}
                    >
                      {row.status === 'scheduled' && row.scheduledAtMs <= Date.now()
                        ? 'Time passed; refresh to check saved state'
                        : statusLabels[row.status]}
                    </Text>
                    <Text style={[ui.body, ui.smallGap]}>{row.body}</Text>
                    <Text selectable style={[ui.hint, ui.smallGap]}>
                      {reminderTime(row.scheduledAtMs)} ({deviceTimeZone()})
                    </Text>
                    {row.pendingDraft ? (
                      <View style={ui.divider}>
                        <Text style={ui.hint}>Requested replacement</Text>
                        <Text style={[ui.body, ui.smallGap]}>{row.pendingDraft.title}</Text>
                        <Text style={[ui.body, ui.smallGap]}>{row.pendingDraft.body}</Text>
                        <Text selectable style={[ui.hint, ui.smallGap]}>
                          {reminderTime(row.pendingDraft.scheduledAtMs)}
                        </Text>
                      </View>
                    ) : null}
                    {row.message ? <FormError message={row.message} /> : null}
                    {row.canRetry ? (
                      <View style={ui.smallGap}>
                        <Action
                          label={
                            rowBusy
                              ? 'Working…'
                              : row.pendingAction === 'delete'
                                ? 'Retry deletion'
                                : 'Retry saved operation'
                          }
                          disabled={
                            rowBusy ||
                            state.ownerPaused ||
                            (runtimeUnavailable && row.pendingAction !== 'delete')
                          }
                          onPress={() => {
                            void run(row.id, () =>
                              row.pendingAction === 'delete'
                                ? coordinator.remove(row.id)
                                : coordinator.retry(row.id),
                            );
                          }}
                          testID={`retry-reminder-${row.id}`}
                        />
                      </View>
                    ) : null}
                    {row.canEdit ? (
                      <View style={ui.smallGap}>
                        <Action
                          label="Edit and reschedule"
                          secondary
                          disabled={rowBusy || blocked || runtimeUnavailable}
                          onPress={() => {
                            setError('');
                            setEditor({ reminder: row });
                          }}
                          testID={`edit-reminder-${row.id}`}
                        />
                      </View>
                    ) : null}
                    {row.canDelete ? (
                      <View style={ui.smallGap}>
                        <Action
                          label="Delete reminder"
                          secondary
                          danger
                          disabled={rowBusy || state.ownerPaused}
                          onPress={() => setDeleting(row)}
                          testID={`delete-reminder-${row.id}`}
                        />
                      </View>
                    ) : null}
                  </View>
                );
              })
            )}
            <View style={[ui.card, { marginTop: 28 }]}>
              <Text style={ui.heading}>Automatic notices</Text>
              <Text style={[ui.hint, ui.smallGap]}>
                Optional notices for newly observed saved changes. Enabling them does not announce
                old milestones.
              </Text>
              {sampleMode ? (
                <Text style={[ui.body, ui.smallGap]}>
                  Sample mode previews milestones and does not send automatic notices. Manual
                  reminders require a runtime that supports local scheduling.
                </Text>
              ) : null}
              {preferences.map((preference) => (
                <View key={preference.key} style={styles.preference}>
                  <View style={ui.flex}>
                    <Text style={styles.preferenceLabel}>{preference.label}</Text>
                    <Text style={[ui.hint, { marginTop: 5 }]}>{preference.detail}</Text>
                  </View>
                  <Switch
                    value={state.automatic[preference.key]}
                    disabled={!!busy || blocked || sampleMode || runtimeUnavailable}
                    accessibilityLabel={`${preference.label} automatic notices`}
                    testID={preference.testID}
                    trackColor={{ false: colors.border, true: colors.accent }}
                    thumbColor={colors.onAccent}
                    onValueChange={(value) => {
                      void run(`preference-${preference.key}`, () =>
                        coordinator.setAutomaticPreferences(
                          { ...state.automatic, [preference.key]: value },
                          getBaselineKeys(),
                        ),
                      );
                    }}
                  />
                </View>
              ))}
              {state.automaticNoticeErrors.map((item) => (
                <FormError key={item.key} message={`${item.kind} notice: ${item.message}`} />
              ))}
              <Text style={[ui.hint, ui.gap]}>
                These notices are evaluated when the app opens or processes saved changes. They do
                not promise financial monitoring while the app is closed.
              </Text>
            </View>
            <Text style={[ui.hint, ui.gap]}>
              Android may delay best-effort reminders. A time that has passed or a request missing
              from the pending list is not proof that a notification was shown.
            </Text>
          </>
        )}
      </Screen>
      {editor && compatible ? (
        <ReminderEditor
          key={`${state.ownerToken}-${editor.reminder?.id ?? 'new'}`}
          coordinator={coordinator}
          state={state}
          reminder={editor.reminder}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {deleting && compatible ? (
        <Sheet title="Delete reminder" busy={!!busy} onClose={() => setDeleting(null)}>
          <Text style={[ui.body, { marginTop: 16 }]}>
            Cancel future schedules for “{deleting.title}” and delete the saved record?
            Notifications already displayed may remain visible.
          </Text>
          <FormError message={error || state.lastError || ''} />
          <View style={ui.gap}>
            <Action
              label={busy ? 'Canceling…' : 'Yes, delete reminder'}
              danger
              secondary
              disabled={!!busy}
              testID="confirm-delete-reminder"
              onPress={() => {
                void run(deleting.id, () => coordinator.remove(deleting.id)).then((result) => {
                  if (result?.ok && !result.pending) setDeleting(null);
                });
              }}
            />
          </View>
          <View style={ui.smallGap}>
            <Action
              label="Keep reminder"
              secondary
              disabled={!!busy}
              onPress={() => setDeleting(null)}
            />
          </View>
        </Sheet>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  rowStatus: {
    color: colors.purple,
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '600',
    marginTop: 6,
  },
  preference: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 20 },
  preferenceLabel: { color: colors.text, fontSize: 15, lineHeight: 22, fontWeight: '600' },
});
