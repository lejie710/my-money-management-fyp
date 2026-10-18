const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/core/model');
const a = require('../src/core/achievements');
const s = require('../src/core/achievementSchema');
const clock = (today = '2026-11-02') => ({ today, nowMs: Date.parse(`${today}T12:00:00Z`) });
function fresh(start = '2026-10-01', id = 'test-wallet') {
  return m.createEmptyLedger({}, { clock: clock(start), newIncarnationId: () => id });
}
function tx(ledger, id, type, date, amount = '10', categoryId) {
  const category =
    categoryId ?? { income: 'income-salary', expense: 'expense-food', debt: 'debt-loan' }[type];
  return m.saveTransaction(
    ledger,
    m.transactionFromDraft({ title: id, type, date, amount, categoryId: category }, id, ledger),
  );
}
function budget(
  ledger,
  id = 'food-budget',
  amount = '100',
  anchorDate = '2026-10-01',
  period = 'month',
  categoryId = 'expense-food',
) {
  return m.saveBudget(
    ledger,
    m.budgetFromDraft({ categoryId, amount, period, anchorDate }, id, ledger),
  );
}
function goal(ledger, amount = '100', id = 'goal') {
  return m.saveGoal(ledger, m.goalFromDraft({ kind: 'home', amount }, id, ledger));
}
const row = (ledger, id, time = clock()) =>
  a.evaluateAchievements(ledger, time).find((item) => item.id === id);
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test('all ten original badges are present; empty data is not awarded or inferred activity', () => {
  const ledger = fresh(),
    before = JSON.stringify(ledger),
    evaluated = a.evaluateAchievements(freeze(ledger), clock());
  assert.equal(evaluated.length, 10);
  assert.equal(new Set(evaluated.map((x) => x.id)).size, 10);
  assert.deepEqual(
    evaluated.map((x) => x.id),
    s.BADGE_IDS,
  );
  assert.ok(evaluated.every((x) => !x.qualified && !x.award && !x.preview));
  assert.equal(JSON.stringify(ledger), before);
  assert.equal(a.reconcileAchievements(ledger, clock()).ledger, ledger);
});

test('first budget counts actual creation; first transaction excludes future-only records', () => {
  let ledger = budget(fresh(), 'future', '100', '2027-01-01');
  assert.equal(row(ledger, 'first_budget').qualified, true);
  ledger = tx(ledger, 'future', 'income', '2026-11-03');
  assert.equal(row(ledger, 'first_transaction').qualified, false);
  ledger = tx(ledger, 'today', 'debt', '2026-11-02');
  assert.deepEqual(row(ledger, 'first_transaction').evidence, {
    kind: 'first_transaction',
    transactionId: 'today',
    date: '2026-11-02',
  });
});

test('weekly saver requires seven completed occupied dates and positive debt-inclusive net', () => {
  let ledger = fresh();
  for (let i = 0; i < 7; i++)
    ledger = tx(
      ledger,
      `d${i}`,
      i === 0 ? 'income' : 'expense',
      s.shiftCalendarDate('2026-10-25', i),
      i === 0 ? '100' : '10',
    );
  const e = row(ledger, 'weekly_saver');
  assert.equal(e.qualified, true);
  assert.equal(e.evidence.netMinor, 4000);
  assert.equal(e.evidence.transactionCount, 7);
  ledger = tx(ledger, 'debt', 'debt', '2026-10-31', '40');
  assert.equal(row(ledger, 'weekly_saver').qualified, false);
  assert.equal(row(ledger, 'weekly_saver').progress.current, 7);
  assert.match(row(ledger, 'weekly_saver').reason, /positive/);
  const negative = tx(ledger, 'extra', 'expense', '2026-10-31', '1');
  assert.equal(row(negative, 'weekly_saver').qualified, false);
  assert.equal(row(m.deleteTransaction(ledger, 'd3'), 'weekly_saver').qualified, false);
  assert.equal(
    row(m.deleteTransaction(ledger, 'debt'), 'weekly_saver', clock('2026-10-31')).qualified,
    false,
  );
});

test('weekly saver considers later rolling windows and leap/year calendar continuity', () => {
  for (const start of ['2024-02-26', '2026-12-28']) {
    let ledger = fresh('2024-01-01');
    for (let i = 0; i < 8; i++)
      ledger = tx(
        ledger,
        `t${i}`,
        i === 7 ? 'income' : 'expense',
        s.shiftCalendarDate(start, i),
        i === 7 ? '100' : '10',
      );
    const end = s.shiftCalendarDate(start, 8),
      e = row(ledger, 'weekly_saver', clock(end));
    assert.equal(e.qualified, true);
    assert.equal(e.evidence.startDate, s.shiftCalendarDate(start, 1));
    assert.equal(e.evidence.netMinor, 4000);
  }
});

test('budget master uses all monthly budgets in completed month with matching expenses', () => {
  let ledger = budget(fresh());
  ledger = budget(ledger, 'transport', '50', '2026-10-01', 'month', 'expense-transport');
  assert.equal(row(ledger, 'budget_master').qualified, false);
  ledger = tx(ledger, 'food', 'expense', '2026-10-20', '100');
  assert.equal(row(ledger, 'budget_master', clock('2026-10-31')).qualified, false);
  const earned = row(ledger, 'budget_master');
  assert.equal(earned.qualified, true);
  assert.equal(earned.evidence.budgetCount, 2);
  assert.equal(earned.evidence.totalSpentMinor, 10000);
  ledger = tx(ledger, 'train', 'expense', '2026-10-21', '51', 'expense-transport');
  assert.equal(row(ledger, 'budget_master').qualified, false);
  let onlyOther = budget(fresh(), 'weekly', '100', '2026-10-20', 'week');
  onlyOther = budget(onlyOther, 'yearly', '1000', '2026-01-01', 'year');
  onlyOther = tx(onlyOther, 'food', 'expense', '2026-10-20', '10');
  assert.equal(row(onlyOther, 'budget_master').qualified, false);
  let wrongType = budget(fresh());
  wrongType = tx(wrongType, 'income', 'income', '2026-10-20', '100');
  wrongType = tx(wrongType, 'debt', 'debt', '2026-10-20', '20');
  assert.equal(row(wrongType, 'budget_master').qualified, false);
});

test('expense and any-entry streaks count dates and preserve gaps/type distinctions', () => {
  let ledger = fresh();
  for (let i = 0; i < 5; i++)
    ledger = tx(ledger, `e${i}`, 'expense', s.shiftCalendarDate('2026-10-25', i));
  assert.equal(row(ledger, 'expense_tracker').qualified, true);
  assert.equal(row(ledger, 'consistent_tracker').qualified, false);
  ledger = tx(ledger, 'income', 'income', '2026-10-30');
  ledger = tx(ledger, 'debt', 'debt', '2026-10-31');
  assert.equal(row(ledger, 'consistent_tracker').qualified, true);
  const gap = m.deleteTransaction(ledger, 'e2');
  assert.equal(row(gap, 'expense_tracker').qualified, false);
  assert.equal(row(gap, 'consistent_tracker').qualified, false);
  let oneDay = fresh();
  for (let i = 0; i < 10; i++) oneDay = tx(oneDay, `same${i}`, 'expense', '2026-11-02');
  assert.equal(row(oneDay, 'expense_tracker').progress.current, 1);
  assert.equal(row(oneDay, 'consistent_tracker').qualified, false);
  let future = fresh();
  for (let i = 0; i < 7; i++)
    future = tx(future, `f${i}`, 'expense', s.shiftCalendarDate('2026-11-01', i));
  assert.equal(row(future, 'expense_tracker').qualified, false);
  assert.equal(row(future, 'consistent_tracker').qualified, false);
});

test('goal award uses recorded through-today balance including debt, never future salary', () => {
  let ledger = goal(fresh());
  ledger = tx(ledger, 'out', 'debt', '2026-11-01', '10');
  ledger = tx(ledger, 'future', 'income', '2026-11-03', '1000');
  assert.equal(m.goalProgress(ledger).status, 'exceeded');
  assert.equal(row(ledger, 'savings_goal_achiever').qualified, false);
  assert.match(row(ledger, 'savings_goal_achiever').reason, /-RM10.00/);
  ledger = tx(ledger, 'today', 'income', '2026-11-02', '110');
  assert.equal(row(ledger, 'savings_goal_achiever').evidence.balanceMinor, 10000);
  assert.equal(row(m.deleteGoal(ledger), 'savings_goal_achiever').qualified, false);
});

test('no-spend needs explicit prior-day action; income allowed, expense/debt blocked', () => {
  const base = tx(fresh(), 'income', 'income', '2026-10-31', '100');
  assert.equal(row(base, 'no_spend_day').qualified, false);
  const candidate = a.recordCompletedDay(base, '2026-10-31', clock());
  assert.equal(base.achievements.completedDays.length, 0);
  assert.equal(candidate.achievements.completedDays.length, 1);
  assert.equal(row(candidate, 'no_spend_day').qualified, true);
  assert.equal(row(candidate, 'no_spend_day').award, null);
  assert.equal(a.recordCompletedDay(candidate, '2026-10-31', clock('2026-11-03')), candidate);
  for (const date of ['2026-11-02', '2026-11-03', '2026-09-30', '2026-02-30'])
    assert.throws(() => a.recordCompletedDay(base, date, clock()), /completed day/);
  for (const type of ['expense', 'debt'])
    assert.throws(
      () => a.recordCompletedDay(tx(base, type, type, '2026-10-31'), '2026-10-31', clock()),
      /outflow|expense or debt/,
    );
  const laterExpense = tx(candidate, 'later-expense', 'expense', '2026-10-31');
  assert.equal(row(laterExpense, 'no_spend_day').qualified, false);
  const earned = a.reconcileAchievements(candidate, clock()).ledger;
  assert.ok(row(tx(earned, 'correction', 'expense', '2026-10-31'), 'no_spend_day').award);
});

test('completed-day rolling limit is calendar based and retains durable awards', () => {
  let ledger = fresh('2024-01-01');
  const now = clock('2026-11-02');
  assert.throws(() => a.recordCompletedDay(ledger, s.shiftCalendarDate(now.today, -367), now));
  ledger = a.recordCompletedDay(ledger, s.shiftCalendarDate(now.today, -366), now);
  ledger = a.reconcileAchievements(ledger, now).ledger;
  const award = ledger.achievements.awards.find((x) => x.id === 'no_spend_day');
  const events = [];
  for (let i = 366; i >= 1; i--)
    events.push({ date: s.shiftCalendarDate(now.today, -i), confirmedAtMs: now.nowMs });
  ledger = m.validateLedger({
    ...ledger,
    achievements: { ...ledger.achievements, completedDays: events },
  });
  ledger = a.recordCompletedDay(ledger, '2026-11-02', clock('2026-11-03'));
  assert.equal(ledger.achievements.completedDays.length, 366);
  assert.equal(ledger.achievements.completedDays[0].date, s.shiftCalendarDate(now.today, -365));
  assert.deepEqual(
    ledger.achievements.awards.find((x) => x.id === 'no_spend_day'),
    award,
  );
});

test('category guru uses distinct stable IDs, including income/debt, not rename or duplicates', () => {
  let ledger = fresh();
  const categories = [
    'income-salary',
    'income-other',
    'debt-loan',
    'expense-food',
    'expense-transport',
    'expense-bills',
  ];
  for (let i = 0; i < categories.length; i++)
    ledger = tx(
      ledger,
      `t${i}`,
      ledger.categories.find((c) => c.id === categories[i]).type,
      '2026-10-20',
      '10',
      categories[i],
    );
  assert.equal(row(ledger, 'category_guru').qualified, true);
  assert.equal(row(ledger, 'category_guru').evidence.distinctCategoryCount, 6);
  ledger = m.renameCategory(ledger, 'expense-food', 'Meals');
  assert.equal(row(ledger, 'category_guru').evidence.distinctCategoryCount, 6);
  assert.equal(row(m.deleteTransaction(ledger, 't5'), 'category_guru').qualified, false);
  let future = tx(
    m.deleteTransaction(ledger, 't5'),
    'future',
    'expense',
    '2026-11-03',
    '10',
    'expense-bills',
  );
  assert.equal(row(future, 'category_guru').qualified, false);
});

test('review expert requires four explicit current-week completions, not repeat visits or a skipped week', () => {
  let ledger = fresh();
  for (const date of ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']) {
    const time = clock(date);
    ledger = a.completeWeeklyReview(ledger, time);
    assert.equal(a.completeWeeklyReview(ledger, time), ledger);
  }
  assert.equal(row(ledger, 'review_expert').qualified, true);
  assert.deepEqual(row(ledger, 'review_expert').evidence.weekStarts, [
    '2026-10-05',
    '2026-10-12',
    '2026-10-19',
    '2026-10-26',
  ]);
  const missing = {
    ...ledger,
    achievements: {
      ...ledger.achievements,
      weeklyReviews: ledger.achievements.weeklyReviews.filter((r) => r.weekStart !== '2026-10-12'),
    },
  };
  assert.equal(row(missing, 'review_expert').qualified, false);
  assert.equal(row(ledger, 'review_expert', clock('2026-10-20')).qualified, false);
  assert.equal(a.weeklyReviewSummary(ledger, clock('2026-10-11')).weekStart, '2026-10-05');
  assert.equal(a.weeklyReviewSummary(ledger, clock('2026-10-12')).weekStart, '2026-10-12');
});

test('weekly review uses shared truthful week and full-plan facts with future entries excluded', () => {
  let ledger = fresh('2026-01-01');
  ledger = budget(ledger, 'month', '100', '2026-10-01');
  ledger = budget(ledger, 'week', '50', '2026-10-28', 'week');
  ledger = budget(ledger, 'year', '1000', '2026-01-01', 'year');
  ledger = budget(ledger, 'next-month', '200', '2026-11-01');
  ledger = budget(ledger, 'old-week', '30', '2026-10-19', 'week');
  for (const entry of [
    ['old', 'expense', '2026-10-01', '10'],
    ['mon', 'expense', '2026-10-26', '20'],
    ['today', 'expense', '2026-10-28', '5'],
    ['debt', 'debt', '2026-10-27', '7'],
    ['future', 'expense', '2026-10-30', '100'],
  ])
    ledger = tx(ledger, ...entry);
  const time = clock('2026-10-28'),
    summary = a.weeklyReviewSummary(ledger, time);
  assert.equal(summary.weekStart, '2026-10-26');
  assert.equal(summary.weekEnd, '2026-11-01');
  assert.equal(summary.expenseMinor, 2500);
  assert.equal(summary.debtMinor, 700);
  assert.equal(summary.transactionCount, 3);
  assert.equal(summary.budgetCount, 4);
  assert.equal(summary.budgets.find((b) => b.budgetId === 'month').spentMinor, 3500);
  assert.equal(summary.budgets.find((b) => b.budgetId === 'week').spentMinor, 2500);
  assert.equal(summary.budgets.find((b) => b.budgetId === 'next-month').spentMinor, 0);
  assert.equal(summary.budgets.find((b) => b.budgetId === 'next-month').throughDate, '2026-10-28');
  const completed = a.completeWeeklyReview(ledger, time),
    record = completed.achievements.weeklyReviews[0];
  assert.deepEqual(record, {
    weekStart: summary.weekStart,
    completedOnDate: time.today,
    completedAtMs: time.nowMs,
    expenseMinor: 2500,
    debtMinor: 700,
    budgetCount: 4,
  });
  const changed = tx(completed, 'later', 'expense', '2026-10-28', '2');
  assert.deepEqual(a.weeklyReviewSummary(changed, time).completedReview, record);
});

test('review calendar handles year/leap boundaries; event cap retains the latest 104 weeks', () => {
  let ledger = fresh('2023-01-01');
  assert.equal(a.weeklyReviewSummary(ledger, clock('2027-01-01')).weekStart, '2026-12-28');
  assert.equal(a.weeklyReviewSummary(ledger, clock('2024-02-29')).weekStart, '2024-02-26');
  for (let i = 0; i < 105; i++)
    ledger = a.completeWeeklyReview(ledger, clock(s.shiftCalendarDate('2024-01-01', i * 7)));
  assert.equal(ledger.achievements.weeklyReviews.length, 104);
  assert.equal(ledger.achievements.weeklyReviews[0].weekStart, '2024-01-08');
});

test('reconciliation is immutable and durable evidence survives edits/deletes without re-awarding', () => {
  const initial = tx(fresh(), 'salary', 'income', '2026-10-01', '100');
  const before = JSON.stringify(initial);
  const first = a.reconcileAchievements(freeze(initial), clock());
  assert.equal(first.changed, true);
  assert.equal(first.newAwards.length, 1);
  assert.equal(JSON.stringify(initial), before);
  const award = first.newAwards[0];
  assert.equal(award.earnedOnDate, '2026-11-02');
  assert.equal(award.earnedAtMs, clock().nowMs);
  assert.equal(award.evidence.date, '2026-10-01');
  assert.equal(a.reconcileAchievements(first.ledger, clock('2026-11-03')).changed, false);
  const empty = m.deleteTransaction(first.ledger, 'salary');
  assert.equal(row(empty, 'first_transaction').qualified, false);
  assert.deepEqual(row(empty, 'first_transaction').award, award);
  assert.equal(a.reconcileAchievements(empty, clock()).newAwards.length, 0);
});

test('sample mode is preview only with no award, check-in, review or notice writes', () => {
  const sample = m.createDemoLedger(new Date(2026, 9, 17), {
    clock: clock('2026-10-01'),
    newIncarnationId: () => 'sample-instance',
  });
  const evaluated = a.evaluateAchievements(sample, clock());
  assert.ok(evaluated.every((x) => x.preview && !x.award));
  assert.equal(evaluated.find((x) => x.id === 'first_transaction').qualified, true);
  assert.equal(a.reconcileAchievements(sample, clock()).ledger, sample);
  assert.throws(() => a.recordCompletedDay(sample, '2026-10-31', clock()), /preview/);
  assert.throws(() => a.completeWeeklyReview(sample, clock()), /preview/);
  assert.deepEqual(a.currentFinancialMilestoneKeys(sample, clock()), []);
  assert.deepEqual(a.financialMilestoneEvents(sample, sample, clock()), []);
});

test('budget notices are exact-period dated-through-today transitions, not rename/rerender noise', () => {
  let before = budget(fresh());
  before = tx(before, 'future', 'expense', '2026-11-03', '200');
  assert.deepEqual(a.currentFinancialMilestoneKeys(before, clock()), []);
  let after = tx(before, 'actual', 'expense', '2026-10-31', '101');
  const events = a.financialMilestoneEvents(before, after, clock());
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'budget');
  assert.match(events[0].body, /RM101.00/);
  assert.deepEqual(
    a.currentFinancialMilestoneKeys(after, clock()),
    events.map((e) => e.key),
  );
  assert.deepEqual(
    a.financialMilestoneEvents(after, m.renameCategory(after, 'expense-food', 'Meals'), clock()),
    [],
  );
  assert.deepEqual(
    a.financialMilestoneEvents(after, tx(after, 'more', 'expense', '2026-10-31', '10'), clock()),
    [],
  );
  const newOwner = {
    ...after,
    wallet: { ...after.wallet, incarnationId: 'other' },
    achievements: { ...after.achievements, ownerIncarnationId: 'other' },
  };
  assert.deepEqual(a.financialMilestoneEvents(before, newOwner, clock()), []);
});

test('goal notice thresholds use integer units; direct reach skips near and decreases do not create near', () => {
  const base = goal(fresh());
  const below = tx(base, 'salary', 'income', '2026-10-31', '89.99');
  const near = tx(below, 'extra', 'income', '2026-11-02', '0.01');
  let events = a.financialMilestoneEvents(below, near, clock());
  assert.equal(events.length, 1);
  assert.ok(events[0].key.endsWith(':near'));
  const reached = tx(near, 'more', 'income', '2026-11-02', '10');
  events = a.financialMilestoneEvents(near, reached, clock());
  assert.equal(events.length, 1);
  assert.ok(events[0].key.endsWith(':reached'));
  const jump = tx(base, 'jump', 'income', '2026-11-02', '120');
  assert.equal(a.financialMilestoneEvents(base, jump, clock()).length, 1);
  assert.ok(a.financialMilestoneEvents(base, jump, clock())[0].key.endsWith(':reached'));
  const lowered = tx(jump, 'cost', 'debt', '2026-11-02', '25');
  assert.deepEqual(a.financialMilestoneEvents(jump, lowered, clock()), []);
  assert.equal(a.currentFinancialMilestoneKeys(jump, clock()).length, 2);
  const future = tx(base, 'future', 'income', '2026-11-03', '1000');
  assert.deepEqual(a.financialMilestoneEvents(base, future, clock()), []);
  const negative = tx(base, 'debt', 'debt', '2026-11-02', '50');
  assert.deepEqual(a.financialMilestoneEvents(base, negative, clock()), []);
});

test('goal target identity changes distinctly and returning to same target reuses dedupe keys', () => {
  const initial = tx(goal(fresh(), '200'), 'income', 'income', '2026-11-02', '100');
  const low = goal(initial, '100');
  const first = a.financialMilestoneEvents(initial, low, clock());
  assert.equal(first.length, 1);
  const high = goal(low, '200');
  assert.deepEqual(a.financialMilestoneEvents(low, high, clock()), []);
  const again = goal(high, '100');
  assert.equal(a.financialMilestoneEvents(high, again, clock())[0].key, first[0].key);
});

test('achievement descriptors require newly committed evidence, not current qualification alone', () => {
  const before = fresh(),
    qualifying = tx(before, 'income', 'income', '2026-11-02', '100');
  assert.deepEqual(a.financialMilestoneEvents(before, qualifying, clock()), []);
  const committed = a.reconcileAchievements(qualifying, clock()).ledger;
  const events = a.financialMilestoneEvents(before, committed, clock());
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'achievement');
  assert.deepEqual(
    a.currentFinancialMilestoneKeys(committed, clock()),
    events.map((e) => e.key),
  );
  assert.deepEqual(a.financialMilestoneEvents(committed, committed, clock()), []);
});

test('clock and malformed ledger failures are explicit; injected dates do not mutate OS time', () => {
  const ledger = fresh();
  for (const invalid of [
    { today: '2026-02-30', nowMs: 1 },
    { today: '2026-11-02', nowMs: NaN },
    { today: '2026-11-02', nowMs: 1.5 },
  ])
    assert.throws(() => a.evaluateAchievements(ledger, invalid));
  assert.throws(() => a.captureAchievementClock(Infinity));
  assert.equal(a.captureAchievementClock(new Date(2026, 10, 2, 12).getTime()).today, '2026-11-02');
  assert.throws(() => a.reconcileAchievements(ledger, clock('2026-09-30')), /before/);
  assert.throws(() => a.evaluateAchievements({ ...ledger, version: 99 }, clock()));
  assert.throws(() => a.completeWeeklyReview(ledger, clock('2026-09-30')), /before/);
});

test('independent complete fixture earns all ten validated evidence records without inventing activity', () => {
  let ledger = goal(budget(fresh(), 'food', '1000'), '100');
  ledger = tx(ledger, 'salary', 'income', '2026-10-05', '1000');
  const categories = [
    'expense-food',
    'expense-transport',
    'expense-bills',
    'expense-shopping',
    'expense-health',
    'expense-other',
    'expense-food',
  ];
  for (let i = 0; i < 7; i++)
    ledger = tx(
      ledger,
      `d${i}`,
      'expense',
      s.shiftCalendarDate('2026-10-05', i),
      '10',
      categories[i],
    );
  ledger = a.recordCompletedDay(ledger, '2026-10-31', clock());
  for (const date of ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'])
    ledger = a.completeWeeklyReview(ledger, clock(date));
  const result = a.reconcileAchievements(ledger, clock());
  assert.equal(result.newAwards.length, 10);
  assert.ok(result.evaluations.every((e) => e.qualified && e.award));
  assert.equal(m.validateLedger(result.ledger), result.ledger);
  assert.deepEqual(JSON.parse(JSON.stringify(result.ledger)), result.ledger);
  assert.equal(a.reconcileAchievements(result.ledger, clock()).changed, false);
  for (const awarded of result.newAwards) {
    const corrupt = {
      ...result.ledger,
      achievements: {
        ...result.ledger.achievements,
        awards: result.ledger.achievements.awards.map((item) =>
          item.id === awarded.id
            ? { ...item, evidence: { ...item.evidence, kind: 'unknown' } }
            : item,
        ),
      },
    };
    assert.throws(() => m.validateLedger(corrupt), /achievement/);
  }
});

test('same-period future spending and fractional 90 percent thresholds do not trigger early', () => {
  const initial = budget(fresh(), 'november', '100', '2026-11-01');
  const future = tx(initial, 'future', 'expense', '2026-11-03', '200');
  assert.deepEqual(a.financialMilestoneEvents(initial, future, clock()), []);
  assert.deepEqual(a.currentFinancialMilestoneKeys(future, clock()), []);
  const tiny = goal(fresh(), '0.11');
  const nine = tx(tiny, 'nine', 'income', '2026-11-02', '0.09');
  assert.deepEqual(a.financialMilestoneEvents(tiny, nine, clock()), []);
  const ten = tx(nine, 'one', 'income', '2026-11-02', '0.01');
  assert.equal(a.financialMilestoneEvents(nine, ten, clock()).length, 1);
});
