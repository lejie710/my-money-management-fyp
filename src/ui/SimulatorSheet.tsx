import React, { useMemo, useState } from 'react';
import { Keyboard, StyleSheet, Text, View } from 'react-native';
import {
  CashFlowInputs,
  parseAggregateMoney,
  SimulationBaseline,
  simulateReport,
} from '../core/health';
import { amountInputValue, formatMoney, goalProgressForBalance } from '../core/model';
import { Action, Field, FormError, Sheet } from './components';
import { ProgressBar } from './PlanScreen';
import { displayDate } from './TransactionsScreen';
import { useThemedStyles, type ThemeColors } from './theme';

type ScenarioDraft = { income: string; expense: string; debt: string };
type Props = {
  baseline: SimulationBaseline;
  goalTargetMinor: number | null;
  goalName: string | null;
  onClose: () => void;
};

function Comparison({
  label,
  actual,
  scenario,
  testID,
}: {
  label: string;
  actual: string;
  scenario: string;
  testID: string;
}) {
  const { colors, ui, styles } = useThemedStyles(createStyles);
  return (
    <View style={styles.comparison}>
      <Text style={styles.comparisonLabel}>{label}</Text>
      <Text selectable style={styles.comparisonValue} testID={testID}>
        {scenario}
      </Text>
      <Text selectable style={ui.hint}>
        Recorded: {actual}
      </Text>
    </View>
  );
}

export function SimulatorSheet({ baseline, goalTargetMinor, goalName, onClose }: Props) {
  const { colors, ui, styles } = useThemedStyles(createStyles);
  const recordedInputs: CashFlowInputs = {
    incomeMinor: baseline.incomeMinor,
    expenseMinor: baseline.expenseMinor,
    debtMinor: baseline.debtMinor,
  };
  const toDraft = (inputs: CashFlowInputs): ScenarioDraft => ({
    income: amountInputValue(inputs.incomeMinor, baseline.currency),
    expense: amountInputValue(inputs.expenseMinor, baseline.currency),
    debt: amountInputValue(inputs.debtMinor, baseline.currency),
  });
  const [draft, setDraft] = useState<ScenarioDraft>(() => toDraft(recordedInputs));
  const [result, setResult] = useState(() =>
    simulateReport(baseline, recordedInputs, goalTargetMinor),
  );
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Showing the recorded amounts as the starting scenario.');
  const actualGoal = useMemo(
    () => goalProgressForBalance(baseline.currentBalanceMinor, goalTargetMinor),
    [baseline.currentBalanceMinor, goalTargetMinor],
  );
  const appliedDraft = toDraft(result.inputs);
  const changed =
    draft.income !== appliedDraft.income ||
    draft.expense !== appliedDraft.expense ||
    draft.debt !== appliedDraft.debt;
  const money = (value: number) => formatMoney(value, baseline.currency);
  const scoreText = (value: number | null) =>
    value === null ? 'Unavailable' : `${value.toFixed(2)} / 100`;

  const update = (field: keyof ScenarioDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setError('');
  };
  const apply = () => {
    try {
      const inputs = {
        incomeMinor: parseAggregateMoney(draft.income, baseline.currency),
        expenseMinor: parseAggregateMoney(draft.expense, baseline.currency),
        debtMinor: parseAggregateMoney(draft.debt, baseline.currency),
      };
      const next = simulateReport(baseline, inputs, goalTargetMinor);
      setResult(next);
      setDraft(toDraft(inputs));
      setError('');
      setStatus('Scenario applied. Your recorded data is unchanged.');
      Keyboard.dismiss();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Check the scenario amounts. The previous result is unchanged.',
      );
    }
  };
  const reset = () => {
    setDraft(toDraft(recordedInputs));
    setResult(simulateReport(baseline, recordedInputs, goalTargetMinor));
    setError('');
    setStatus('Reset to the recorded amounts. Your recorded data is unchanged.');
    Keyboard.dismiss();
  };

  return (
    <Sheet title="What-if scenario" onClose={onClose}>
      <Text selectable style={[ui.body, { marginTop: 16 }]} testID="simulator-period">
        {displayDate(baseline.startDate)} – {displayDate(baseline.endDate)}
      </Text>
      <Text style={[ui.hint, ui.smallGap]}>
        Replace this period's totals hypothetically while holding all other records fixed. This is
        not a forecast and does not save transactions.
      </Text>
      <Field
        label={`Income (${baseline.currency})`}
        testID="scenario-income-input"
        value={draft.income}
        onChangeText={(value) => update('income', value)}
        keyboardType="decimal-pad"
        maxLength={18}
      />
      <Field
        label={`Expenses (${baseline.currency})`}
        testID="scenario-expense-input"
        value={draft.expense}
        onChangeText={(value) => update('expense', value)}
        keyboardType="decimal-pad"
        maxLength={18}
      />
      <Field
        label={`Debt payments (${baseline.currency})`}
        testID="scenario-debt-input"
        value={draft.debt}
        onChangeText={(value) => update('debt', value)}
        keyboardType="decimal-pad"
        maxLength={18}
        hint={
          baseline.currency === 'JPY'
            ? 'Use zero or a positive whole-yen amount.'
            : 'Use zero or a positive amount with up to two decimal places.'
        }
      />
      <FormError message={error} testID="scenario-error" />
      <View style={ui.gap}>
        <Action label="Apply scenario" onPress={apply} testID="apply-scenario" />
      </View>
      <View style={ui.smallGap}>
        <Action
          label="Reset to recorded amounts"
          secondary
          onPress={reset}
          testID="reset-scenario"
        />
      </View>
      <Text
        style={[ui.hint, ui.smallGap]}
        accessibilityLiveRegion="polite"
        testID="scenario-status"
      >
        {changed ? 'Amounts have changed. Apply them to update the results below.' : status}
      </Text>

      <View style={ui.divider}>
        <Text style={ui.heading} accessibilityRole="header">
          Applied what-if result
        </Text>
        <Comparison
          label="Illustrative FYP score"
          actual={scoreText(result.baselineHealth.score)}
          scenario={scoreText(result.health.score)}
          testID="scenario-score"
        />
        {result.health.score === null ? (
          <Text style={[ui.body, ui.smallGap]}>
            This scenario has zero income, so no score is calculated.
          </Text>
        ) : (
          <Text style={[ui.hint, ui.smallGap]}>
            Net-ratio deduction: {result.health.cashFlowPenaltyPoints!.toFixed(2)} points.
            Debt-ratio deduction: {result.health.debtPenaltyPoints!.toFixed(2)} points. Same{' '}
            {result.health.formulaVersion} rules as the report.
          </Text>
        )}
        <Comparison
          label="What-if net change"
          actual={money(baseline.netMinor)}
          scenario={money(result.health.netMinor)}
          testID="scenario-net"
        />
        <Comparison
          label="What-if period closing"
          actual={money(baseline.closingMinor)}
          scenario={money(result.projectedClosingMinor)}
          testID="scenario-closing"
        />
        <Text style={[ui.hint, ui.smallGap]}>
          Opening balance {money(baseline.openingMinor)} + what-if net change.
        </Text>
        <Comparison
          label="What-if all-record wallet balance"
          actual={money(baseline.currentBalanceMinor)}
          scenario={money(result.projectedCurrentBalanceMinor)}
          testID="scenario-wallet-balance"
        />
        <Text style={[ui.hint, ui.smallGap]}>
          The recorded all-date wallet balance changes by {money(result.deltaNetMinor)}, the
          difference between this scenario's net and the original period net.
        </Text>
      </View>

      {result.goal && actualGoal ? (
        <View style={ui.divider} testID="scenario-goal">
          <Text style={ui.heading} accessibilityRole="header">
            What-if savings goal
          </Text>
          {goalName ? <Text style={[ui.body, ui.smallGap]}>{goalName}</Text> : null}
          <Text selectable style={[ui.body, ui.smallGap]}>
            Target: {money(result.goal.targetMinor)}
          </Text>
          <ProgressBar
            value={result.goal.progress}
            label="What-if goal progress from all-record wallet balance"
          />
          <Text selectable style={styles.comparisonValue} testID="scenario-goal-progress">
            {result.goal.percent.toFixed(2)}% of target
          </Text>
          <Text selectable style={ui.hint}>
            Recorded: {actualGoal.percent.toFixed(2)}% of target
          </Text>
          <Text selectable style={[ui.body, ui.smallGap]} testID="scenario-goal-remaining">
            {result.goal.remainingMinor > 0
              ? `${money(result.goal.remainingMinor)} more needed to reach the target.`
              : result.goal.excessMinor > 0
                ? `Target reached, with ${money(result.goal.excessMinor)} above target.`
                : 'The what-if wallet balance reaches the target.'}
          </Text>
          {result.goal.balanceMinor < 0 ? (
            <Text style={[ui.hint, ui.smallGap]}>
              The what-if balance is below zero. Progress shows 0%; the remaining amount includes
              the full shortfall.
            </Text>
          ) : null}
          <Text style={[ui.hint, ui.smallGap]}>
            Uses the what-if all-record wallet balance, not the selected period's closing balance.
            Money is not moved or reserved.
          </Text>
        </View>
      ) : null}
      <Text style={[ui.hint, ui.divider]}>
        These aggregate inputs do not assign categories, recalculate individual budgets, or measure
        debt repaid. Closing this sheet discards the scenario; your wallet, transactions, and goal
        stay unchanged.
      </Text>
    </Sheet>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  comparison: { marginTop: 20 },
  comparisonLabel: { color: colors.text, fontSize: 15, lineHeight: 22, fontWeight: '600' },
  comparisonValue: {
    color: colors.purple,
    fontSize: 22,
    lineHeight: 31,
    fontWeight: '600',
    marginTop: 5,
    marginBottom: 4,
    fontVariant: ['tabular-nums'],
  },
});
