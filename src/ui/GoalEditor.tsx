import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import {
  amountInputValue,
  deleteGoal,
  GOAL_KINDS,
  GoalKind,
  goalFromDraft,
  saveGoal,
} from '../core/model';
import { Action, Choice, Field, FormError, Sheet } from './components';
import type { PlanProps } from './PlanScreen';
import { newId } from './TransactionEditor';
import { useTheme } from './theme';
import { FinancialFormDraftGate } from '../drafts/FinancialFormDraftGate';
import { useFormDraft } from '../drafts/useFormDraft';
import { ledgerFingerprint } from '../drafts/transactionDrafts';
import type { FinancialFormDraftStore, FormDraftSnapshot } from '../drafts/formDrafts';

type EditorProps = PlanProps & { onClose: () => void } & {
  draftStore?: FinancialFormDraftStore;
  isCurrent?: () => boolean;
};
export function GoalEditor(props: EditorProps) {
  return (
    <FinancialFormDraftGate
      key={props.draftStore?.key ?? props.ledger.wallet.incarnationId}
      kind="goal"
      store={props.draftStore}
      ledger={props.ledger}
      isCurrent={props.isCurrent}
      onClose={props.onClose}
    >
      {(initialDraft) => <GoalEditorForm {...props} initialDraft={initialDraft} />}
    </FinancialFormDraftGate>
  );
}
function GoalEditorForm({
  ledger,
  saving,
  saveError,
  onSave,
  clearSaveError,
  onClose,
  draftStore,
  isCurrent,
  initialDraft,
}: EditorProps & { initialDraft: FormDraftSnapshot }) {
  const { colors, ui } = useTheme();
  const [kind, setKind] = useState<GoalKind>(
    initialDraft.record?.kind === 'goal'
      ? initialDraft.record.fields.kind
      : (ledger.goal?.kind ?? 'emergencyFund'),
  );
  const [amount, setAmount] = useState(
    initialDraft.record?.kind === 'goal'
      ? initialDraft.record.fields.amount
      : ledger.goal
        ? amountInputValue(ledger.goal.targetMinor, ledger.wallet.currency)
        : '',
  );
  const [entityId] = useState(
    () => initialDraft.record?.entityId ?? ledger.goal?.id ?? newId('goal'),
  );
  const [baseFingerprint] = useState(
    () => initialDraft.record?.baseFingerprint ?? ledgerFingerprint(ledger),
  );
  const [submitting, setSubmitting] = useState(false),
    [closing, setClosing] = useState(false),
    [completed, setCompleted] = useState(false);
  const writing = useRef(false),
    active = useRef(true),
    latest = useRef({ ledger, isCurrent });
  latest.current = { ledger, isCurrent };
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const current = () => active.current && (latest.current.isCurrent?.() ?? true);
  const persistence = useFormDraft({
    store: draftStore,
    initial: initialDraft,
    isCurrent: current,
    value: { kind: 'goal', entityId, baseFingerprint, fields: { kind, amount } },
  });
  const busy = saving || submitting || closing;
  const editable = !busy && !completed;
  const close = () => {
    if (writing.current || busy || !current()) return;
    if (completed) {
      onClose();
      return;
    }
    setClosing(true);
    void persistence
      .flush()
      .then((ok) => {
        if (ok && current()) onClose();
      })
      .finally(() => {
        if (active.current) setClosing(false);
      });
  };
  const assertBase = () => {
    if (!current() || ledgerFingerprint(latest.current.ledger) !== baseFingerprint)
      throw new Error(
        'The wallet changed while this goal was open. Your draft is retained; reopen and review current records.',
      );
  };
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const finish = async () => {
    const cleared = await persistence.complete();
    if (!current()) return;
    if (cleared) onClose();
    else {
      setCompleted(true);
      setError(
        'The goal change was saved. Its older draft could not be cleared; close this form and review the retained draft before editing again.',
      );
    }
  };
  const save = async () => {
    if (!editable || writing.current || !current()) return;
    writing.current = true;
    setSubmitting(true);
    setError('');
    try {
      assertBase();
      if (!(await persistence.flush())) return;
      assertBase();
      const goal = goalFromDraft({ kind, amount }, entityId, ledger);
      if (
        await onSave(
          saveGoal(ledger, goal),
          'Savings goal saved. Progress uses the current wallet balance.',
        )
      )
        await finish();
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : 'Check the goal details.');
    } finally {
      writing.current = false;
      if (active.current) setSubmitting(false);
    }
  };
  const remove = async () => {
    if (!ledger.goal || !editable || writing.current || !current()) return;
    writing.current = true;
    setSubmitting(true);
    setError('');
    try {
      assertBase();
      if (!(await persistence.flush())) return;
      assertBase();
      if (
        await onSave(
          deleteGoal(ledger),
          'Savings goal removed. Your wallet and transactions are unchanged.',
        )
      )
        await finish();
    } catch (cause) {
      if (current())
        setError(cause instanceof Error ? cause.message : 'The goal could not be removed.');
    } finally {
      writing.current = false;
      if (active.current) setSubmitting(false);
    }
  };

  return (
    <Sheet
      title={ledger.goal ? 'Edit savings goal' : 'Set savings goal'}
      busy={busy}
      onClose={close}
    >
      {persistence.enabled ? (
        <View style={ui.smallGap}>
          <Text style={ui.hint} testID="goal-draft-status">
            {persistence.saving
              ? 'Saving draft on this device.'
              : persistence.saved
                ? 'Draft saved on this device. Close to finish it later.'
                : 'Unfinished edits will be saved on this device.'}
          </Text>
          <FormError message={persistence.error} testID="goal-draft-save-error" />
          {persistence.error && !completed ? (
            <View style={ui.smallGap}>
              <Action
                label="Retry saving draft"
                secondary
                disabled={busy}
                onPress={() => {
                  void persistence.flush();
                }}
                testID="goal-draft-save-retry"
              />
            </View>
          ) : null}
        </View>
      ) : null}
      <Field
        label={`Target amount (${ledger.wallet.currency})`}
        value={amount}
        testID="goal-amount-input"
        placeholder={ledger.wallet.currency === 'JPY' ? '0' : '0.00'}
        keyboardType="decimal-pad"
        maxLength={15}
        editable={editable}
        onChangeText={(value) => {
          if (!editable || writing.current || !current()) return;
          setAmount(value);
          setError('');
          clearSaveError();
        }}
      />
      <Text style={ui.fieldLabel}>What are you saving toward?</Text>
      <View style={[ui.row, { flexWrap: 'wrap', gap: 8 }]}>
        {GOAL_KINDS.map((item) => (
          <Choice
            key={item.value}
            label={item.label}
            selected={kind === item.value}
            disabled={!editable}
            testID={`goal-kind-${item.value}`}
            onPress={() => {
              if (!editable || writing.current || !current()) return;
              setKind(item.value);
              setError('');
              clearSaveError();
            }}
          />
        ))}
      </View>
      <Text style={[ui.body, ui.gap]}>
        Your wallet balance is compared with this target. Adding income raises progress; expenses
        and debt payments reduce it. Money is not transferred or set aside.
      </Text>
      {kind === 'creditDebt' ? (
        <Text style={[ui.body, ui.smallGap]}>
          For a debt goal, the target means money you want available toward repayment. It does not
          measure how much debt you have paid off.
        </Text>
      ) : null}
      <FormError message={error || saveError} testID="goal-error" />
      <View style={ui.gap}>
        <Action
          label={saving ? 'Saving…' : 'Save savings goal'}
          disabled={!editable}
          onPress={() => {
            void save();
          }}
          testID="save-goal"
        />
      </View>
      {ledger.goal ? (
        <View style={ui.gap}>
          {!confirmDelete ? (
            <Action
              label="Remove savings goal"
              secondary
              danger
              disabled={!editable}
              onPress={() => setConfirmDelete(true)}
              testID="delete-goal"
            />
          ) : (
            <>
              <Text style={ui.body}>
                Remove this goal? Your wallet balance and transactions will stay the same.
              </Text>
              <View style={ui.smallGap}>
                <Action
                  label="Yes, remove goal"
                  secondary
                  danger
                  disabled={!editable}
                  onPress={() => {
                    void remove();
                  }}
                  testID="confirm-delete-goal"
                />
              </View>
              <View style={ui.smallGap}>
                <Action
                  label="Keep goal"
                  secondary
                  disabled={!editable}
                  onPress={() => setConfirmDelete(false)}
                />
              </View>
            </>
          )}
        </View>
      ) : null}
    </Sheet>
  );
}
