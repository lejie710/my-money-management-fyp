import { Currency, Ledger, TransactionType } from './model';

/** Ratios are fractions, not percentages. All are null when selected-period income is zero. */
export type RecordedCashFlowRatios = {
  retainedNetToIncome: number | null;
  expenseToIncome: number | null;
  debtToIncome: number | null;
  outflowToIncome: number | null;
};

export type CategoryTotal = {
  categoryId: string;
  categoryName: string;
  type: TransactionType;
  amountMinor: number;
  typeTotalMinor: number;
  /** Fraction of income, expense, or debt total respectively; 0.8 means 80%. */
  shareOfType: number;
  transactionCount: number;
};

/** All monetary fields are exact integer minor units of this single wallet's currency. */
export type PeriodReport = {
  startDate: string;
  endDate: string;
  currency: Currency;
  openingMinor: number;
  incomeMinor: number;
  expenseMinor: number;
  debtMinor: number;
  outflowMinor: number;
  netMinor: number;
  closingMinor: number;
  /** All recorded transactions, including those after the selected end date. */
  currentBalanceMinor: number;
  transactionCount: number;
  hasActivity: boolean;
  categoryBreakdown: CategoryTotal[];
  ratios: RecordedCashFlowRatios;
};

export type MonthlyReport = PeriodReport & {
  /** Calendar month as YYYY-MM. */
  month: string;
  isPartialPeriod: boolean;
};

/** Both YYYY-MM-DD boundaries are inclusive. Invalid or reversed ranges throw. */
export function periodReport(ledger: Ledger, startDate: string, endDate: string): PeriodReport;
/** Includes inactive calendar months; first/last months are clipped to the explicit range. */
export function monthlySeries(ledger: Ledger, startDate: string, endDate: string): MonthlyReport[];
