import React, { useEffect, useRef, useState } from 'react';
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
import { useTheme } from './theme';
import { FinancialFormDraftGate } from '../drafts/FinancialFormDraftGate';
import { useFormDraft } from '../drafts/useFormDraft';
import { ledgerFingerprint } from '../drafts/transactionDrafts';
import type { FinancialFormDraftStore, FormDraftSnapshot } from '../drafts/formDrafts';

const periods: { value: BudgetPeriod; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];

type EditorProps = PlanProps & { budget?: Budget; onClose: () => void } & {
  draftStore?: FinancialFormDraftStore;
  isCurrent?: () => boolean;
};
export function BudgetEditor(props: EditorProps) {
  return (
    <FinancialFormDraftGate
      key={props.draftStore?.key ?? props.ledger.wallet.incarnationId}
      kind="budget"
      store={props.draftStore}
      ledger={props.ledger}
      isCurrent={props.isCurrent}
      onClose={props.onClose}
    >
      {(initialDraft) => <BudgetEditorForm {...props} initialDraft={initialDraft} />}
    </FinancialFormDraftGate>
  );
}
function BudgetEditorForm({
  ledger,
  saving,
  saveError,
  onSave,
  clearSaveError,
  budget,
  onClose,
  draftStore,
  isCurrent,
  initialDraft,
}: EditorProps & { initialDraft: FormDraftSnapshot }) {
  const { colors, ui } = useTheme();
  const categories = ledger.categories.filter((item) => item.type === 'expense');
  const [draft, setDraft] = useState<BudgetDraft>(() =>
    initialDraft.record?.kind === 'budget'
      ? initialDraft.record.fields
      : budget
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
  const [entityId] = useState(() => initialDraft.record?.entityId ?? budget?.id ?? newId('budget'));
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
    value: { kind: 'budget', entityId, baseFingerprint, fields: draft },
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
        'The wallet changed while this budget was open. Your draft is retained; reopen and review current records.',
      );
  };
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
    if (!editable || writing.current || !current()) return;
    setDraft((current) => ({ ...current, [key]: value }));
    setError('');
    clearSaveError();
  };
  const finish = async () => {
    const cleared = await persistence.complete();
    if (!current()) return;
    if (cleared) onClose();
    else {
      setCompleted(true);
      setError(
        'The budget change was saved. Its older draft could not be cleared; close this form and review the retained draft before editing again.',
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
      const nextBudget = budgetFromDraft(draft, entityId, ledger);
      if (
        await onSave(
          saveBudget(ledger, nextBudget, !!budget),
          `${budget ? 'Updated' : 'Added'} budget. Spending is calculated from entries in its date range.`,
        )
      )
        await finish();
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : 'Check the budget details.');
    } finally {
      writing.current = false;
      if (active.current) setSubmitting(false);
    }
  };
  const remove = async () => {
    if (!budget || !editable || writing.current || !current()) return;
    writing.current = true;
    setSubmitting(true);
    setError('');
    try {
      assertBase();
      if (!(await persistence.flush())) return;
      assertBase();
      if (
        await onSave(deleteBudget(ledger, budget.id), 'Budget deleted. Transactions are unchanged.')
      )
        await finish();
    } catch (cause) {
      if (current())
        setError(cause instanceof Error ? cause.message : 'The budget could not be deleted.');
    } finally {
      writing.current = false;
      if (active.current) setSubmitting(false);
    }
  };

  return (
    <Sheet title={budget ? 'Edit budget' : 'New budget'} busy={busy} onClose={close}>
      {persistence.enabled ? (
        <View style={ui.smallGap}>
          <Text style={ui.hint} testID="budget-draft-status">
            {persistence.saving
              ? 'Saving draft on this device.'
              : persistence.saved
                ? 'Draft saved on this device. Close to finish it later.'
                : 'Unfinished edits will be saved on this device.'}
          </Text>
          <FormError message={persistence.error} testID="budget-draft-save-error" />
          {persistence.error && !completed ? (
            <View style={ui.smallGap}>
              <Action
                label="Retry saving draft"
                secondary
                disabled={busy}
                onPress={() => {
                  void persistence.flush();
                }}
                testID="budget-draft-save-retry"
              />
            </View>
          ) : null}
        </View>
      ) : null}
      <Field
        label={`Budget amount (${ledger.wallet.currency})`}
        value={draft.amount}
        testID="budget-amount-input"
        placeholder={ledger.wallet.currency === 'JPY' ? '0' : '0.00'}
        keyboardType="decimal-pad"
        maxLength={15}
        editable={editable}
        onChangeText={(value) => update('amount', value)}
      />
      <Text style={ui.fieldLabel}>Calendar period</Text>
      <View style={[ui.row, { flexWrap: 'wrap' }]}>
        {periods.map((item) => (
          <Choice
            key={item.value}
            label={item.label}
            selected={draft.period === item.value}
            disabled={!editable}
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
        editable={editable}
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
              disabled={!editable}
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
          disabled={!editable || !categories.length}
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
              disabled={!editable}
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
                  disabled={!editable}
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
