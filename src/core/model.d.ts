import { AchievementState, LedgerIdentityContext } from './achievementSchema';
import { TransactionContext, TransactionContextPatch, PhotoRef } from './transactionContext';
export type { LedgerIdentityContext } from './achievementSchema';
export type Currency = 'MYR' | 'USD' | 'EUR' | 'GBP' | 'JPY' | 'AUD' | 'CAD' | 'CNY';
export type TransactionType = 'income' | 'expense' | 'debt';
export type BudgetPeriod = 'week' | 'month' | 'year';
export type GoalKind =
  | 'retirement'
  | 'home'
  | 'emergencyFund'
  | 'creditDebt'
  | 'education'
  | 'stockMarket'
  | 'vacation'
  | 'investmentFund'
  | 'other';
export type CurrencyInfo = {
  readonly code: Currency;
  readonly label: string;
  readonly symbol: string;
  readonly decimals: 0 | 2;
};
export type Category = { id: string; name: string; type: TransactionType; isDefault: boolean };
/** amountMinor is integer sen/cents for two-decimal currencies, and whole yen for JPY. */
export type Transaction = {
  id: string;
  walletId: string;
  type: TransactionType;
  title: string;
  categoryId: string;
  date: string;
  amountMinor: number;
  context?: TransactionContext;
};
export type Ledger = {
  version: 5;
  mode: 'sample' | 'local';
  wallet: {
    id: string;
    name: string;
    currency: Currency;
    hasTransactionHistory: boolean;
    incarnationId: string;
    trackingStartedOn: string;
  };
  achievements: AchievementState;
  categories: Category[];
  transactions: Transaction[];
  budgets: Budget[];
  goal: Goal | null;
};
export type Budget = {
  id: string;
  walletId: string;
  categoryId: string;
  plannedMinor: number;
  period: BudgetPeriod;
  startDate: string;
  endDate: string;
};
export type BudgetDraft = {
  categoryId: string;
  amount: string;
  period: BudgetPeriod;
  anchorDate: string;
};
export type BudgetProgress = {
  spentMinor: number;
  remainingMinor: number;
  overMinor: number;
  percent: number;
  progress: number;
  status: 'under' | 'at' | 'over';
  transactionCount: number;
};
export type Goal = { id: string; walletId: string; kind: GoalKind; targetMinor: number };
export type GoalDraft = { kind: GoalKind; amount: string };
export type GoalProgress = {
  balanceMinor: number;
  targetMinor: number;
  remainingMinor: number;
  excessMinor: number;
  percent: number;
  progress: number;
  status: 'negative' | 'not-started' | 'in-progress' | 'reached' | 'exceeded';
};
export type Draft = {
  type: TransactionType;
  title: string;
  categoryId: string;
  date: string;
  amount: string;
};
export type Totals = { income: number; expense: number; debt: number; balance: number };
export const STORAGE_VERSION: 5;
export const MAX_AMOUNT_MINOR: number;
export const MAX_TRANSACTIONS: number;
export const TRANSACTION_TYPES: readonly TransactionType[];
export const BUDGET_PERIODS: readonly BudgetPeriod[];
export const GOAL_KINDS: readonly { readonly value: GoalKind; readonly label: string }[];
export const CURRENCIES: readonly CurrencyInfo[];
export const DEFAULT_CATEGORIES: readonly Readonly<Category>[];
export function currencyInfo(currency?: Currency): CurrencyInfo;
export function localDate(date?: Date): string;
export function validDate(value: unknown): boolean;
export function parseMoney(value: string, currency?: Currency): number;
export function amountInputValue(amountMinor: number, currency?: Currency): string;
export function formatMoney(amountMinor: number, currency?: Currency): string;
export function validateLedger(value: unknown): Ledger;
export function createEmptyLedger(
  options?: { name?: string; currency?: Currency },
  context?: LedgerIdentityContext,
): Ledger;
export function createDemoLedger(date?: Date, context?: LedgerIdentityContext): Ledger;
export function migrateLedger(value: unknown, context?: LedgerIdentityContext): Ledger;
export function patchTransactionContext(
  transaction: Transaction,
  patch: TransactionContextPatch | null,
  ledger: Ledger,
): Transaction;
export function collectStoredPhotoReferences(value: unknown): PhotoRef[];
export function categoryForTransaction(ledger: Ledger, transaction: Transaction): Category;
export function transactionFromDraft(draft: Draft, id: string, ledger: Ledger): Transaction;
export function saveTransaction(
  ledger: Ledger,
  transaction: Transaction,
  editing?: boolean,
): Ledger;
export function deleteTransaction(ledger: Ledger, id: string): Ledger;
export function createCategory(
  ledger: Ledger,
  options: { name: string; type: TransactionType; id?: string },
): Ledger;
export function renameCategory(ledger: Ledger, id: string, name: string): Ledger;
export function deleteCategory(ledger: Ledger, id: string): Ledger;
export function updateWallet(
  ledger: Ledger,
  changes: { name?: string; currency?: Currency },
): Ledger;
export function canChangeCurrency(ledger: Ledger): boolean;
export function totals(ledger: Ledger): Totals;
export function periodTotals(ledger: Ledger, startDate: string, endDate: string): Totals;
/** Fixed calendar periods; weeks are Monday through Sunday. Both endpoints are inclusive. */
export function periodBounds(
  period: BudgetPeriod,
  anchorDate?: string,
): { startDate: string; endDate: string };
export function budgetFromDraft(draft: BudgetDraft, id: string, ledger: Ledger): Budget;
export function saveBudget(ledger: Ledger, budget: Budget, editing?: boolean): Ledger;
export function deleteBudget(ledger: Ledger, id: string): Ledger;
export function budgetProgress(ledger: Ledger, budget: Budget): BudgetProgress;
export function goalFromDraft(draft: GoalDraft, id: string, ledger: Ledger): Goal;
export function saveGoal(ledger: Ledger, goal: Goal): Ledger;
export function deleteGoal(ledger: Ledger): Ledger;
export function goalProgress(ledger: Ledger): GoalProgress | null;
/** Uses the same balance/deficit/percentage rules for recorded and hypothetical balances. */
export function goalProgressForBalance(
  balanceMinor: number,
  targetMinor?: number | null,
): GoalProgress | null;
