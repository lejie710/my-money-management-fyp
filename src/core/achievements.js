const { validateLedger, periodTotals, formatMoney } = require('./model');
const {
  ACHIEVEMENT_RULE_VERSION,
  MAX_COMPLETED_DAYS,
  MAX_WEEKLY_REVIEWS,
  captureAchievementClock,
  validateAchievementClock,
  validCalendarDate,
  shiftCalendarDate,
  mondayOf,
} = require('./achievementSchema');

const BADGES = Object.freeze(
  [
    ['first_budget', 'First Budget', 'Create a category budget.'],
    ['first_transaction', 'First Transaction', 'Record a transaction dated on or before today.'],
    [
      'weekly_saver',
      'Weekly Saver',
      'Record entries on seven consecutive completed days with positive combined income minus expenses and debt.',
    ],
    [
      'budget_master',
      'Budget Master',
      'Finish a recorded month within all its monthly budgets, with at least one matching expense.',
    ],
    [
      'expense_tracker',
      'Expense Tracker',
      'Record expenses on five consecutive transaction dates.',
    ],
    [
      'consistent_tracker',
      'Consistent Tracker',
      'Record entries on seven consecutive transaction dates.',
    ],
    [
      'savings_goal_achiever',
      'Savings Goal Achiever',
      'Reach the saved goal using the balance of records dated through today.',
    ],
    [
      'no_spend_day',
      'No Spend Day',
      'Confirm a completed day with no recorded expense or debt payment.',
    ],
    [
      'category_guru',
      'Category Guru',
      'Use six distinct category IDs in records dated through today.',
    ],
    [
      'review_expert',
      'Review Expert',
      'Complete an expense-and-budget review in four consecutive Monday–Sunday weeks.',
    ],
  ].map(([id, title, description]) => Object.freeze({ id, title, description })),
);

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byDate = (a, b) => compareText(a.date, b.date) || compareText(a.id, b.id);

function checked(ledger, clock) {
  validateLedger(ledger);
  validateAchievementClock(clock);
}

// Prefix sums make each fixed-period category calculation logarithmic, without
// multiplying every budget by all transactions. Inputs have already been validated.
function expenseIndex(transactions) {
  const categories = new Map();
  for (const tx of transactions) {
    if (tx.type !== 'expense') continue;
    if (!categories.has(tx.categoryId)) categories.set(tx.categoryId, { dates: [], prefix: [0] });
    const group = categories.get(tx.categoryId);
    group.dates.push(tx.date);
    group.prefix.push(group.prefix[group.prefix.length - 1] + tx.amountMinor);
  }
  return categories;
}

function bound(dates, value, inclusive) {
  let low = 0,
    high = dates.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (dates[middle] < value || (inclusive && dates[middle] === value)) low = middle + 1;
    else high = middle;
  }
  return low;
}

function spending(index, categoryId, start, end) {
  const group = index.get(categoryId);
  if (!group || start > end) return { amount: 0, count: 0 };
  const first = bound(group.dates, start, false),
    last = bound(group.dates, end, true);
  return { amount: group.prefix[last] - group.prefix[first], count: last - first };
}

function facts(ledger, clock) {
  const transactions = ledger.transactions
    .filter((tx) => tx.date <= clock.today)
    .slice()
    .sort(byDate);
  const days = new Map();
  for (const tx of transactions) {
    if (!days.has(tx.date))
      days.set(tx.date, { income: 0, expense: 0, debt: 0, count: 0, expenseCount: 0 });
    const day = days.get(tx.date);
    day[tx.type] += tx.amountMinor;
    day.count += 1;
    if (tx.type === 'expense') day.expenseCount += 1;
  }
  return { transactions, days, index: expenseIndex(transactions) };
}

function streak(dates, length, step = 1, predicate = () => true) {
  let run = [],
    max = 0,
    witness = null;
  for (const date of dates) {
    if (run.length && shiftCalendarDate(run[run.length - 1], step) !== date) run = [];
    run.push(date);
    max = Math.max(max, run.length);
    if (run.length >= length && !witness) {
      const window = run.slice(-length);
      if (predicate(window)) witness = window;
    }
  }
  return { max: Math.min(max, length), witness };
}

function dayTotals(days, window) {
  const value = { income: 0, expense: 0, debt: 0, count: 0, expenseCount: 0 };
  for (const date of window)
    for (const field of Object.keys(value)) value[field] += days.get(date)[field];
  return { ...value, net: value.income - value.expense - value.debt };
}

function ruleResults(ledger, clock) {
  const f = facts(ledger, clock),
    result = new Map();
  const set = (id, evidence, current = Number(Boolean(evidence)), target = 1, reason = '') =>
    result.set(id, {
      evidence,
      qualified: Boolean(evidence),
      progress: { current, target },
      reason,
    });
  const firstBudget = ledger.budgets.slice().sort((a, b) => compareText(a.id, b.id))[0];
  set(
    'first_budget',
    firstBudget ? { kind: 'first_budget', budgetId: firstBudget.id } : null,
    Number(Boolean(firstBudget)),
    1,
    firstBudget ? 'A category budget is recorded.' : 'No category budget is recorded yet.',
  );
  const firstTx = f.transactions[0];
  set(
    'first_transaction',
    firstTx ? { kind: 'first_transaction', transactionId: firstTx.id, date: firstTx.date } : null,
    Number(Boolean(firstTx)),
    1,
    firstTx
      ? `An entry is recorded on ${firstTx.date}.`
      : 'Record an entry dated on or before today; future entries do not count.',
  );

  const completedDates = [...f.days.keys()].filter((date) => date < clock.today);
  const saved = streak(completedDates, 7, 1, (window) => dayTotals(f.days, window).net > 0);
  const savedTotals = saved.witness ? dayTotals(f.days, saved.witness) : null;
  set(
    'weekly_saver',
    saved.witness
      ? {
          kind: 'weekly_saver',
          startDate: saved.witness[0],
          endDate: saved.witness[6],
          dayCount: 7,
          transactionCount: savedTotals.count,
          incomeMinor: savedTotals.income,
          expenseMinor: savedTotals.expense,
          debtMinor: savedTotals.debt,
          netMinor: savedTotals.net,
        }
      : null,
    saved.max,
    7,
    saved.witness
      ? 'Seven completed recorded days have positive combined net cash flow.'
      : saved.max === 7
        ? 'Seven completed dates are present, but no seven-day window has positive combined net cash flow.'
        : 'Each of seven consecutive completed days needs an entry, and their combined net must be positive.',
  );

  const months = new Map();
  for (const budget of ledger.budgets) {
    if (budget.period !== 'month' || budget.endDate >= clock.today) continue;
    const month = budget.startDate.slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(budget);
  }
  let mastered = null;
  for (const month of [...months.keys()].sort()) {
    const budgets = months.get(month);
    const values = budgets.map((b) => ({
      budget: b,
      ...spending(f.index, b.categoryId, b.startDate, b.endDate),
    }));
    const matchedExpenseCount = values.reduce((sum, v) => sum + v.count, 0);
    if (matchedExpenseCount > 0 && values.every((v) => v.amount <= v.budget.plannedMinor)) {
      mastered = {
        kind: 'budget_master',
        month,
        budgetCount: budgets.length,
        matchedExpenseCount,
        totalPlannedMinor: budgets.reduce((sum, b) => sum + b.plannedMinor, 0),
        totalSpentMinor: values.reduce((sum, v) => sum + v.amount, 0),
      };
      break;
    }
  }
  set(
    'budget_master',
    mastered,
    Number(Boolean(mastered)),
    1,
    mastered
      ? `All ${mastered.budgetCount} monthly budgets for ${mastered.month} are within their limits.`
      : 'A completed month needs monthly budgets, matching expenses, and no monthly budget over its limit.',
  );

  const expenseStreak = streak(
    [...f.days.keys()].filter((date) => f.days.get(date).expenseCount > 0),
    5,
  );
  const anyStreak = streak([...f.days.keys()], 7);
  set(
    'expense_tracker',
    expenseStreak.witness
      ? {
          kind: 'expense_tracker',
          startDate: expenseStreak.witness[0],
          endDate: expenseStreak.witness[4],
          dayCount: 5,
          expenseCount: dayTotals(f.days, expenseStreak.witness).expenseCount,
        }
      : null,
    expenseStreak.max,
    5,
    `${expenseStreak.max} of 5 consecutive expense-entry dates are recorded. This counts transaction dates, not logins.`,
  );
  set(
    'consistent_tracker',
    anyStreak.witness
      ? {
          kind: 'consistent_tracker',
          startDate: anyStreak.witness[0],
          endDate: anyStreak.witness[6],
          dayCount: 7,
          transactionCount: dayTotals(f.days, anyStreak.witness).count,
        }
      : null,
    anyStreak.max,
    7,
    `${anyStreak.max} of 7 consecutive entry dates are recorded. Multiple entries on one date count once.`,
  );

  const balance = periodTotals(ledger, '1900-01-01', clock.today).balance;
  const reached = ledger.goal && balance >= ledger.goal.targetMinor;
  set(
    'savings_goal_achiever',
    reached
      ? {
          kind: 'savings_goal_achiever',
          goalId: ledger.goal.id,
          targetMinor: ledger.goal.targetMinor,
          balanceMinor: balance,
          throughDate: clock.today,
        }
      : null,
    Number(Boolean(reached)),
    1,
    ledger.goal
      ? `Balance through ${clock.today}: ${formatMoney(balance, ledger.wallet.currency)} toward ${formatMoney(ledger.goal.targetMinor, ledger.wallet.currency)}. Future records are excluded.`
      : 'Save a positive goal target to track this milestone.',
  );

  const noSpend = ledger.achievements.completedDays
    .slice()
    .sort((a, b) => compareText(a.date, b.date))
    .find(
      (event) =>
        event.date < clock.today &&
        event.confirmedAtMs <= clock.nowMs &&
        !(f.days.get(event.date)?.expense || f.days.get(event.date)?.debt),
    );
  set(
    'no_spend_day',
    noSpend
      ? { kind: 'no_spend_day', date: noSpend.date, confirmedAtMs: noSpend.confirmedAtMs }
      : null,
    Number(Boolean(noSpend)),
    1,
    noSpend
      ? `${noSpend.date} was explicitly confirmed with no recorded outflow.`
      : 'Explicitly confirm a completed day with no expense or debt payment. Missing entries alone do not count.',
  );

  const categories = [...new Set(f.transactions.map((tx) => tx.categoryId))].sort();
  set(
    'category_guru',
    categories.length >= 6
      ? {
          kind: 'category_guru',
          categoryIds: categories.slice(0, 6),
          distinctCategoryCount: categories.length,
          throughDate: clock.today,
        }
      : null,
    Math.min(categories.length, 6),
    6,
    `${categories.length} distinct category IDs are used through today. Renames do not add a category.`,
  );

  const reviews = ledger.achievements.weeklyReviews
    .filter(
      (review) => review.completedOnDate <= clock.today && review.completedAtMs <= clock.nowMs,
    )
    .slice()
    .sort((a, b) => compareText(a.weekStart, b.weekStart));
  const reviewStreak = streak(
    reviews.map((r) => r.weekStart),
    4,
    7,
  );
  const reviewMap = new Map(reviews.map((r) => [r.weekStart, r]));
  set(
    'review_expert',
    reviewStreak.witness
      ? {
          kind: 'review_expert',
          weekStarts: reviewStreak.witness,
          completedAtMs: reviewStreak.witness.map((week) => reviewMap.get(week).completedAtMs),
        }
      : null,
    reviewStreak.max,
    4,
    `${reviewStreak.max} of 4 consecutive weeks have explicit completed reviews. Opening the screen does not count.`,
  );
  return result;
}

function evaluateAchievements(ledger, clock) {
  checked(ledger, clock);
  const results = ruleResults(ledger, clock),
    preview = ledger.mode === 'sample';
  return BADGES.map((badge) => ({
    ...badge,
    preview,
    ...results.get(badge.id),
    award: preview
      ? null
      : (ledger.achievements.awards.find((award) => award.id === badge.id) ?? null),
  }));
}

function reconcileAchievements(ledger, clock) {
  const evaluations = evaluateAchievements(ledger, clock);
  if (ledger.mode === 'sample') return { ledger, newAwards: [], evaluations, changed: false };
  if (clock.today < ledger.wallet.trackingStartedOn)
    throw new Error('The observation date is before this wallet started tracking.');
  const newAwards = evaluations
    .filter((e) => e.qualified && !e.award)
    .map((e) => ({
      id: e.id,
      ruleVersion: ACHIEVEMENT_RULE_VERSION,
      earnedAtMs: clock.nowMs,
      earnedOnDate: clock.today,
      evidence: e.evidence,
    }));
  if (!newAwards.length) return { ledger, newAwards, evaluations, changed: false };
  const updated = validateLedger({
    ...ledger,
    achievements: { ...ledger.achievements, awards: [...ledger.achievements.awards, ...newAwards] },
  });
  return {
    ledger: updated,
    newAwards,
    evaluations: evaluations.map((e) => ({
      ...e,
      award: updated.achievements.awards.find((a) => a.id === e.id) ?? null,
    })),
    changed: true,
  };
}

function requireLocalAction(ledger, clock) {
  checked(ledger, clock);
  if (ledger.mode !== 'local')
    throw new Error(
      'Sample milestones are a preview. Start a fresh local wallet to record activity.',
    );
  if (clock.today < ledger.wallet.trackingStartedOn)
    throw new Error('The action date is before this wallet started tracking.');
}

function recordCompletedDay(ledger, date, clock) {
  requireLocalAction(ledger, clock);
  if (
    !validCalendarDate(date) ||
    date >= clock.today ||
    date < ledger.wallet.trackingStartedOn ||
    date < shiftCalendarDate(clock.today, -MAX_COMPLETED_DAYS)
  )
    throw new Error(
      'Choose a completed day since tracking started, within the most recent 366 days.',
    );
  if (
    ledger.transactions.some(
      (tx) => tx.date === date && (tx.type === 'expense' || tx.type === 'debt'),
    )
  )
    throw new Error(
      'This date has a recorded expense or debt payment and cannot be confirmed as no spend.',
    );
  if (ledger.achievements.completedDays.some((event) => event.date === date)) return ledger;
  const completedDays = [...ledger.achievements.completedDays, { date, confirmedAtMs: clock.nowMs }]
    .sort((a, b) => compareText(a.date, b.date))
    .slice(-MAX_COMPLETED_DAYS);
  return validateLedger({ ...ledger, achievements: { ...ledger.achievements, completedDays } });
}

function weeklyReviewSummary(ledger, clock) {
  checked(ledger, clock);
  // Reviews may cover the partial final week of the supported calendar. Unlike
  // a saved weekly budget, a review does not require its Sunday to be supported.
  const startDate = mondayOf(clock.today);
  const calendarEnd = shiftCalendarDate(startDate, 6);
  const bounds = { startDate, endDate: calendarEnd > '2100-12-31' ? '2100-12-31' : calendarEnd };
  const f = facts(ledger, clock);
  const totals = periodTotals(ledger, bounds.startDate, clock.today);
  const budgets = ledger.budgets
    .filter((b) => b.startDate <= bounds.endDate && b.endDate >= bounds.startDate)
    .slice()
    .sort((a, b) => compareText(a.startDate, b.startDate) || compareText(a.id, b.id))
    .map((budget) => {
      const throughDate = budget.endDate < clock.today ? budget.endDate : clock.today;
      const spentMinor = spending(f.index, budget.categoryId, budget.startDate, throughDate).amount;
      return {
        budgetId: budget.id,
        categoryId: budget.categoryId,
        categoryName: ledger.categories.find((c) => c.id === budget.categoryId).name,
        period: budget.period,
        startDate: budget.startDate,
        endDate: budget.endDate,
        throughDate,
        plannedMinor: budget.plannedMinor,
        spentMinor,
        remainingMinor: budget.plannedMinor - spentMinor,
        overMinor: Math.max(0, spentMinor - budget.plannedMinor),
      };
    });
  return {
    weekStart: bounds.startDate,
    weekEnd: bounds.endDate,
    throughDate: clock.today,
    currency: ledger.wallet.currency,
    expenseMinor: totals.expense,
    debtMinor: totals.debt,
    transactionCount: f.transactions.filter((tx) => tx.date >= bounds.startDate).length,
    budgetCount: budgets.length,
    budgets,
    completedReview:
      ledger.achievements.weeklyReviews.find((r) => r.weekStart === bounds.startDate) ?? null,
  };
}

function completeWeeklyReview(ledger, clock) {
  requireLocalAction(ledger, clock);
  const summary = weeklyReviewSummary(ledger, clock);
  if (summary.completedReview) return ledger;
  const review = {
    weekStart: summary.weekStart,
    completedOnDate: clock.today,
    completedAtMs: clock.nowMs,
    expenseMinor: summary.expenseMinor,
    debtMinor: summary.debtMinor,
    budgetCount: summary.budgetCount,
  };
  const weeklyReviews = [...ledger.achievements.weeklyReviews, review]
    .sort((a, b) => compareText(a.weekStart, b.weekStart))
    .slice(-MAX_WEEKLY_REVIEWS);
  return validateLedger({ ...ledger, achievements: { ...ledger.achievements, weeklyReviews } });
}

function eventKey(ledger, kind, ...identity) {
  return JSON.stringify(['milestone-v1', ledger.wallet.incarnationId, kind, ...identity]);
}

function milestoneState(ledger, clock) {
  const f = facts(ledger, clock);
  const budgets = new Map();
  for (const budget of ledger.budgets) {
    const spent = spending(f.index, budget.categoryId, budget.startDate, budget.endDate).amount;
    budgets.set(eventKey(ledger, 'budget', budget.id, budget.startDate, budget.endDate), {
      budget,
      spent,
      over: spent > budget.plannedMinor,
    });
  }
  const balance = periodTotals(ledger, '1900-01-01', clock.today).balance;
  const goal = ledger.goal
    ? {
        identity: eventKey(ledger, 'goal', ledger.goal.id, ledger.goal.targetMinor),
        near: balance * 10 >= ledger.goal.targetMinor * 9,
        reached: balance >= ledger.goal.targetMinor,
        balance,
        target: ledger.goal.targetMinor,
      }
    : null;
  const awards = new Map(
    ledger.achievements.awards.map((award) => [
      eventKey(ledger, 'achievement', award.id, award.ruleVersion),
      award,
    ]),
  );
  return { budgets, goal, awards };
}

function currentFinancialMilestoneKeys(ledger, clock) {
  checked(ledger, clock);
  if (ledger.mode !== 'local') return [];
  const state = milestoneState(ledger, clock);
  const keys = [...state.budgets].filter(([, value]) => value.over).map(([key]) => key);
  if (state.goal?.near) keys.push(`${state.goal.identity}:near`);
  if (state.goal?.reached) keys.push(`${state.goal.identity}:reached`);
  return [...keys, ...state.awards.keys()].sort();
}

function financialMilestoneEvents(previous, committed, clock) {
  checked(previous, clock);
  checked(committed, clock);
  if (
    previous.mode !== 'local' ||
    committed.mode !== 'local' ||
    previous.wallet.incarnationId !== committed.wallet.incarnationId
  )
    return [];
  const before = milestoneState(previous, clock),
    after = milestoneState(committed, clock),
    events = [];
  const add = (key, kind, title, body) =>
    events.push({ key, kind, title, body, occurredAtMs: clock.nowMs });
  const currency = committed.wallet.currency;
  for (const [key, value] of after.budgets)
    if (value.over && !before.budgets.get(key)?.over) {
      const category = committed.categories.find((c) => c.id === value.budget.categoryId);
      add(
        key,
        'budget',
        'Recorded budget exceeded',
        `${category.name}: ${formatMoney(value.spent, currency)} recorded through ${clock.today} against ${formatMoney(value.budget.plannedMinor, currency)} for ${value.budget.startDate} to ${value.budget.endDate}.`,
      );
    }
  if (after.goal) {
    const old = before.goal?.identity === after.goal.identity ? before.goal : null;
    if (after.goal.reached && !old?.reached)
      add(
        `${after.goal.identity}:reached`,
        'goal',
        'Recorded savings target reached',
        `Balance through ${clock.today} is ${formatMoney(after.goal.balance, currency)} toward ${formatMoney(after.goal.target, currency)}. Future records are excluded.`,
      );
    else if (after.goal.near && !after.goal.reached && !old?.near)
      add(
        `${after.goal.identity}:near`,
        'goal',
        'Recorded balance is near your target',
        `Balance through ${clock.today} has reached at least 90% of ${formatMoney(after.goal.target, currency)}. Future records are excluded.`,
      );
  }
  for (const [key, award] of after.awards)
    if (!before.awards.has(key)) {
      const badge = BADGES.find((item) => item.id === award.id);
      add(
        key,
        'achievement',
        `${badge.title} earned`,
        'A milestone in your recorded activity has been saved.',
      );
    }
  return events;
}

module.exports = {
  ACHIEVEMENT_RULE_VERSION,
  MAX_COMPLETED_DAYS,
  MAX_WEEKLY_REVIEWS,
  BADGES,
  captureAchievementClock,
  evaluateAchievements,
  reconcileAchievements,
  recordCompletedDay,
  weeklyReviewSummary,
  completeWeeklyReview,
  currentFinancialMilestoneKeys,
  financialMilestoneEvents,
};
