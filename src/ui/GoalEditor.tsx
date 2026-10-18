import React, { useState } from 'react';
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
import { ui } from './theme';

export function GoalEditor({
  ledger,
  saving,
  saveError,
  onSave,
  clearSaveError,
  onClose,
}: PlanProps & { onClose: () => void }) {
  const [kind, setKind] = useState<GoalKind>(ledger.goal?.kind ?? 'emergencyFund');
  const [amount, setAmount] = useState(
    ledger.goal ? amountInputValue(ledger.goal.targetMinor, ledger.wallet.currency) : '',
  );
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    if (saving) return;
    try {
      const goal = goalFromDraft({ kind, amount }, ledger.goal?.id ?? newId('goal'), ledger);
      if (
        await onSave(
          saveGoal(ledger, goal),
          'Savings goal saved. Progress uses the current wallet balance.',
        )
      )
        onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the goal details.');
    }
  };
  const remove = async () => {
    if (!ledger.goal || saving) return;
    try {
      if (
        await onSave(
          deleteGoal(ledger),
          'Savings goal removed. Your wallet and transactions are unchanged.',
        )
      )
        onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The goal could not be removed.');
    }
  };

  return (
    <Sheet
      title={ledger.goal ? 'Edit savings goal' : 'Set savings goal'}
      busy={saving}
      onClose={onClose}
    >
      <Field
        label={`Target amount (${ledger.wallet.currency})`}
        value={amount}
        testID="goal-amount-input"
        placeholder={ledger.wallet.currency === 'JPY' ? '0' : '0.00'}
        keyboardType="decimal-pad"
        maxLength={15}
        editable={!saving}
        onChangeText={(value) => {
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
            disabled={saving}
            testID={`goal-kind-${item.value}`}
            onPress={() => {
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
          disabled={saving}
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
              disabled={saving}
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
                  disabled={saving}
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
                  disabled={saving}
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
