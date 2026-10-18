const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/core/model');
const a = require('../src/core/achievements');
const clock = (today) => ({ today, nowMs: Date.parse(`${today}T12:00:00Z`) });
const fresh = (today, id) =>
  m.createEmptyLedger({}, { clock: clock(today), newIncarnationId: () => id });

test('weekly review clips only the final supported calendar week and still records completion', () => {
  let ledger = fresh('2100-12-01', 'boundary-review');
  ledger = m.saveTransaction(
    ledger,
    m.transactionFromDraft(
      {
        type: 'expense',
        title: 'Final-year expense',
        categoryId: 'expense-food',
        amount: '12.34',
        date: '2100-12-31',
      },
      'boundary-expense',
      ledger,
    ),
  );
  const prior = a.weeklyReviewSummary(ledger, clock('2100-12-26'));
  assert.equal(prior.weekEnd, '2100-12-26');
  const early = a.weeklyReviewSummary(ledger, clock('2100-12-27'));
  assert.equal(early.weekStart, '2100-12-27');
  assert.equal(early.weekEnd, '2100-12-31');
  assert.equal(early.expenseMinor, 0);
  const summary = a.weeklyReviewSummary(ledger, clock('2100-12-31'));
  assert.equal(summary.expenseMinor, 1234);
  assert.equal(summary.throughDate, '2100-12-31');
  const completed = a.completeWeeklyReview(ledger, clock('2100-12-31'));
  assert.equal(m.validateLedger(completed), completed);
  assert.equal(completed.achievements.weeklyReviews[0].weekStart, '2100-12-27');
  assert.equal(completed.achievements.weeklyReviews[0].expenseMinor, 1234);
  assert.equal(a.completeWeeklyReview(completed, clock('2100-12-31')), completed);
  const first = a.weeklyReviewSummary(
    fresh('1900-01-01', 'first-calendar-review'),
    clock('1900-01-01'),
  );
  assert.equal(first.weekStart, '1900-01-01');
  assert.equal(first.weekEnd, '1900-01-07');
});

test('largest valid category/transaction/budget fixture retains exact validation and achievement facts', () => {
  const ledger = fresh('2026-01-01', 'largest-valid-ledger');
  ledger.wallet.hasTransactionHistory = true;
  for (let i = 0; i < m.MAX_TRANSACTIONS; i++) {
    const categoryId = `large-category-${i}`;
    ledger.categories.push({
      id: categoryId,
      name: `Category ${i}`,
      type: 'expense',
      isDefault: false,
    });
    ledger.transactions.push({
      id: `t${i}`,
      walletId: ledger.wallet.id,
      type: 'expense',
      title: `Expense ${i}`,
      categoryId,
      date: '2026-10-10',
      amountMinor: 1,
    });
    ledger.budgets.push({
      id: `b${i}`,
      walletId: ledger.wallet.id,
      categoryId,
      plannedMinor: 100,
      period: 'month',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
    });
  }
  assert.equal(m.validateLedger(ledger), ledger);
  const result = a.reconcileAchievements(ledger, clock('2026-11-02'));
  assert.equal(result.newAwards.length, 4);
  const budgetAward = result.newAwards.find((row) => row.id === 'budget_master');
  assert.equal(budgetAward.evidence.budgetCount, m.MAX_TRANSACTIONS);
  assert.equal(budgetAward.evidence.matchedExpenseCount, m.MAX_TRANSACTIONS);
  assert.equal(budgetAward.evidence.totalSpentMinor, m.MAX_TRANSACTIONS);
  assert.equal(budgetAward.evidence.totalPlannedMinor, m.MAX_TRANSACTIONS * 100);
  const categoryAward = result.newAwards.find((row) => row.id === 'category_guru');
  assert.equal(categoryAward.evidence.distinctCategoryCount, m.MAX_TRANSACTIONS);
  assert.equal(categoryAward.evidence.categoryIds.length, 6);
  assert.equal(a.reconcileAchievements(result.ledger, clock('2026-11-02')).changed, false);
  assert.equal(ledger.achievements.awards.length, 0);
  assert.throws(() =>
    m.validateLedger({
      ...ledger,
      transactions: [
        { ...ledger.transactions[0], categoryId: 'missing' },
        ...ledger.transactions.slice(1),
      ],
    }),
  );
  assert.throws(() =>
    m.validateLedger({
      ...ledger,
      budgets: [{ ...ledger.budgets[0], categoryId: 'income-salary' }, ...ledger.budgets.slice(1)],
    }),
  );
});

test('indexed category validation still rejects duplicates, invalid definitions, and type mismatches', () => {
  const ledger = fresh('2026-01-01', 'validation-guards');
  assert.throws(() =>
    m.validateLedger({
      ...ledger,
      categories: [...ledger.categories, { ...ledger.categories[0] }],
    }),
  );
  assert.throws(() =>
    m.validateLedger({
      ...ledger,
      categories: [{ ...ledger.categories[0], type: 'unknown' }, ...ledger.categories.slice(1)],
    }),
  );
  const invalidTransaction = {
    id: 'wrong-type',
    walletId: ledger.wallet.id,
    type: 'expense',
    title: 'Expense',
    categoryId: 'income-salary',
    date: '2026-10-10',
    amountMinor: 1,
  };
  assert.throws(() =>
    m.validateLedger({
      ...ledger,
      wallet: { ...ledger.wallet, hasTransactionHistory: true },
      transactions: [invalidTransaction],
    }),
  );
  const oldWithReservedIdentity = { ...ledger, version: 3 };
  const migrated = m.migrateLedger(oldWithReservedIdentity);
  assert.equal(migrated.wallet.incarnationId, ledger.wallet.incarnationId);
  assert.equal(migrated.achievements, ledger.achievements);
});
