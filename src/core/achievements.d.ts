import { BudgetPeriod, Currency, Ledger } from './model';
import {
  AchievementClock,
  AchievementAward,
  AchievementEvidence,
  BadgeId,
  WeeklyReview,
} from './achievementSchema';
export type {
  AchievementClock,
  AchievementAward,
  AchievementEvidence,
  AchievementState,
  BadgeId,
  CompletedDay,
  WeeklyReview,
} from './achievementSchema';
export {
  ACHIEVEMENT_RULE_VERSION,
  MAX_COMPLETED_DAYS,
  MAX_WEEKLY_REVIEWS,
  captureAchievementClock,
} from './achievementSchema';
export const BADGES: readonly {
  readonly id: BadgeId;
  readonly title: string;
  readonly description: string;
}[];
export type AchievementEvaluation = {
  id: BadgeId;
  title: string;
  description: string;
  preview: boolean;
  qualified: boolean;
  award: AchievementAward | null;
  progress: { current: number; target: number } | null;
  reason: string;
  evidence: AchievementEvidence | null;
};
export type WeeklyReviewSummary = {
  weekStart: string;
  weekEnd: string;
  throughDate: string;
  currency: Currency;
  expenseMinor: number;
  debtMinor: number;
  transactionCount: number;
  budgetCount: number;
  budgets: {
    budgetId: string;
    categoryId: string;
    categoryName: string;
    period: BudgetPeriod;
    startDate: string;
    endDate: string;
    throughDate: string;
    plannedMinor: number;
    spentMinor: number;
    remainingMinor: number;
    overMinor: number;
  }[];
  completedReview: WeeklyReview | null;
};
export function evaluateAchievements(
  ledger: Ledger,
  clock: AchievementClock,
): AchievementEvaluation[];
export function reconcileAchievements(
  ledger: Ledger,
  clock: AchievementClock,
): {
  ledger: Ledger;
  newAwards: AchievementAward[];
  evaluations: AchievementEvaluation[];
  changed: boolean;
};
export function recordCompletedDay(ledger: Ledger, date: string, clock: AchievementClock): Ledger;
export function weeklyReviewSummary(ledger: Ledger, clock: AchievementClock): WeeklyReviewSummary;
export function completeWeeklyReview(ledger: Ledger, clock: AchievementClock): Ledger;
export type FinancialMilestoneEvent = {
  key: string;
  kind: 'budget' | 'goal' | 'achievement';
  title: string;
  body: string;
  occurredAtMs: number;
};
export function currentFinancialMilestoneKeys(ledger: Ledger, clock: AchievementClock): string[];
export function financialMilestoneEvents(
  previous: Ledger,
  committed: Ledger,
  clock: AchievementClock,
): FinancialMilestoneEvent[];
