const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/core/model');

function add(ledger, id, type, amount, date, categoryId) {
  const defaults = { income: 'income-salary', expense: 'expense-food', debt: 'debt-loan' };
  return model.saveTransaction(
    ledger,
    model.transactionFromDraft(
      {
        type,
        amount,
        date,
        title: id,
        categoryId: categoryId ?? defaults[type],
      },
      id,
      ledger,
    ),
  );
}

function makeBudget(ledger, id = 'budget-food', changes = {}) {
  return model.budgetFromDraft(
    {
      categoryId: 'expense-food',
      amount: '100',
      period: 'month',
      anchorDate: '2026-10-17',
      ...changes,
    },
    id,
    ledger,
  );
}

function withGoal(ledger, amount = '1000') {
  return model.saveGoal(
    ledger,
    model.goalFromDraft({ kind: 'emergencyFund', amount }, 'savings-goal', ledger),
  );
}

function financialFixture() {
  let ledger = model.createEmptyLedger();
  for (const row of [
    ['salary', 'income', '1000', '2026-10-01'],
    ['food-october', 'expense', '80', '2026-10-17'],
    ['food-september', 'expense', '50', '2026-09-30'],
    ['food-november', 'expense', '20', '2026-11-01'],
    ['transport', 'expense', '30', '2026-10-31', 'expense-transport'],
    ['debt', 'debt', '40', '2026-10-31'],
  ])
    ledger = add(ledger, ...row);
  return ledger;
}

test('budget weeks are inclusive Monday to Sunday across month and year boundaries', () => {
  assert.deepEqual(model.periodBounds('week', '2026-10-12'), {
    startDate: '2026-10-12',
    endDate: '2026-10-18',
  });
  assert.deepEqual(model.periodBounds('week', '2026-10-18'), {
    startDate: '2026-10-12',
    endDate: '2026-10-18',
  });
  assert.deepEqual(model.periodBounds('week', '2026-11-01'), {
    startDate: '2026-10-26',
    endDate: '2026-11-01',
  });
  assert.deepEqual(model.periodBounds('week', '2027-01-01'), {
    startDate: '2026-12-28',
    endDate: '2027-01-03',
  });
  assert.deepEqual(model.periodBounds('week', '1900-01-01'), {
    startDate: '1900-01-01',
    endDate: '1900-01-07',
  });
});

test('calendar budget months and years handle leap day without rolling into another period', () => {
  assert.deepEqual(model.periodBounds('month', '2024-02-29'), {
    startDate: '2024-02-01',
    endDate: '2024-02-29',
  });
  assert.deepEqual(model.periodBounds('month', '2023-02-01'), {
    startDate: '2023-02-01',
    endDate: '2023-02-28',
  });
  assert.deepEqual(model.periodBounds('month', '2026-12-31'), {
    startDate: '2026-12-01',
    endDate: '2026-12-31',
  });
  assert.deepEqual(model.periodBounds('year', '2024-02-29'), {
    startDate: '2024-01-01',
    endDate: '2024-12-31',
  });
  assert.throws(() => model.periodBounds('month', '2023-02-29'), /valid date/);
  assert.throws(() => model.periodBounds('quarter', '2026-10-17'), /week, month, or year/);
  assert.throws(() => model.periodBounds('week', '2100-12-31'), /complete budget period/);
});

test('budget spending filters exact category, expense type, and inclusive date bounds', () => {
  const ledger = financialFixture();
  const budget = makeBudget(ledger);
  assert.deepEqual(model.budgetProgress(ledger, budget), {
    spentMinor: 8000,
    remainingMinor: 2000,
    overMinor: 0,
    percent: 80,
    progress: 0.8,
    status: 'under',
    transactionCount: 1,
  });
  assert.equal(model.totals(ledger).balance, 78000);
  assert.equal(model.periodTotals(ledger, '2026-10-01', '2026-10-31').balance, 85000);
});

test('both budget endpoints count while immediately adjacent dates do not', () => {
  let ledger = model.createEmptyLedger();
  for (const [id, amount, date] of [
    ['before', '1', '2026-10-11'],
    ['monday', '2', '2026-10-12'],
    ['sunday', '4', '2026-10-18'],
    ['after', '8', '2026-10-19'],
  ])
    ledger = add(ledger, id, 'expense', amount, date);
  const budget = makeBudget(ledger, 'weekly', { period: 'week' });
  assert.equal(model.budgetProgress(ledger, budget).spentMinor, 600);
  assert.equal(model.budgetProgress(ledger, budget).transactionCount, 2);
});

test('editing transaction amount, date, and category recalculates budgets without stored stale totals', () => {
  let ledger = financialFixture();
  ledger = model.saveBudget(ledger, makeBudget(ledger));
  const edit = (changes) =>
    model.saveTransaction(
      ledger,
      {
        ...ledger.transactions.find((item) => item.id === 'food-october'),
        ...changes,
      },
      true,
    );
  ledger = edit({ amountMinor: 12000 });
  assert.equal(model.budgetProgress(ledger, ledger.budgets[0]).overMinor, 2000);
  assert.equal(model.budgetProgress(ledger, ledger.budgets[0]).progress, 1);
  assert.equal(model.budgetProgress(ledger, ledger.budgets[0]).percent, 120);
  assert.equal(model.totals(ledger).balance, 74000);
  ledger = edit({ date: '2026-11-02' });
  assert.equal(model.budgetProgress(ledger, ledger.budgets[0]).spentMinor, 0);
  ledger = edit({ date: '2026-10-17', categoryId: 'expense-transport' });
  assert.equal(model.budgetProgress(ledger, ledger.budgets[0]).spentMinor, 0);
  ledger = model.deleteTransaction(ledger, 'food-october');
  assert.equal(model.totals(ledger).balance, 86000);
});

test('same category can have overlapping week/month/year budgets but no exact period duplicates', () => {
  let ledger = model.createEmptyLedger();
  ledger = model.saveBudget(ledger, makeBudget(ledger));
  ledger = model.saveBudget(ledger, makeBudget(ledger, 'weekly', { period: 'week' }));
  ledger = model.saveBudget(ledger, makeBudget(ledger, 'yearly', { period: 'year' }));
  ledger = model.saveBudget(ledger, makeBudget(ledger, 'november', { anchorDate: '2026-11-17' }));
  ledger = model.saveBudget(
    ledger,
    makeBudget(ledger, 'transport', { categoryId: 'expense-transport' }),
  );
  assert.equal(ledger.budgets.length, 5);
  assert.throws(
    () => model.saveBudget(ledger, makeBudget(ledger, 'duplicate', { anchorDate: '2026-10-01' })),
    /already exists for this category and period/,
  );
  assert.throws(
    () => model.saveBudget(ledger, makeBudget(ledger, 'november'), true),
    /already exists for this category and period/,
  );
  const updated = model.saveBudget(
    ledger,
    makeBudget(ledger, 'budget-food', { amount: '150' }),
    true,
  );
  assert.equal(updated.budgets.find((item) => item.id === 'budget-food').plannedMinor, 15000);
  assert.equal(ledger.budgets.find((item) => item.id === 'budget-food').plannedMinor, 10000);
  assert.equal(model.deleteBudget(updated, 'budget-food').budgets.length, 4);
});

test('budget references survive category rename and block category deletion even before spending', () => {
  let ledger = model.createCategory(model.createEmptyLedger(), {
    id: 'custom-food',
    name: 'Dining',
    type: 'expense',
  });
  ledger = model.saveBudget(
    ledger,
    makeBudget(ledger, 'custom-budget', { categoryId: 'custom-food' }),
  );
  assert.throws(() => model.deleteCategory(ledger, 'custom-food'), /used by a budget/);
  ledger = model.renameCategory(ledger, 'custom-food', 'Eating out');
  assert.equal(ledger.budgets[0].categoryId, 'custom-food');
  assert.equal(
    ledger.categories.find((item) => item.id === ledger.budgets[0].categoryId).name,
    'Eating out',
  );
  ledger = model.deleteBudget(ledger, 'custom-budget');
  assert.equal(
    model
      .deleteCategory(ledger, 'custom-food')
      .categories.some((item) => item.id === 'custom-food'),
    false,
  );
});

test('budget validation rejects income/debt categories, noncanonical dates, invalid amounts and missing IDs', () => {
  const ledger = model.createEmptyLedger();
  for (const categoryId of ['income-salary', 'debt-loan', 'missing']) {
    assert.throws(() => makeBudget(ledger, 'bad', { categoryId }), /expense category/);
  }
  for (const amount of ['0', '-100', '0.001', 'Infinity'])
    assert.throws(() => makeBudget(ledger, 'bad', { amount }));
  const budget = makeBudget(ledger);
  assert.throws(() => model.saveBudget(ledger, { ...budget, startDate: '2026-10-02' }), /invalid/);
  assert.throws(() => model.saveBudget(ledger, { ...budget, endDate: '2026-11-01' }), /invalid/);
  assert.throws(
    () => model.saveBudget(ledger, { ...budget, walletId: 'different-wallet' }),
    /invalid/,
  );
  assert.throws(() => model.saveBudget(ledger, budget, true), /no longer exists/);
  assert.throws(() => model.deleteBudget(ledger, 'missing'), /no longer exists/);
});

test('budget status distinguishes no spending, exact limit, and overspending', () => {
  let ledger = model.createEmptyLedger();
  const budget = makeBudget(ledger);
  assert.equal(model.budgetProgress(ledger, budget).status, 'under');
  assert.equal(model.budgetProgress(ledger, budget).percent, 0);
  ledger = add(ledger, 'at-limit', 'expense', '100', '2026-10-17');
  assert.equal(model.budgetProgress(ledger, budget).status, 'at');
  assert.equal(model.budgetProgress(ledger, budget).remainingMinor, 0);
  ledger = add(ledger, 'one-sen-over', 'expense', '0.01', '2026-10-17');
  assert.equal(model.budgetProgress(ledger, budget).status, 'over');
  assert.equal(model.budgetProgress(ledger, budget).overMinor, 1);
  assert.equal(model.budgetProgress(ledger, budget).remainingMinor, 0);
});

test('a missing goal is normal and does not block totals or budgets', () => {
  const ledger = financialFixture();
  assert.equal(model.goalProgress(ledger), null);
  assert.equal(model.deleteGoal(ledger), ledger);
  assert.equal(model.totals(ledger).balance, 78000);
  assert.equal(model.budgetProgress(ledger, makeBudget(ledger)).spentMinor, 8000);
});

test('goal progress uses wallet balance and keeps target separate from spending budget', () => {
  const ledger = withGoal(financialFixture());
  assert.deepEqual(model.goalProgress(ledger), {
    balanceMinor: 78000,
    targetMinor: 100000,
    remainingMinor: 22000,
    excessMinor: 0,
    percent: 78,
    progress: 0.78,
    status: 'in-progress',
  });
  const updated = model.saveGoal(
    ledger,
    model.goalFromDraft({ kind: 'home', amount: '2000' }, ledger.goal.id, ledger),
  );
  assert.equal(model.goalProgress(updated).percent, 39);
  assert.equal(model.goalProgress(updated).remainingMinor, 122000);
  assert.equal(model.totals(updated).balance, 78000);
  assert.equal(ledger.goal.targetMinor, 100000);
});

test('negative and zero balances have explicit goal states without hidden deficits or invalid percentages', () => {
  let ledger = withGoal(model.createEmptyLedger());
  assert.deepEqual(model.goalProgress(ledger), {
    balanceMinor: 0,
    targetMinor: 100000,
    remainingMinor: 100000,
    excessMinor: 0,
    percent: 0,
    progress: 0,
    status: 'not-started',
  });
  ledger = add(ledger, 'expense', 'expense', '200', '2026-10-17');
  assert.deepEqual(model.goalProgress(ledger), {
    balanceMinor: -20000,
    targetMinor: 100000,
    remainingMinor: 120000,
    excessMinor: 0,
    percent: 0,
    progress: 0,
    status: 'negative',
  });
});

test('goal reached and exceeded states show the actual amount while clamping only the progress bar', () => {
  let ledger = withGoal(model.createEmptyLedger());
  ledger = add(ledger, 'income', 'income', '1000', '2026-10-17');
  assert.equal(model.goalProgress(ledger).status, 'reached');
  ledger = add(ledger, 'extra-income', 'income', '200', '2026-10-17');
  assert.deepEqual(model.goalProgress(ledger), {
    balanceMinor: 120000,
    targetMinor: 100000,
    remainingMinor: 0,
    excessMinor: 20000,
    percent: 120,
    progress: 1,
    status: 'exceeded',
  });
  ledger = model.deleteTransaction(ledger, 'extra-income');
  assert.equal(model.goalProgress(ledger).status, 'reached');
  ledger = add(ledger, 'debt', 'debt', '50', '2026-10-17');
  assert.equal(model.goalProgress(ledger).status, 'in-progress');
  assert.equal(model.goalProgress(ledger).balanceMinor, 95000);
});

test('only one valid positive goal can exist and removal preserves all financial records', () => {
  const initial = financialFixture();
  assert.equal(model.GOAL_KINDS.length, 9);
  for (const amount of ['0', '-1', '10.001'])
    assert.throws(() => model.goalFromDraft({ kind: 'home', amount }, 'goal', initial));
  assert.throws(
    () => model.goalFromDraft({ kind: 'unknown', amount: '100' }, 'goal', initial),
    /Choose a savings goal/,
  );
  const ledger = withGoal(initial);
  assert.throws(
    () =>
      model.saveGoal(
        ledger,
        model.goalFromDraft({ kind: 'vacation', amount: '100' }, 'another-goal', ledger),
      ),
    /existing savings goal/,
  );
  const removed = model.deleteGoal(ledger);
  assert.equal(removed.goal, null);
  assert.deepEqual(removed.transactions, initial.transactions);
  assert.deepEqual(model.totals(removed), model.totals(initial));
});

test('plans lock wallet currency before any transactions and release it only when no monetary records remain', () => {
  const fresh = model.createEmptyLedger();
  assert.equal(model.canChangeCurrency(fresh), true);
  const budgeted = model.saveBudget(fresh, makeBudget(fresh));
  assert.equal(model.canChangeCurrency(budgeted), false);
  assert.throws(() => model.updateWallet(budgeted, { currency: 'JPY' }), /Currency cannot change/);
  const goalLedger = withGoal(fresh);
  assert.equal(model.canChangeCurrency(goalLedger), false);
  assert.throws(
    () => model.updateWallet(goalLedger, { currency: 'JPY' }),
    /Currency cannot change/,
  );
  assert.equal(model.canChangeCurrency(model.deleteBudget(budgeted, budgeted.budgets[0].id)), true);
  assert.equal(model.canChangeCurrency(model.deleteGoal(goalLedger)), true);
  assert.equal(
    model.updateWallet(goalLedger, { name: 'Renamed plan' }).wallet.name,
    'Renamed plan',
  );
});

test('JPY plans use whole yen consistently and explicit fresh reset clears both kinds of plan', () => {
  let ledger = model.createEmptyLedger({ currency: 'JPY' });
  ledger = model.saveBudget(ledger, makeBudget(ledger, 'yen-budget', { amount: '100' }));
  ledger = withGoal(ledger, '1000');
  ledger = add(ledger, 'salary', 'income', '1200', '2026-10-17');
  ledger = add(ledger, 'food', 'expense', '80', '2026-10-17');
  assert.equal(ledger.budgets[0].plannedMinor, 100);
  assert.equal(model.budgetProgress(ledger, ledger.budgets[0]).remainingMinor, 20);
  assert.equal(model.goalProgress(ledger).balanceMinor, 1120);
  assert.equal(model.goalProgress(ledger).excessMinor, 120);
  assert.throws(() => makeBudget(ledger, 'fractional-yen', { amount: '1.25' }), /whole-yen/);
  const reset = model.createEmptyLedger({ name: ledger.wallet.name, currency: 'MYR' });
  assert.deepEqual(reset.budgets, []);
  assert.equal(reset.goal, null);
  assert.equal(reset.transactions.length, 0);
  assert.equal(model.canChangeCurrency(reset), true);
  assert.equal(ledger.budgets.length, 1);
  assert.notEqual(ledger.goal, null);
});
