import React, { useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import {
  Budget,
  budgetProgress,
  formatMoney,
  GOAL_KINDS,
  goalProgress,
  Ledger,
} from '../core/model';
import { Action, Screen } from './components';
import { BudgetEditor } from './BudgetEditor';
import { GoalEditor } from './GoalEditor';
import { displayDate } from './TransactionsScreen';
import { useThemedStyles, type ThemeColors } from './theme';
import { SaveLedger } from './useLedger';
import { encodeDataFamily } from '../accounts/identity';
import {
  createFinancialFormDraftStore,
  type FinancialFormDraftContext,
} from '../drafts/formDrafts';

export type PlanProps = {
  ledger: Ledger;
  saving: boolean;
  saveError: string;
  onSave: SaveLedger;
  clearSaveError: () => void;
  draftContext?: FinancialFormDraftContext;
};

export function ProgressBar({
  value,
  label,
  over = false,
}: {
  value: number;
  label: string;
  over?: boolean;
}) {
  const { colors, ui, styles } = useThemedStyles(createStyles);
  return (
    <View
      style={styles.track}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{
        min: 0,
        max: 100,
        now: Math.round(Math.max(0, Math.min(1, value)) * 100),
      }}
    >
      <View
        style={[
          styles.fill,
          {
            width: `${Math.max(0, Math.min(1, value)) * 100}%`,
            backgroundColor: over ? colors.red : colors.green,
          },
        ]}
      />
    </View>
  );
}

export function PlanScreen({
  ledger,
  saving,
  saveError,
  onSave,
  clearSaveError,
  draftContext,
}: PlanProps) {
  const { colors, ui, styles } = useThemedStyles(createStyles);
  const ownerKey = draftContext
    ? encodeDataFamily(draftContext.family) + '/' + draftContext.incarnationId
    : ledger.wallet.incarnationId;
  type BudgetSession = { ownerKey: string; token: object; budget?: Budget };
  type GoalSession = { ownerKey: string; token: object; targetId: string | null };
  const [storedBudget, setBudgetEditor] = useState<BudgetSession | null>(null);
  const [storedGoal, setGoalEditor] = useState<GoalSession | null>(null);
  const budgetEditor = storedBudget?.ownerKey === ownerKey ? storedBudget : null;
  const goalEditor = storedGoal?.ownerKey === ownerKey ? storedGoal : null;
  const live = useRef({
    ownerKey,
    budgetEditor,
    goalEditor,
    draftContext,
    incarnationId: ledger.wallet.incarnationId,
  });
  live.current = {
    ownerKey,
    budgetEditor,
    goalEditor,
    draftContext,
    incarnationId: ledger.wallet.incarnationId,
  };
  const currentOwner = () =>
    live.current.ownerKey === ownerKey &&
    (!live.current.draftContext ||
      live.current.draftContext.incarnationId === live.current.incarnationId) &&
    (live.current.draftContext?.isCurrent?.() ?? true);
  const openBudget = (budget?: Budget) => {
    if (!currentOwner() || saving) return;
    const session = { ownerKey, token: {}, budget };
    live.current.budgetEditor = session;
    setBudgetEditor(session);
  };
  const openGoal = () => {
    if (!currentOwner() || saving) return;
    const session = { ownerKey, token: {}, targetId: ledger.goal?.id ?? null };
    live.current.goalEditor = session;
    setGoalEditor(session);
  };
  const budgetCurrent = () =>
    currentOwner() && !!budgetEditor && live.current.budgetEditor === budgetEditor;
  const goalCurrent = () =>
    currentOwner() && !!goalEditor && live.current.goalEditor === goalEditor;
  const budgetStore = useMemo(
    () =>
      draftContext && budgetEditor
        ? createFinancialFormDraftStore(draftContext.deviceStorage, {
            family: draftContext.family,
            incarnationId: draftContext.incarnationId,
            kind: 'budget',
            targetId: budgetEditor.budget?.id ?? null,
          })
        : undefined,
    [draftContext?.deviceStorage, ownerKey, budgetEditor],
  );
  const goalStore = useMemo(
    () =>
      draftContext && goalEditor
        ? createFinancialFormDraftStore(draftContext.deviceStorage, {
            family: draftContext.family,
            incarnationId: draftContext.incarnationId,
            kind: 'goal',
            targetId: goalEditor.targetId,
          })
        : undefined,
    [draftContext?.deviceStorage, ownerKey, goalEditor],
  );
  const { width, fontScale } = useWindowDimensions();
  const stackAmounts = width < 350 || fontScale > 1.2;
  const goal = goalProgress(ledger);
  const money = (amount: number) => formatMoney(amount, ledger.wallet.currency);
  const budgets = [...ledger.budgets].sort(
    (a, b) => b.startDate.localeCompare(a.startDate) || a.id.localeCompare(b.id),
  );

  return (
    <>
      <Screen>
        <Text style={ui.title} accessibilityRole="header">
          Plan
        </Text>
        <Text style={[ui.body, ui.smallGap]}>
          Give your spending a limit and your savings a purpose.
        </Text>
        <View style={[styles.sectionHeader, ui.gap]}>
          <View style={styles.sectionTitle}>
            <Text style={ui.heading} accessibilityRole="header">
              Category budgets
            </Text>
            <Text style={[ui.hint, { marginTop: 4 }]}>
              A separate limit for each category and period.
            </Text>
          </View>
          <View style={styles.headerAction}>
            <Action
              label="+ Add budget"
              disabled={saving}
              testID="add-budget"
              onPress={() => {
                clearSaveError();
                openBudget();
              }}
            />
          </View>
        </View>
        {budgets.length === 0 ? (
          <View style={[ui.card, ui.gap]} testID="budgets-empty">
            <Text style={ui.heading}>Give your spending a limit</Text>
            <Text style={[ui.body, ui.smallGap]}>
              Choose an expense category, an amount, and a week, month, or year. Existing expenses
              in that range count automatically.
            </Text>
          </View>
        ) : (
          budgets.map((budget) => {
            const progress = budgetProgress(ledger, budget);
            const category = ledger.categories.find((item) => item.id === budget.categoryId)!;
            const over = progress.overMinor > 0;
            return (
              <View style={[ui.card, ui.gap]} key={budget.id} testID={`budget-${budget.id}`}>
                <Text style={ui.heading}>{category.name}</Text>
                <Text style={[styles.periodBadge, { marginTop: 8 }]}>
                  {budget.period === 'week'
                    ? 'Weekly • Monday–Sunday'
                    : budget.period === 'month'
                      ? 'Monthly'
                      : 'Yearly'}
                </Text>
                <Text
                  selectable
                  style={[ui.body, { marginTop: 5 }]}
                  testID={`budget-dates-${budget.id}`}
                >
                  {displayDate(budget.startDate)} – {displayDate(budget.endDate)}
                </Text>
                <View style={[styles.metrics, ui.gap]}>
                  <View style={[styles.metric, stackAmounts && styles.stackedMetric]}>
                    <Text style={ui.hint}>Spent</Text>
                    <Text selectable style={styles.amount} testID={`budget-spent-${budget.id}`}>
                      {money(progress.spentMinor)}
                    </Text>
                  </View>
                  <View style={[styles.metric, stackAmounts && styles.stackedMetric]}>
                    <Text style={ui.hint}>Budget</Text>
                    <Text selectable style={styles.amount}>
                      {money(budget.plannedMinor)}
                    </Text>
                  </View>
                </View>
                <ProgressBar
                  value={progress.progress}
                  over={over}
                  label={`${category.name} budget used`}
                />
                <Text
                  selectable
                  style={[styles.remainder, over && { color: colors.red }]}
                  testID={`budget-remaining-${budget.id}`}
                >
                  {over
                    ? `${money(progress.overMinor)} over budget`
                    : progress.remainingMinor === 0
                      ? 'Budget fully used'
                      : `${money(progress.remainingMinor)} remaining`}
                </Text>
                <Text style={[ui.hint, { marginTop: 5 }]}>
                  {progress.transactionCount} expense{' '}
                  {progress.transactionCount === 1 ? 'entry' : 'entries'} in this period.
                </Text>
                <View style={ui.smallGap}>
                  <Action
                    label="Edit budget"
                    secondary
                    disabled={saving}
                    testID={`edit-budget-${budget.id}`}
                    onPress={() => {
                      clearSaveError();
                      openBudget(budget);
                    }}
                  />
                </View>
              </View>
            );
          })
        )}
        <View style={[ui.divider, { marginTop: 30 }]}>
          <Text style={ui.heading} accessibilityRole="header">
            Savings goal
          </Text>
          <Text style={[ui.hint, ui.smallGap]}>
            Based on your wallet balance. Money is not moved or reserved.
          </Text>
        </View>
        {!ledger.goal || !goal ? (
          <View style={[ui.card, ui.gap]} testID="goal-empty">
            <Text style={ui.heading}>Choose something to save toward</Text>
            <Text style={[ui.body, ui.smallGap]}>
              Set one target and compare it with your wallet's current balance. You can keep
              tracking money without a goal.
            </Text>
            <View style={ui.gap}>
              <Action
                label="Set savings goal"
                disabled={saving}
                testID="add-goal"
                onPress={() => {
                  clearSaveError();
                  openGoal();
                }}
              />
            </View>
          </View>
        ) : (
          <View style={[ui.card, ui.gap]} testID="savings-goal">
            <Text style={ui.heading}>
              {GOAL_KINDS.find((item) => item.value === ledger.goal!.kind)?.label}
            </Text>
            <View style={[styles.metrics, ui.gap]}>
              <View style={[styles.metric, stackAmounts && styles.stackedMetric]}>
                <Text style={ui.hint}>Wallet balance</Text>
                <Text selectable style={styles.amount} testID="goal-balance">
                  {money(goal.balanceMinor)}
                </Text>
              </View>
              <View style={[styles.metric, stackAmounts && styles.stackedMetric]}>
                <Text style={ui.hint}>Target</Text>
                <Text selectable style={styles.amount} testID="goal-target">
                  {money(goal.targetMinor)}
                </Text>
              </View>
            </View>
            <ProgressBar value={goal.progress} label="Savings goal progress from wallet balance" />
            <Text selectable style={styles.remainder} testID="goal-progress">
              {goal.percent.toFixed(1)}% of target
            </Text>
            <Text selectable style={[ui.body, ui.smallGap]} testID="goal-remaining">
              {goal.excessMinor > 0
                ? `Target reached, with ${money(goal.excessMinor)} above target.`
                : goal.remainingMinor === 0
                  ? 'Your wallet balance has reached the target.'
                  : `${money(goal.remainingMinor)} more needed to reach the target.`}
            </Text>
            {goal.balanceMinor < 0 ? (
              <Text style={[ui.hint, ui.smallGap]}>
                Your balance is below zero. Progress stays at 0% until it becomes positive; the
                remaining amount includes this shortfall.
              </Text>
            ) : null}
            {ledger.goal.kind === 'creditDebt' ? (
              <Text style={[ui.hint, ui.smallGap]}>
                This is a savings target toward debt repayment. It does not track your outstanding
                debt or show how much debt has been repaid.
              </Text>
            ) : null}
            <View style={ui.gap}>
              <Action
                label="Edit savings goal"
                secondary
                disabled={saving}
                testID="edit-goal"
                onPress={() => {
                  clearSaveError();
                  openGoal();
                }}
              />
            </View>
          </View>
        )}
      </Screen>
      {budgetEditor ? (
        <BudgetEditor
          {...{ ledger, saving, saveError, onSave, clearSaveError }}
          budget={budgetEditor.budget}
          draftStore={budgetStore}
          isCurrent={budgetCurrent}
          onClose={() => {
            if (budgetCurrent()) {
              live.current.budgetEditor = null;
              setBudgetEditor(null);
            }
          }}
        />
      ) : null}
      {goalEditor ? (
        <GoalEditor
          {...{ ledger, saving, saveError, onSave, clearSaveError }}
          draftStore={goalStore}
          isCurrent={goalCurrent}
          onClose={() => {
            if (goalCurrent()) {
              live.current.goalEditor = null;
              setGoalEditor(null);
            }
          }}
        />
      ) : null}
    </>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    metrics: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 16 },
    metric: { flexGrow: 1, flexShrink: 1, flexBasis: '44%' },
    stackedMetric: { flexBasis: '100%' },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
    sectionTitle: { flexGrow: 1, flexShrink: 1, flexBasis: 160 },
    headerAction: { minWidth: 128 },
    periodBadge: {
      color: colors.accent,
      backgroundColor: colors.accentSoft,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 8,
      alignSelf: 'flex-start',
      fontSize: 13,
      lineHeight: 19,
      fontWeight: '500',
    },
    amount: {
      color: colors.text,
      fontSize: 22,
      lineHeight: 30,
      fontWeight: '600',
      marginTop: 4,
      fontVariant: ['tabular-nums'],
    },
    remainder: {
      color: colors.green,
      fontSize: 16,
      lineHeight: 24,
      fontWeight: '600',
      fontVariant: ['tabular-nums'],
    },
    track: {
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.raised,
      overflow: 'hidden',
      marginVertical: 14,
    },
    fill: { height: '100%', borderRadius: 3 },
  });
