import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { cashFlowHealth, createSimulationBaseline, SimulationBaseline } from '../core/health';
import { Goal, GOAL_KINDS } from '../core/model';
import { PeriodReport } from '../core/reports';
import { Action } from './components';
import { SimulatorSheet } from './SimulatorSheet';
import { colors, ui } from './theme';

type ScenarioSnapshot = {
  baseline: SimulationBaseline;
  goalTargetMinor: number | null;
  goalName: string | null;
};

export function HealthPanel({ report, goal }: { report: PeriodReport; goal: Goal | null }) {
  const [showFormula, setShowFormula] = useState(false);
  const [snapshot, setSnapshot] = useState<ScenarioSnapshot | null>(null);
  const health = useMemo(
    () =>
      cashFlowHealth({
        incomeMinor: report.incomeMinor,
        expenseMinor: report.expenseMinor,
        debtMinor: report.debtMinor,
      }),
    [report.incomeMinor, report.expenseMinor, report.debtMinor],
  );

  return (
    <>
      <View style={[ui.card, { marginTop: 28 }]}>
        <Text style={ui.heading} accessibilityRole="header">
          FYP cash-flow score
        </Text>
        <Text style={[ui.hint, ui.smallGap]}>
          An illustrative calculation from this period's recorded income, expenses, and debt
          payments. It is not a validated financial-health assessment.
        </Text>
        {health.score === null ? (
          <>
            <Text selectable style={styles.unavailable} testID="health-score-unavailable">
              Unavailable
            </Text>
            <Text style={ui.body}>
              A score needs positive recorded income. Zero income does not produce a default score.
            </Text>
          </>
        ) : (
          <Text selectable style={styles.score} testID="health-score">
            {health.score.toFixed(2)} <Text style={styles.scoreScale}>/ 100</Text>
          </Text>
        )}
        <View style={ui.gap}>
          <Action
            label={showFormula ? 'Hide calculation' : 'Show calculation'}
            secondary
            onPress={() => setShowFormula((current) => !current)}
            testID="health-show-formula"
          />
        </View>
        {showFormula ? (
          <View style={ui.gap} testID="health-formula">
            <Text style={ui.body}>
              Start at 100 points. Subtract the two deductions below, then keep the score between 0
              and 100.
            </Text>
            <Text style={[styles.formulaLabel, ui.gap]}>1. Net-ratio deduction</Text>
            <Text style={[ui.body, ui.smallGap]}>
              Net = income − expenses − debt payments. If net ÷ income is below 25%, subtract the
              shortfall in percentage points.
            </Text>
            <Text selectable style={[ui.body, ui.smallGap]} testID="health-net-penalty">
              {health.cashFlowPenaltyPoints === null
                ? 'Unavailable without positive income.'
                : `${health.cashFlowPenaltyPoints.toFixed(2)} points deducted.`}
            </Text>
            <Text style={[styles.formulaLabel, ui.gap]}>2. Debt-ratio deduction</Text>
            <Text style={[ui.body, ui.smallGap]}>
              If debt payments ÷ income exceeds 30%, subtract the excess in percentage points.
            </Text>
            <Text selectable style={[ui.body, ui.smallGap]} testID="health-debt-penalty">
              {health.debtPenaltyPoints === null
                ? 'Unavailable without positive income.'
                : `${health.debtPenaltyPoints.toFixed(2)} points deducted.`}
            </Text>
            <Text style={[ui.hint, ui.gap]}>
              The 25% and 30% thresholds are inherited project assumptions, not financial
              recommendations. Debt affects net and the separate score deduction; it is subtracted
              only once from the money balance. Budgets and goals do not affect this score.
            </Text>
            <Text selectable style={[ui.hint, ui.smallGap]}>
              Formula: {health.formulaVersion}
            </Text>
          </View>
        ) : null}
        <View style={ui.gap}>
          <Action
            label="Try a what-if scenario"
            testID="open-simulator"
            onPress={() =>
              setSnapshot({
                baseline: createSimulationBaseline(report),
                goalTargetMinor: goal?.targetMinor ?? null,
                goalName: goal
                  ? (GOAL_KINDS.find((item) => item.value === goal.kind)?.label ?? null)
                  : null,
              })
            }
          />
        </View>
      </View>
      {snapshot ? (
        <SimulatorSheet
          baseline={snapshot.baseline}
          goalTargetMinor={snapshot.goalTargetMinor}
          goalName={snapshot.goalName}
          onClose={() => setSnapshot(null)}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  score: {
    color: colors.purple,
    fontSize: 36,
    lineHeight: 46,
    fontWeight: '700',
    letterSpacing: -0.8,
    marginTop: 18,
    fontVariant: ['tabular-nums'],
  },
  scoreScale: { color: colors.muted, fontSize: 18, fontWeight: '400' },
  unavailable: {
    color: colors.muted,
    fontSize: 24,
    lineHeight: 32,
    fontWeight: '600',
    marginTop: 18,
    marginBottom: 8,
  },
  formulaLabel: { color: colors.text, fontSize: 15, lineHeight: 22, fontWeight: '600' },
});
