import { Currency, GoalProgress } from './model';
import { PeriodReport } from './reports';

export type CashFlowInputs = { incomeMinor: number; expenseMinor: number; debtMinor: number };
export type CashFlowHealth = CashFlowInputs & {
  formulaVersion: 'fyp-cash-flow-v1';
  status: 'available' | 'insufficient-income';
  score: number | null;
  rawScore: number | null;
  outflowMinor: number;
  netMinor: number;
  cashFlowRatio: number | null;
  debtToIncomeRatio: number | null;
  cashFlowPenaltyPoints: number | null;
  debtPenaltyPoints: number | null;
};
export type SimulationBaseline = Readonly<
  Pick<
    PeriodReport,
    | 'startDate'
    | 'endDate'
    | 'currency'
    | 'openingMinor'
    | 'incomeMinor'
    | 'expenseMinor'
    | 'debtMinor'
    | 'outflowMinor'
    | 'netMinor'
    | 'closingMinor'
    | 'currentBalanceMinor'
  >
>;
export type SimulationResult = {
  inputs: CashFlowInputs;
  baselineHealth: CashFlowHealth;
  health: CashFlowHealth;
  deltaNetMinor: number;
  projectedClosingMinor: number;
  projectedCurrentBalanceMinor: number;
  goal: GoalProgress | null;
};

export const FORMULA_VERSION: 'fyp-cash-flow-v1';
export const MAX_SCENARIO_MINOR: number;
/** Illustrative project formula, not a validated assessment. Inputs are nonnegative minor units. */
export function cashFlowHealth(inputs: CashFlowInputs): CashFlowHealth;
/** Accepts exact zero and aggregate amounts; no fractional yen or monetary rounding. */
export function parseAggregateMoney(text: string, currency?: Currency): number;
/** Copies and freezes the used scalar fields after validating report reconciliation. */
export function createSimulationBaseline(report: PeriodReport): SimulationBaseline;
/** Replaces period activity while holding all outside-period records fixed; never persists. */
export function simulateReport(
  baseline: SimulationBaseline,
  inputs: CashFlowInputs,
  goalTargetMinor?: number | null,
): SimulationResult;
