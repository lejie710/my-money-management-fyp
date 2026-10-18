const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/core/model');
const { periodReport, monthlySeries } = require('../src/core/reports');

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

function reportFixture() {
  let ledger = model.createEmptyLedger();
  for (const row of [
    ['september-income', 'income', '1000', '2026-09-01'],
    ['september-food', 'expense', '200', '2026-09-15'],
    ['september-debt', 'debt', '50', '2026-09-30'],
    ['october-income', 'income', '2000', '2026-10-01'],
    ['october-food-first', 'expense', '120', '2026-10-15'],
    ['october-food-second', 'expense', '80', '2026-10-30'],
    ['october-transport', 'expense', '50', '2026-10-31', 'expense-transport'],
    ['october-debt', 'debt', '300', '2026-10-31'],
    ['november-income', 'income', '500', '2026-11-01'],
    ['november-food', 'expense', '20', '2026-11-01'],
  ])
    ledger = add(ledger, ...row);
  return ledger;
}

function assertReconciles(report) {
  assert.equal(report.outflowMinor, report.expenseMinor + report.debtMinor);
  assert.equal(report.netMinor, report.incomeMinor - report.outflowMinor);
  assert.equal(report.closingMinor, report.openingMinor + report.netMinor);
  let categoryCount = 0;
  for (const type of ['income', 'expense', 'debt']) {
    const entries = report.categoryBreakdown.filter((item) => item.type === type);
    assert.equal(
      entries.reduce((sum, item) => sum + item.amountMinor, 0),
      report[`${type}Minor`],
    );
    for (const entry of entries) {
      assert.equal(entry.typeTotalMinor, report[`${type}Minor`]);
      assert.equal(entry.shareOfType, entry.amountMinor / entry.typeTotalMinor);
      assert.ok(Number.isFinite(entry.shareOfType));
      categoryCount += entry.transactionCount;
    }
  }
  assert.equal(categoryCount, report.transactionCount);
  for (const [key, value] of Object.entries(report)) {
    if (key.endsWith('Minor')) assert.equal(Number.isSafeInteger(value), true, key);
  }
}

test('October report reconciles opening, activity, closing, and a separate all-record balance', () => {
  const report = periodReport(reportFixture(), '2026-10-01', '2026-10-31');
  assert.deepEqual(report, {
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    currency: 'MYR',
    openingMinor: 75000,
    incomeMinor: 200000,
    expenseMinor: 25000,
    debtMinor: 30000,
    outflowMinor: 55000,
    netMinor: 145000,
    closingMinor: 220000,
    currentBalanceMinor: 268000,
    transactionCount: 5,
    hasActivity: true,
    categoryBreakdown: [
      {
        categoryId: 'income-salary',
        categoryName: 'Salary',
        type: 'income',
        amountMinor: 200000,
        typeTotalMinor: 200000,
        shareOfType: 1,
        transactionCount: 1,
      },
      {
        categoryId: 'expense-food',
        categoryName: 'Food & beverages',
        type: 'expense',
        amountMinor: 20000,
        typeTotalMinor: 25000,
        shareOfType: 0.8,
        transactionCount: 2,
      },
      {
        categoryId: 'expense-transport',
        categoryName: 'Transport',
        type: 'expense',
        amountMinor: 5000,
        typeTotalMinor: 25000,
        shareOfType: 0.2,
        transactionCount: 1,
      },
      {
        categoryId: 'debt-loan',
        categoryName: 'Debt / loan',
        type: 'debt',
        amountMinor: 30000,
        typeTotalMinor: 30000,
        shareOfType: 1,
        transactionCount: 1,
      },
    ],
    ratios: {
      retainedNetToIncome: 0.725,
      expenseToIncome: 0.125,
      debtToIncome: 0.15,
      outflowToIncome: 0.275,
    },
  });
  assertReconciles(report);
});

test('partial October opens after the earlier salary and does not borrow that income for ratios', () => {
  const report = periodReport(reportFixture(), '2026-10-15', '2026-10-31');
  assert.equal(report.openingMinor, 275000);
  assert.equal(report.incomeMinor, 0);
  assert.equal(report.netMinor, -55000);
  assert.equal(report.closingMinor, 220000);
  assert.equal(report.currentBalanceMinor, 268000);
  assert.equal(report.transactionCount, 4);
  assert.deepEqual(report.ratios, {
    retainedNetToIncome: null,
    expenseToIncome: null,
    debtToIncome: null,
    outflowToIncome: null,
  });
  assertReconciles(report);
});

test('same-day ranges include the whole calendar day without timestamp midnight exclusions', () => {
  const report = periodReport(reportFixture(), '2026-10-31', '2026-10-31');
  assert.equal(report.openingMinor, 255000);
  assert.equal(report.expenseMinor, 5000);
  assert.equal(report.debtMinor, 30000);
  assert.equal(report.netMinor, -35000);
  assert.equal(report.closingMinor, 220000);
  assert.equal(report.transactionCount, 2);
  assertReconciles(report);
});

test('empty history has zero money, no categories, unavailable ratios, and no invented score', () => {
  const report = periodReport(model.createEmptyLedger(), '2026-10-01', '2026-10-31');
  for (const [key, value] of Object.entries(report)) {
    if (key.endsWith('Minor')) assert.equal(value, 0);
  }
  assert.equal(report.hasActivity, false);
  assert.equal(report.transactionCount, 0);
  assert.deepEqual(report.categoryBreakdown, []);
  assert.ok(Object.values(report.ratios).every((value) => value === null));
  assert.equal(Object.hasOwn(report, 'score'), false);
  assert.equal(Object.hasOwn(report, 'healthScore'), false);
  assertReconciles(report);
});

test('inactive periods carry their prior balance while future records affect only all-record balance', () => {
  let ledger = model.createEmptyLedger();
  ledger = add(ledger, 'june-income', 'income', '1000', '2026-06-01');
  ledger = add(ledger, 'june-debt', 'debt', '100', '2026-06-30');
  ledger = add(ledger, 'august-income', 'income', '200', '2026-08-01');
  const report = periodReport(ledger, '2026-07-01', '2026-07-31');
  assert.equal(report.openingMinor, 90000);
  assert.equal(report.closingMinor, 90000);
  assert.equal(report.currentBalanceMinor, 110000);
  assert.equal(report.hasActivity, false);
  assert.equal(report.netMinor, 0);
  assert.deepEqual(report.categoryBreakdown, []);
  assert.ok(Object.values(report.ratios).every((value) => value === null));
  const beforeHistory = periodReport(ledger, '2026-01-01', '2026-01-31');
  assert.equal(beforeHistory.openingMinor, 0);
  assert.equal(beforeHistory.closingMinor, 0);
  assert.equal(beforeHistory.currentBalanceMinor, 110000);
  assertReconciles(report);
});

test('debt-only activity is an outflow once, with unavailable income ratios', () => {
  let ledger = model.createEmptyLedger();
  ledger = add(ledger, 'opening-income', 'income', '500', '2026-09-30');
  ledger = add(ledger, 'payment', 'debt', '100', '2026-10-17');
  const report = periodReport(ledger, '2026-10-01', '2026-10-31');
  assert.equal(report.incomeMinor, 0);
  assert.equal(report.expenseMinor, 0);
  assert.equal(report.debtMinor, 10000);
  assert.equal(report.outflowMinor, 10000);
  assert.equal(report.closingMinor, 40000);
  assert.equal(report.categoryBreakdown[0].shareOfType, 1);
  assert.ok(Object.values(report.ratios).every((value) => value === null));
  assertReconciles(report);
});

test('negative retained cash and outflow ratios above one remain visible without clamping', () => {
  let ledger = model.createEmptyLedger();
  ledger = add(ledger, 'income', 'income', '1000', '2026-10-01');
  ledger = add(ledger, 'expense', 'expense', '800', '2026-10-17');
  ledger = add(ledger, 'debt', 'debt', '400', '2026-10-17');
  const report = periodReport(ledger, '2026-10-01', '2026-10-31');
  assert.equal(report.netMinor, -20000);
  assert.deepEqual(report.ratios, {
    retainedNetToIncome: -0.2,
    expenseToIncome: 0.8,
    debtToIncome: 0.4,
    outflowToIncome: 1.2,
  });
  assertReconciles(report);
});

test('category grouping uses stable identity and transaction type, not names or individual transactions', () => {
  let ledger = model.createEmptyLedger();
  ledger = model.createCategory(ledger, {
    id: 'food-income',
    name: 'Food & beverages',
    type: 'income',
  });
  ledger = add(ledger, 'food-income', 'income', '100', '2026-10-01', 'food-income');
  ledger = add(ledger, 'food-one', 'expense', '20', '2026-10-17');
  ledger = add(ledger, 'food-two', 'expense', '30', '2026-10-18');
  const report = periodReport(ledger, '2026-10-01', '2026-10-31');
  assert.equal(report.categoryBreakdown.length, 2);
  assert.equal(report.categoryBreakdown[0].categoryName, report.categoryBreakdown[1].categoryName);
  assert.notEqual(report.categoryBreakdown[0].categoryId, report.categoryBreakdown[1].categoryId);
  assert.equal(report.categoryBreakdown[1].amountMinor, 5000);
  assert.equal(report.categoryBreakdown[1].transactionCount, 2);
  assert.equal(report.categoryBreakdown[1].typeTotalMinor, 5000);
  assertReconciles(report);
});

test('renaming, editing and deleting transactions immediately changes report results without stale data', () => {
  let ledger = reportFixture();
  ledger = model.renameCategory(ledger, 'expense-food', 'Dining');
  const renamed = periodReport(ledger, '2026-10-01', '2026-10-31');
  assert.equal(
    renamed.categoryBreakdown.find((item) => item.categoryId === 'expense-food').categoryName,
    'Dining',
  );
  ledger = model.saveTransaction(
    ledger,
    { ...ledger.transactions.find((item) => item.id === 'october-food-first'), amountMinor: 22000 },
    true,
  );
  const edited = periodReport(ledger, '2026-10-01', '2026-10-31');
  assert.equal(edited.expenseMinor, 35000);
  assert.equal(edited.closingMinor, 210000);
  assert.equal(edited.currentBalanceMinor, 258000);
  ledger = model.deleteTransaction(ledger, 'october-food-first');
  const deleted = periodReport(ledger, '2026-10-01', '2026-10-31');
  assert.equal(deleted.expenseMinor, 13000);
  assert.equal(deleted.closingMinor, 232000);
  assert.equal(deleted.currentBalanceMinor, 280000);
  assertReconciles(deleted);
});

test('moving a salary before the selected range changes opening/activity but not closing', () => {
  let ledger = reportFixture();
  ledger = model.saveTransaction(
    ledger,
    { ...ledger.transactions.find((item) => item.id === 'october-income'), date: '2026-09-30' },
    true,
  );
  const report = periodReport(ledger, '2026-10-01', '2026-10-31');
  assert.equal(report.openingMinor, 275000);
  assert.equal(report.incomeMinor, 0);
  assert.equal(report.netMinor, -55000);
  assert.equal(report.closingMinor, 220000);
  assert.equal(report.currentBalanceMinor, 268000);
  assertReconciles(report);
});

test('report results do not depend on a budget or a savings target', () => {
  let ledger = reportFixture();
  const before = periodReport(ledger, '2026-10-01', '2026-10-31');
  ledger = model.saveBudget(
    ledger,
    model.budgetFromDraft(
      { categoryId: 'expense-food', amount: '100', period: 'month', anchorDate: '2026-10-17' },
      'food-budget',
      ledger,
    ),
  );
  ledger = model.saveGoal(
    ledger,
    model.goalFromDraft({ kind: 'home', amount: '5000' }, 'goal', ledger),
  );
  assert.deepEqual(periodReport(ledger, '2026-10-01', '2026-10-31'), before);
});

test('monthly series includes inactive months and carries balance continuously across year turn', () => {
  const ledger = reportFixture();
  const rows = monthlySeries(ledger, '2026-09-01', '2027-01-31');
  assert.deepEqual(
    rows.map((row) => row.month),
    ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01'],
  );
  assert.deepEqual(
    rows.map((row) => row.netMinor),
    [75000, 145000, 48000, 0, 0],
  );
  assert.deepEqual(
    rows.map((row) => row.closingMinor),
    [75000, 220000, 268000, 268000, 268000],
  );
  for (let index = 0; index < rows.length; index += 1) {
    assert.equal(rows[index].isPartialPeriod, false);
    assertReconciles(rows[index]);
    if (index > 0) assert.equal(rows[index].openingMinor, rows[index - 1].closingMinor);
    const { month, isPartialPeriod, ...report } = rows[index];
    assert.deepEqual(report, periodReport(ledger, report.startDate, report.endDate));
  }
  assert.equal(rows[3].hasActivity, false);
  assert.deepEqual(rows[3].categoryBreakdown, []);
});

test('monthly series clips partial first/last months and reconciles with the full explicit range', () => {
  const ledger = reportFixture();
  const rows = monthlySeries(ledger, '2026-09-15', '2026-11-01');
  assert.deepEqual(
    rows.map((row) => [row.startDate, row.endDate, row.isPartialPeriod]),
    [
      ['2026-09-15', '2026-09-30', true],
      ['2026-10-01', '2026-10-31', false],
      ['2026-11-01', '2026-11-01', true],
    ],
  );
  const report = periodReport(ledger, '2026-09-15', '2026-11-01');
  assert.equal(rows[0].openingMinor, report.openingMinor);
  assert.equal(rows.at(-1).closingMinor, report.closingMinor);
  for (const field of [
    'incomeMinor',
    'expenseMinor',
    'debtMinor',
    'outflowMinor',
    'netMinor',
    'transactionCount',
  ]) {
    assert.equal(
      rows.reduce((sum, row) => sum + row[field], 0),
      report[field],
      field,
    );
  }
  assert.ok(rows.every((row) => row.currentBalanceMinor === 268000));
  const oneDay = monthlySeries(ledger, '2026-10-15', '2026-10-15');
  assert.equal(oneDay.length, 1);
  assert.equal(oneDay[0].isPartialPeriod, true);
  assert.equal(oneDay[0].expenseMinor, 12000);
});

test('monthly calendar boundaries include leap day and never sort October before February', () => {
  let ledger = model.createEmptyLedger();
  ledger = add(ledger, 'february-before', 'expense', '1', '2024-02-28');
  ledger = add(ledger, 'leap-day', 'expense', '2', '2024-02-29');
  ledger = add(ledger, 'march-start', 'expense', '4', '2024-03-01');
  const rows = monthlySeries(ledger, '2024-02-01', '2024-10-31');
  assert.equal(rows.length, 9);
  assert.equal(rows[0].month, '2024-02');
  assert.equal(rows[0].endDate, '2024-02-29');
  assert.equal(rows[0].expenseMinor, 300);
  assert.equal(rows[1].expenseMinor, 400);
  assert.equal(rows.at(-1).month, '2024-10');
  assert.equal(periodReport(ledger, '2024-02-29', '2024-02-29').expenseMinor, 200);
});

test('JPY reports retain whole-yen units without introducing fictitious sen', () => {
  let ledger = model.createEmptyLedger({ currency: 'JPY' });
  ledger = add(ledger, 'opening', 'income', '500', '2026-09-30');
  ledger = add(ledger, 'income', 'income', '1000', '2026-10-01');
  ledger = add(ledger, 'expense', 'expense', '250', '2026-10-17');
  ledger = add(ledger, 'debt', 'debt', '100', '2026-10-31');
  const report = periodReport(ledger, '2026-10-01', '2026-10-31');
  assert.equal(report.currency, 'JPY');
  assert.equal(report.openingMinor, 500);
  assert.equal(report.netMinor, 650);
  assert.equal(report.closingMinor, 1150);
  assert.equal(model.formatMoney(report.closingMinor, report.currency), '¥1,150');
  assertReconciles(report);
});

test('invalid, reversed, or unsupported ranges fail consistently before date iteration', () => {
  const ledger = model.createEmptyLedger();
  for (const range of [
    ['2026-10-31', '2026-10-01'],
    ['2023-02-29', '2023-03-01'],
    ['2026-04-31', '2026-05-01'],
    ['2026-1-01', '2026-01-31'],
    ['2026-10-01T00:00:00Z', '2026-10-31'],
    ['1899-12-31', '1900-01-01'],
    ['2100-12-31', '2101-01-01'],
    [undefined, '2026-10-31'],
    ['2026-10-01', null],
    [NaN, Infinity],
  ]) {
    assert.throws(() => periodReport(ledger, ...range), /real start and end dates/);
    assert.throws(() => monthlySeries(ledger, ...range), /real start and end dates/);
  }
});

test('full supported calendar range is bounded and includes both endpoint months', () => {
  const rows = monthlySeries(model.createEmptyLedger(), '1900-01-01', '2100-12-31');
  assert.equal(rows.length, 201 * 12);
  assert.equal(rows[0].month, '1900-01');
  assert.equal(rows.at(-1).month, '2100-12');
  assert.equal(rows.at(-1).endDate, '2100-12-31');
  assert.ok(rows.every((row) => row.netMinor === 0 && row.isPartialPeriod === false));
});

test('largest supported ledger total remains an exact safe integer and malformed amounts are rejected', () => {
  const base = model.createEmptyLedger();
  const ledger = {
    ...base,
    wallet: { ...base.wallet, hasTransactionHistory: true },
    transactions: Array.from({ length: 10000 }, (_, index) => ({
      id: `large-${index}`,
      walletId: base.wallet.id,
      type: 'income',
      title: 'Large synthetic income',
      categoryId: 'income-salary',
      date: '2026-10-17',
      amountMinor: model.MAX_AMOUNT_MINOR,
    })),
  };
  const report = periodReport(ledger, '2026-10-01', '2026-10-31');
  assert.equal(report.incomeMinor, 10000 * model.MAX_AMOUNT_MINOR);
  assert.equal(report.closingMinor, 9999999990000);
  assert.equal(Number.isSafeInteger(report.closingMinor), true);
  assertReconciles(report);
  for (const amountMinor of [0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = { ...ledger, transactions: [{ ...ledger.transactions[0], amountMinor }] };
    assert.throws(() => periodReport(invalid, '2026-10-01', '2026-10-31'), /invalid format/);
  }
  assert.throws(
    () =>
      periodReport(
        {
          ...ledger,
          transactions: [...ledger.transactions, { ...ledger.transactions[0], id: 'too-many' }],
        },
        '2026-10-01',
        '2026-10-31',
      ),
    /invalid format/,
  );
});

test('calculation is immutable, order-independent, and returned categories cannot change the ledger', () => {
  const ledger = reportFixture();
  const before = JSON.stringify(ledger);
  const freeze = (value) => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  freeze(ledger);
  const report = periodReport(ledger, '2026-10-01', '2026-10-31');
  const reversed = periodReport(
    { ...ledger, transactions: [...ledger.transactions].reverse() },
    '2026-10-01',
    '2026-10-31',
  );
  assert.deepEqual(report, reversed);
  monthlySeries(ledger, '2026-09-01', '2026-11-30');
  report.categoryBreakdown[0].categoryName = 'Only the result changed';
  assert.equal(JSON.stringify(ledger), before);
  assert.equal(
    periodReport(ledger, '2026-10-01', '2026-10-31').categoryBreakdown[0].categoryName,
    'Salary',
  );
});

test('equal category amounts use deterministic name/ID ordering, independent of entry order', () => {
  let ledger = model.createEmptyLedger();
  ledger = model.createCategory(ledger, { id: 'alpha', type: 'expense', name: 'Alpha' });
  ledger = model.createCategory(ledger, { id: 'zulu', type: 'expense', name: 'Zulu' });
  ledger = add(ledger, 'zulu-first', 'expense', '10', '2026-10-17', 'zulu');
  ledger = add(ledger, 'alpha-second', 'expense', '10', '2026-10-17', 'alpha');
  const report = periodReport(ledger, '2026-10-01', '2026-10-31');
  assert.deepEqual(
    report.categoryBreakdown.map((item) => item.categoryId),
    ['alpha', 'zulu'],
  );
  assertReconciles(report);
});
