import { Ledger, Currency } from "./model";
export type ForecastMethod = "last-value" | "mean-three" | "damped-trend";
export type ExpenseMonth = {
  month: string;
  expenseMinor: number;
  transactionCount: number;
};
export type ForecastRow = {
  month: string;
  lead: number;
  predictedMinor: number;
  capMinor: number;
};
export type ForecastFold = {
  trainingMonths: number;
  trainingThroughMonth: string;
  excludedGapMonth: string;
  targetMonth: string;
  lead: 2;
  actualMinor: number;
  predictedMinor: number;
  capMinor: number;
  absoluteErrorMinor: number;
};
export type ForecastCandidate = {
  method: ForecastMethod;
  label: string;
  foldCount: number;
  totalAbsoluteErrorMinor: number;
  maeMinor: number;
  folds: ForecastFold[];
};
export type ExpenseBacktest = {
  metricLabel: "Two-month-ahead MAE";
  lead: 2;
  foldCount: number;
  firstTargetMonth: string;
  lastTargetMonth: string;
  selectedMethod: ForecastMethod;
  baselineMaeMinor: number;
  selectedMaeMinor: number;
  relativeImprovementPercent: number | null;
  candidates: ForecastCandidate[];
};
export type ExpenseForecast = {
  configurationVersion: "recorded-expense-baselines-v1";
  target: "recorded-expenses";
  currency: Currency;
  filter: {
    kind: "all" | "category";
    categoryId: string | null;
    categoryName: string | null;
  };
  asOfDate: string;
  trainingCutoff: string | null;
  horizon: number;
  history: ExpenseMonth[];
  partialMonth: {
    month: string;
    startDate: string;
    throughDate: string;
    expenseMinor: number;
    transactionCount: number;
    excludedFromTraining: true;
  };
  lastRecordedExpenseMonth: string | null;
  lastTrainingExpenseMonth: string | null;
  eligibility: {
    completedMonths: number;
    activeMonths: number;
    minimumCompletedMonths: 8;
    minimumActiveMonths: 3;
  };
  status: "available" | "insufficient-history";
  reason:
    | "no-completed-expenses"
    | "too-few-completed-months"
    | "too-few-active-months"
    | null;
  message: string;
  selectedMethod: ForecastMethod | null;
  backtest: ExpenseBacktest | null;
  forecast: ForecastRow[];
};
export const FORECAST_VERSION: "recorded-expense-baselines-v1";
export const MIN_COMPLETE_MONTHS: 8;
export const MIN_ACTIVE_MONTHS: 3;
export const MAX_HORIZON: 6;
export const MAX_MONTH_EXPENSE_MINOR: number;
export const FORECAST_METHODS: readonly {
  readonly id: ForecastMethod;
  readonly label: string;
}[];
/** Exact half-up rounding after training-only clipping. No BigInt escapes this API. */
export function predictExpensePrefix(
  values: readonly number[],
  method: ForecastMethod,
  lead: number,
): { predictedMinor: number; capMinor: number };
export function selectForecastMethod(
  candidates: readonly Pick<
    ForecastCandidate,
    "method" | "foldCount" | "totalAbsoluteErrorMinor"
  >[],
): ForecastMethod;
export function backtestExpenseHistory(
  history: readonly Pick<ExpenseMonth, "month" | "expenseMinor">[],
): ExpenseBacktest;
export function forecastRecordedExpenses(
  ledger: Ledger,
  options: { asOfDate: string; categoryId?: string | null; horizon?: number },
): ExpenseForecast;
