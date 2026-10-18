import React, { useState } from 'react';
import { Text, View } from 'react-native';
import {
  amountInputValue,
  Budget,
  BudgetDraft,
  BudgetPeriod,
  budgetFromDraft,
  deleteBudget,
  localDate,
  periodBounds,
  saveBudget,
} from '../core/model';
import { Action, Choice, Field, FormError, Sheet } from './components';
import type { PlanProps } from './PlanScreen';
import { newId } from './TransactionEditor';
import { displayDate } from './TransactionsScreen';
import { ui } from './theme';

const periods: { value: BudgetPeriod; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];

export function BudgetEditor({
  ledger,
  saving,
  saveError,
  onSave,
  clearSaveError,
  budget,
  onClose,
}: PlanProps & { budget?: Budget; onClose: () => void }) {
  const categories = ledger.categories.filter((item) => item.type === 'expense');
  const [draft, setDraft] = useState<BudgetDraft>(() =>
    budget
      ? {
          categoryId: budget.categoryId,
          amount: amountInputValue(budget.plannedMinor, ledger.wallet.currency),
          period: budget.period,
          anchorDate: budget.startDate,
        }
      : {
          categoryId: categories[0]?.id ?? '',
          amount: '',
          period: 'month',
          anchorDate: localDate(),
        },
  );
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  let range = '';
  try {
    const bounds = periodBounds(draft.period, draft.anchorDate);
    range = `${displayDate(bounds.startDate)} – ${displayDate(bounds.endDate)}`;
  } catch {
    /* A partial date remains editable and is validated on Save. */
  }

  const update = (key: keyof BudgetDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setError('');
    clearSaveError();
  };
  const save = async () => {
    if (saving) return;
    try {
      const nextBudget = budgetFromDraft(draft, budget?.id ?? newId('budget'), ledger);
      const next = saveBudget(ledger, nextBudget, !!budget);
      if (
        await onSave(
          next,
          `${budget ? 'Updated' : 'Added'} budget. Spending is calculated from entries in its date range.`,
        )
      )
        onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the budget details.');
    }
  };
  const remove = async () => {
    if (!budget || saving) return;
    try {
      if (
        await onSave(deleteBudget(ledger, budget.id), 'Budget deleted. Transactions are unchanged.')
      )
        onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The budget could not be deleted.');
    }
  };

  return (
    <Sheet title={budget ? 'Edit budget' : 'New budget'} busy={saving} onClose={onClose}>
      <Field
        label={`Budget amount (${ledger.wallet.currency})`}
        value={draft.amount}
        testID="budget-amount-input"
        placeholder={ledger.wallet.currency === 'JPY' ? '0' : '0.00'}
        keyboardType="decimal-pad"
        maxLength={15}
        editable={!saving}
        onChangeText={(value) => update('amount', value)}
      />
      <Text style={ui.fieldLabel}>Calendar period</Text>
      <View style={[ui.row, { flexWrap: 'wrap' }]}>
        {periods.map((item) => (
          <Choice
            key={item.value}
            label={item.label}
            selected={draft.period === item.value}
            disabled={saving}
            testID={`budget-period-${item.value}`}
            onPress={() => update('period', item.value)}
          />
        ))}
      </View>
      <Field
        label="Date within the period (YYYY-MM-DD)"
        value={draft.anchorDate}
        testID="budget-date-input"
        placeholder={localDate()}
        maxLength={10}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!saving}
        onChangeText={(value) => update('anchorDate', value)}
        hint={
          draft.period === 'week'
            ? 'A week runs Monday through Sunday, including both dates.'
            : draft.period === 'month'
              ? 'A month runs from its first through its last calendar day.'
              : 'A year runs from 1 January through 31 December.'
        }
      />
      {range ? (
        <Text selectable style={[ui.body, ui.smallGap]} testID="budget-date-range">
          Budget covers {range}.
        </Text>
      ) : null}
      <Text style={ui.fieldLabel}>Expense category</Text>
      {categories.length ? (
        <View style={[ui.row, { flexWrap: 'wrap', gap: 8 }]}>
          {categories.map((category) => (
            <Choice
              key={category.id}
              label={category.name}
              selected={draft.categoryId === category.id}
              disabled={saving}
              testID={`budget-category-${category.id}`}
              onPress={() => update('categoryId', category.id)}
            />
          ))}
        </View>
      ) : (
        <Text style={ui.body}>
          Add an expense category in Wallet → Categories before creating a budget.
        </Text>
      )}
      <Text style={[ui.hint, ui.smallGap]}>
        Only expenses in this category and date range count. Debt payments are separate. Weekly,
        monthly, and yearly budgets may overlap; each counts its own matching expenses. Only one
        budget is allowed per category and exact period.
      </Text>
      <FormError message={error || saveError} testID="budget-error" />
      <View style={ui.gap}>
        <Action
          label={saving ? 'Saving…' : budget ? 'Save budget' : 'Create budget'}
          disabled={saving || !categories.length}
          onPress={() => {
            void save();
          }}
          testID="save-budget"
        />
      </View>
      {budget ? (
        <View style={ui.gap}>
          {!confirmDelete ? (
            <Action
              label="Delete budget"
              secondary
              danger
              disabled={saving}
              onPress={() => setConfirmDelete(true)}
              testID="delete-budget"
            />
          ) : (
            <>
              <Text style={ui.body}>
                Delete this budget? Its transactions will stay in your wallet.
              </Text>
              <View style={ui.smallGap}>
                <Action
                  label="Yes, delete budget"
                  secondary
                  danger
                  disabled={saving}
                  onPress={() => {
                    void remove();
                  }}
                  testID="confirm-delete-budget"
                />
              </View>
              <View style={ui.smallGap}>
                <Action
                  label="Keep budget"
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
