import React, { useRef, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import {
  ReminderCoordinator,
  ReminderDraft,
  ReminderOperationResult,
  ReminderRow,
  ReminderViewState,
} from '../reminders/coordinator';
import {
  MAX_REMINDER_BODY_LENGTH,
  MAX_REMINDER_TITLE_LENGTH,
  parseReminderDelay,
} from '../reminders/store';
import { Action, Field, FormError, Sheet } from './components';
import { localReminderUnavailableReason } from '../reminders/expoAdapter';
import { deviceTimeZone, reminderTime } from './reminderDisplay';
import { useTheme } from './theme';

type Props = {
  coordinator: ReminderCoordinator;
  state: ReminderViewState;
  reminder?: ReminderRow;
  onClose: () => void;
};

export function ReminderEditor({ coordinator, state, reminder, onClose }: Props) {
  const { colors, ui } = useTheme();
  const [title, setTitle] = useState(reminder?.title ?? '');
  const [body, setBody] = useState(reminder?.body ?? '');
  const [delay, setDelay] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pendingKind, setPendingKind] = useState<'save' | 'delete' | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [chosenTime, setChosenTime] = useState<number | null>(null);
  const attempt = useRef<ReminderDraft | null>(null);
  const inFlight = useRef(false);
  const storageNeedsCheck = !!state.loadError || uncertain;
  const locked = !!pendingKind || storageNeedsCheck;
  const pendingRow = pendingId ? state.reminders.find((row) => row.id === pendingId) : null;
  const canRetryKnown =
    pendingRow &&
    (pendingKind === 'delete'
      ? pendingRow.pendingAction === 'delete' || pendingRow.canDelete
      : pendingRow.canRetry);
  const permissionReady =
    state.permission.status === 'granted' && state.permission.channelEnabled !== false;
  const runtimeUnavailable = state.permission.status === 'unavailable';
  const unavailableMessage =
    localReminderUnavailableReason() ??
    'Local reminders are unavailable in this runtime. Check saved state or return to the reminder list.';

  const editDraft = (setter: (text: string) => void, text: string) => {
    setter(text);
    setError('');
    attempt.current = null;
    setChosenTime(null);
  };
  const handleResult = (result: ReminderOperationResult, kind: 'save' | 'delete') => {
    if (result.ok && !result.pending) {
      onClose();
      return;
    }
    setError(result.message);
    if (result.pending) {
      setPendingId(result.reminderId ?? reminder?.id ?? pendingId);
      setPendingKind(kind);
    } else if (kind === 'save' && reminder) {
      const row = coordinator.getSnapshot().reminders.find((item) => item.id === reminder.id);
      if (row?.canEdit && !row.pendingAction) {
        setPendingId(null);
        setPendingKind(null);
        setUncertain(false);
      }
    }
  };
  const perform = async (
    action: () => Promise<ReminderOperationResult>,
    kind: 'save' | 'delete',
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      handleResult(await action(), kind);
    } catch {
      setUncertain(true);
      setPendingKind(kind);
      setPendingId(pendingId ?? reminder?.id ?? null);
      setError(
        'The operation outcome could not be confirmed. Check saved state before creating or changing another reminder.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const save = async () => {
    if (
      inFlight.current ||
      state.loading ||
      storageNeedsCheck ||
      state.ownerPaused ||
      state.cleanupPending
    )
      return;
    if (runtimeUnavailable && pendingKind !== 'delete') return;
    if (pendingId) {
      if (!canRetryKnown) return;
      await perform(
        () =>
          pendingKind === 'delete' ? coordinator.remove(pendingId) : coordinator.retry(pendingId),
        pendingKind ?? 'save',
      );
      return;
    }
    if (locked) return;
    try {
      if (!attempt.current) {
        const seconds = parseReminderDelay(delay);
        attempt.current = { title, body, scheduledAtMs: Date.now() + seconds * 1000 };
        setChosenTime(attempt.current.scheduledAtMs);
      }
      const draft = attempt.current;
      await perform(
        () => (reminder ? coordinator.edit(reminder.id, draft) : coordinator.create(draft)),
        'save',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Enter a valid positive delay.');
    }
  };
  const refreshUncertain = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await coordinator.reconcile();
      const snapshot = coordinator.getSnapshot();
      const knownId = pendingId ?? reminder?.id;
      const found = knownId
        ? snapshot.reminders.find((row) => row.id === knownId)
        : attempt.current
          ? snapshot.reminders.find(
              (row) =>
                (row.pendingDraft?.scheduledAtMs ?? row.scheduledAtMs) ===
                  attempt.current!.scheduledAtMs &&
                (row.pendingDraft?.title ?? row.title) === attempt.current!.title.trim() &&
                (row.pendingDraft?.body ?? row.body) === attempt.current!.body.trim(),
            )
          : null;
      if (!result.ok || result.pending || snapshot.loadError || snapshot.loading) {
        setUncertain(true);
        setError(
          snapshot.loadError ||
            result.message ||
            'Saved reminder state is still unconfirmed. Keep the draft and check again.',
        );
        return;
      }
      setUncertain(false);
      if (pendingKind === 'delete' && knownId && !found) {
        onClose();
        return;
      }
      if (found) {
        const desired = attempt.current;
        const matchesAttempt =
          desired &&
          found.title === desired.title.trim() &&
          found.body === desired.body.trim() &&
          found.scheduledAtMs === desired.scheduledAtMs;
        if (
          matchesAttempt &&
          found.status === 'scheduled' &&
          !found.pendingAction &&
          pendingKind !== 'delete'
        ) {
          onClose();
          return;
        }
        if (found.canEdit && !found.pendingAction && reminder && pendingKind !== 'delete') {
          setPendingId(null);
          setPendingKind(null);
          setError(
            'Saved state checked. The existing reminder is retained; review your draft before rescheduling.',
          );
          return;
        }
        setPendingId(found.id);
        setPendingKind(
          found.pendingAction === 'delete' || pendingKind === 'delete' ? 'delete' : 'save',
        );
        setError(
          found.message ?? 'Saved intent found. Retry it or delete it before changing the draft.',
        );
      } else if (knownId || attempt.current) {
        // Do not discard a known recovery identity or silently turn retry into a new create.
        setError(
          'Saved state was checked, but the attempted reminder is not present. Keep this draft and inspect the reminder list before starting another create.',
        );
        setUncertain(true);
      } else setError('Saved reminder state checked. Review the draft before scheduling.');
    } catch {
      setError('Saved reminder state could not be checked. Keep the draft and retry.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const enablePermission = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await coordinator.requestPermission();
      if (!result.ok) setError(result.message);
    } catch {
      setError('Notification permission could not be checked. Try again or open app settings.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const idToDelete = pendingId ?? reminder?.id;

  return (
    <Sheet title={reminder ? 'Edit reminder' : 'New reminder'} onClose={onClose} busy={busy}>
      {reminder ? (
        <Text style={[ui.hint, { marginTop: 16 }]}>
          Current time: {reminderTime(reminder.scheduledAtMs)} ({deviceTimeZone()}). Enter a new
          delay to reschedule after saving.
        </Text>
      ) : null}
      <Field
        label="Reminder title"
        value={title}
        editable={!busy && !locked}
        maxLength={MAX_REMINDER_TITLE_LENGTH}
        testID="reminder-title-input"
        placeholder="e.g. Review this week’s expenses"
        onChangeText={(value) => editDraft(setTitle, value)}
      />
      <Field
        label="Message"
        value={body}
        editable={!busy && !locked}
        maxLength={MAX_REMINDER_BODY_LENGTH}
        testID="reminder-body-input"
        placeholder="What should the reminder say?"
        multiline
        style={{ minHeight: 88, textAlignVertical: 'top' }}
        onChangeText={(value) => editDraft(setBody, value)}
      />
      <Field
        label={reminder ? 'New delay in seconds' : 'Delay in seconds'}
        value={delay}
        editable={!busy && !locked}
        maxLength={8}
        keyboardType="number-pad"
        testID="reminder-delay-input"
        placeholder="e.g. 60"
        onChangeText={(value) => editDraft(setDelay, value)}
        hint="Enter 1–31,536,000 whole seconds (up to 365 days). The delay is resolved when you first save."
      />
      {chosenTime ? (
        <Text selectable style={[ui.hint, ui.smallGap]} testID="reminder-chosen-time">
          Chosen time: {reminderTime(chosenTime)} ({deviceTimeZone()}). Retry keeps this time; edit
          the delay to choose another time after a definite failure.
        </Text>
      ) : null}
      {runtimeUnavailable ? (
        <Text style={[ui.body, ui.gap]} testID="editor-runtime-unavailable">
          {unavailableMessage}
        </Text>
      ) : !permissionReady ? (
        <View style={ui.gap}>
          <Text style={ui.body}>
            Local notification permission and the app's notification channel must be enabled before
            scheduling.
          </Text>
          <View style={ui.smallGap}>
            {state.permission.canAskAgain && state.permission.channelEnabled !== false ? (
              <Action
                label="Enable local notifications"
                secondary
                disabled={busy}
                onPress={() => {
                  void enablePermission();
                }}
                testID="editor-enable-permission"
              />
            ) : (
              <Action
                label="Open app settings"
                secondary
                disabled={busy}
                onPress={() => {
                  void Linking.openSettings().catch(() =>
                    setError(
                      'App settings could not be opened. Open them manually and return here.',
                    ),
                  );
                }}
                testID="editor-open-settings"
              />
            )}
          </View>
        </View>
      ) : null}
      <FormError message={error || state.loadError || ''} testID="reminder-error" />
      {locked ? (
        <Text style={[ui.hint, ui.smallGap]}>
          A saved or uncertain operation must be resolved before these fields can change. Closing
          keeps the recovery state in the reminder list.
        </Text>
      ) : null}
      {locked ? (
        <View style={ui.gap}>
          <Action
            label={busy ? 'Checking…' : 'Check saved state'}
            disabled={busy}
            onPress={() => {
              void refreshUncertain();
            }}
            testID="check-reminder-state"
          />
        </View>
      ) : null}
      {!locked || pendingId ? (
        <View style={ui.gap}>
          <Action
            label={
              busy
                ? 'Working…'
                : pendingKind === 'delete'
                  ? 'Retry deletion'
                  : pendingId
                    ? 'Retry saved reminder'
                    : reminder
                      ? 'Save and reschedule'
                      : 'Schedule reminder'
            }
            disabled={
              busy ||
              state.loading ||
              storageNeedsCheck ||
              state.ownerPaused ||
              state.cleanupPending ||
              (runtimeUnavailable && pendingKind !== 'delete') ||
              (!!pendingId && !canRetryKnown)
            }
            onPress={() => {
              void save();
            }}
            testID="save-reminder"
          />
        </View>
      ) : null}
      {idToDelete ? (
        <View style={ui.gap}>
          {!confirmDelete ? (
            <Action
              label="Delete reminder"
              danger
              secondary
              disabled={busy || storageNeedsCheck}
              onPress={() => setConfirmDelete(true)}
              testID="delete-reminder"
            />
          ) : (
            <>
              <Text style={ui.body}>
                Cancel this reminder's future schedules and remove its saved record? Notifications
                already displayed may remain visible.
              </Text>
              <View style={ui.smallGap}>
                <Action
                  label="Yes, delete reminder"
                  danger
                  secondary
                  disabled={busy || storageNeedsCheck}
                  onPress={() => {
                    void perform(() => coordinator.remove(idToDelete), 'delete');
                  }}
                  testID="confirm-delete-reminder"
                />
              </View>
              <View style={ui.smallGap}>
                <Action
                  label="Keep reminder"
                  secondary
                  disabled={busy}
                  onPress={() => setConfirmDelete(false)}
                />
              </View>
            </>
          )}
        </View>
      ) : null}
      <Text style={[ui.hint, ui.gap]}>
        Delivery is best effort and Android may delay it. A scheduled request is not proof that the
        notification was displayed.
      </Text>
    </Sheet>
  );
}
