// Leaf schema: no ledger imports and no effects during validation.
const ACHIEVEMENT_RULE_VERSION = 'recorded-milestones-v1';
const MAX_COMPLETED_DAYS = 366;
const MAX_WEEKLY_REVIEWS = 104;
const BADGE_IDS = Object.freeze([
  'first_budget',
  'first_transaction',
  'weekly_saver',
  'budget_master',
  'expense_tracker',
  'consistent_tracker',
  'savings_goal_achiever',
  'no_spend_day',
  'category_guru',
  'review_expert',
]);
const MAX_RECORDS = 10000;
const MAX_MONEY = 999999999 * MAX_RECORDS;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value);
const count = (value, min = 0, max = MAX_RECORDS) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const money = (value) => count(value, 0, MAX_MONEY);
const instant = (value) => Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000;

function validCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function shiftCalendarDate(value, days) {
  if (!validCalendarDate(value) || !Number.isSafeInteger(days) || Math.abs(days) > 100000)
    throw new Error('Choose a valid calendar date and day interval.');
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function mondayOf(value) {
  if (!validCalendarDate(value)) throw new Error('Choose a valid calendar date.');
  const day = new Date(`${value}T12:00:00.000Z`).getUTCDay();
  return shiftCalendarDate(value, -((day + 6) % 7));
}

function validateAchievementClock(clock) {
  if (!object(clock) || !validCalendarDate(clock.today) || !instant(clock.nowMs))
    throw new Error('Achievements require a valid calendar date and observation time.');
  return clock;
}

function captureAchievementClock(nowMs = Date.now()) {
  if (!instant(nowMs)) throw new Error('Achievements require a valid observation time.');
  const date = new Date(nowMs);
  const today = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  return validateAchievementClock({ today, nowMs });
}

function createWalletIdentity(context = {}) {
  const clock = validateAchievementClock(context.clock ?? captureAchievementClock());
  if (context.newIncarnationId !== undefined && typeof context.newIncarnationId !== 'function')
    throw new Error('A wallet identity factory must be a function.');
  const incarnationId = context.newIncarnationId
    ? context.newIncarnationId()
    : `wallet-${clock.nowMs.toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
  if (!id(incarnationId)) throw new Error('The wallet incarnation identifier is invalid.');
  return { incarnationId, trackingStartedOn: clock.today };
}

function emptyAchievementState(incarnationId) {
  if (!id(incarnationId)) throw new Error('The wallet incarnation identifier is invalid.');
  return {
    version: 1,
    ownerIncarnationId: incarnationId,
    awards: [],
    completedDays: [],
    weeklyReviews: [],
  };
}

function consecutiveWindow(evidence, length, earnedOnDate, completed = false) {
  return (
    validCalendarDate(evidence.startDate) &&
    validCalendarDate(evidence.endDate) &&
    evidence.dayCount === length &&
    shiftCalendarDate(evidence.startDate, length - 1) === evidence.endDate &&
    (completed ? evidence.endDate < earnedOnDate : evidence.endDate <= earnedOnDate)
  );
}

function validEvidence(award, trackingStartedOn) {
  const e = award.evidence;
  if (!object(e) || e.kind !== award.id) return false;
  switch (e.kind) {
    case 'first_budget':
      return id(e.budgetId);
    case 'first_transaction':
      return id(e.transactionId) && validCalendarDate(e.date) && e.date <= award.earnedOnDate;
    case 'weekly_saver':
      return (
        consecutiveWindow(e, 7, award.earnedOnDate, true) &&
        count(e.transactionCount, 7) &&
        money(e.incomeMinor) &&
        money(e.expenseMinor) &&
        money(e.debtMinor) &&
        money(e.netMinor) &&
        e.netMinor > 0 &&
        e.netMinor === e.incomeMinor - e.expenseMinor - e.debtMinor
      );
    case 'budget_master':
      return (
        typeof e.month === 'string' &&
        validCalendarDate(`${e.month}-01`) &&
        e.month < award.earnedOnDate.slice(0, 7) &&
        count(e.budgetCount, 1) &&
        count(e.matchedExpenseCount, 1) &&
        money(e.totalPlannedMinor) &&
        e.totalPlannedMinor > 0 &&
        money(e.totalSpentMinor) &&
        e.totalSpentMinor > 0 &&
        e.totalSpentMinor <= e.totalPlannedMinor
      );
    case 'expense_tracker':
      return consecutiveWindow(e, 5, award.earnedOnDate) && count(e.expenseCount, 5);
    case 'consistent_tracker':
      return consecutiveWindow(e, 7, award.earnedOnDate) && count(e.transactionCount, 7);
    case 'savings_goal_achiever':
      return (
        id(e.goalId) &&
        count(e.targetMinor, 1, 999999999) &&
        money(e.balanceMinor) &&
        e.balanceMinor >= e.targetMinor &&
        validCalendarDate(e.throughDate) &&
        e.throughDate <= award.earnedOnDate
      );
    case 'no_spend_day':
      return (
        validCalendarDate(e.date) &&
        e.date >= trackingStartedOn &&
        e.date < award.earnedOnDate &&
        instant(e.confirmedAtMs) &&
        e.confirmedAtMs <= award.earnedAtMs
      );
    case 'category_guru':
      return (
        Array.isArray(e.categoryIds) &&
        e.categoryIds.length === 6 &&
        e.categoryIds.every(id) &&
        new Set(e.categoryIds).size === 6 &&
        count(e.distinctCategoryCount, 6, MAX_RECORDS + 17) &&
        validCalendarDate(e.throughDate) &&
        e.throughDate <= award.earnedOnDate
      );
    case 'review_expert':
      return (
        Array.isArray(e.weekStarts) &&
        e.weekStarts.length === 4 &&
        e.weekStarts.every(
          (date, i) =>
            validCalendarDate(date) &&
            mondayOf(date) === date &&
            date <= award.earnedOnDate &&
            (i === 0 || shiftCalendarDate(e.weekStarts[i - 1], 7) === date),
        ) &&
        Array.isArray(e.completedAtMs) &&
        e.completedAtMs.length === 4 &&
        e.completedAtMs.every((time) => instant(time) && time <= award.earnedAtMs)
      );
    default:
      return false;
  }
}

function validateAchievementState(state, wallet, mode) {
  const invalid = () => {
    throw new Error(
      'Saved achievement ownership or evidence has an unsupported or invalid format.',
    );
  };
  if (
    !object(wallet) ||
    !id(wallet.incarnationId) ||
    !validCalendarDate(wallet.trackingStartedOn) ||
    !object(state) ||
    state.version !== 1 ||
    state.ownerIncarnationId !== wallet.incarnationId ||
    !Array.isArray(state.awards) ||
    state.awards.length > BADGE_IDS.length ||
    !Array.isArray(state.completedDays) ||
    state.completedDays.length > MAX_COMPLETED_DAYS ||
    !Array.isArray(state.weeklyReviews) ||
    state.weeklyReviews.length > MAX_WEEKLY_REVIEWS
  )
    invalid();
  if (
    mode === 'sample' &&
    (state.awards.length || state.completedDays.length || state.weeklyReviews.length)
  )
    invalid();
  if (
    !state.awards.every(
      (award) =>
        object(award) &&
        BADGE_IDS.includes(award.id) &&
        award.ruleVersion === ACHIEVEMENT_RULE_VERSION &&
        instant(award.earnedAtMs) &&
        validCalendarDate(award.earnedOnDate) &&
        award.earnedOnDate >= wallet.trackingStartedOn &&
        validEvidence(award, wallet.trackingStartedOn),
    ) ||
    new Set(state.awards.map((award) => award.id)).size !== state.awards.length
  )
    invalid();
  if (
    !state.completedDays.every(
      (event) =>
        object(event) &&
        validCalendarDate(event.date) &&
        event.date >= wallet.trackingStartedOn &&
        instant(event.confirmedAtMs),
    ) ||
    new Set(state.completedDays.map((event) => event.date)).size !== state.completedDays.length
  )
    invalid();
  if (
    !state.weeklyReviews.every(
      (event) =>
        object(event) &&
        validCalendarDate(event.weekStart) &&
        mondayOf(event.weekStart) === event.weekStart &&
        validCalendarDate(event.completedOnDate) &&
        event.completedOnDate >= wallet.trackingStartedOn &&
        event.completedOnDate >= event.weekStart &&
        event.completedOnDate <= shiftCalendarDate(event.weekStart, 6) &&
        instant(event.completedAtMs) &&
        money(event.expenseMinor) &&
        money(event.debtMinor) &&
        count(event.budgetCount),
    ) ||
    new Set(state.weeklyReviews.map((event) => event.weekStart)).size !== state.weeklyReviews.length
  )
    invalid();
  return state;
}

module.exports = {
  ACHIEVEMENT_RULE_VERSION,
  MAX_COMPLETED_DAYS,
  MAX_WEEKLY_REVIEWS,
  BADGE_IDS,
  validCalendarDate,
  shiftCalendarDate,
  mondayOf,
  captureAchievementClock,
  validateAchievementClock,
  createWalletIdentity,
  emptyAchievementState,
  validateAchievementState,
};
