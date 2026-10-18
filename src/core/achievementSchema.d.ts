export type AchievementClock = { today: string; nowMs: number };
export type LedgerIdentityContext = { clock?: AchievementClock; newIncarnationId?: () => string };
export type BadgeId =
  | 'first_budget'
  | 'first_transaction'
  | 'weekly_saver'
  | 'budget_master'
  | 'expense_tracker'
  | 'consistent_tracker'
  | 'savings_goal_achiever'
  | 'no_spend_day'
  | 'category_guru'
  | 'review_expert';
export type CompletedDay = { date: string; confirmedAtMs: number };
export type WeeklyReview = {
  weekStart: string;
  completedOnDate: string;
  completedAtMs: number;
  expenseMinor: number;
  debtMinor: number;
  budgetCount: number;
};
export type AchievementEvidence =
  | { kind: 'first_budget'; budgetId: string }
  | { kind: 'first_transaction'; transactionId: string; date: string }
  | {
      kind: 'weekly_saver';
      startDate: string;
      endDate: string;
      dayCount: 7;
      transactionCount: number;
      incomeMinor: number;
      expenseMinor: number;
      debtMinor: number;
      netMinor: number;
    }
  | {
      kind: 'budget_master';
      month: string;
      budgetCount: number;
      matchedExpenseCount: number;
      totalPlannedMinor: number;
      totalSpentMinor: number;
    }
  | {
      kind: 'expense_tracker';
      startDate: string;
      endDate: string;
      dayCount: 5;
      expenseCount: number;
    }
  | {
      kind: 'consistent_tracker';
      startDate: string;
      endDate: string;
      dayCount: 7;
      transactionCount: number;
    }
  | {
      kind: 'savings_goal_achiever';
      goalId: string;
      targetMinor: number;
      balanceMinor: number;
      throughDate: string;
    }
  | { kind: 'no_spend_day'; date: string; confirmedAtMs: number }
  | {
      kind: 'category_guru';
      categoryIds: string[];
      distinctCategoryCount: number;
      throughDate: string;
    }
  | { kind: 'review_expert'; weekStarts: string[]; completedAtMs: number[] };
export type AchievementAward = {
  id: BadgeId;
  ruleVersion: 'recorded-milestones-v1';
  earnedAtMs: number;
  earnedOnDate: string;
  evidence: AchievementEvidence;
};
export type AchievementState = {
  version: 1;
  ownerIncarnationId: string;
  awards: AchievementAward[];
  completedDays: CompletedDay[];
  weeklyReviews: WeeklyReview[];
};
export const ACHIEVEMENT_RULE_VERSION: 'recorded-milestones-v1';
export const MAX_COMPLETED_DAYS: 366;
export const MAX_WEEKLY_REVIEWS: 104;
export const BADGE_IDS: readonly BadgeId[];
export function captureAchievementClock(nowMs?: number): AchievementClock;
export function validateAchievementClock(value: unknown): AchievementClock;
export function validCalendarDate(value: unknown): boolean;
export function shiftCalendarDate(date: string, days: number): string;
export function mondayOf(date: string): string;
export function createWalletIdentity(context?: LedgerIdentityContext): {
  incarnationId: string;
  trackingStartedOn: string;
};
export function emptyAchievementState(incarnationId: string): AchievementState;
export function validateAchievementState(
  value: unknown,
  wallet: { incarnationId: string; trackingStartedOn: string },
  mode: 'sample' | 'local',
): AchievementState;
