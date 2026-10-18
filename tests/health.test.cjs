const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/core/model');
const { periodReport } = require('../src/core/reports');
const {
  FORMULA_VERSION,
  MAX_SCENARIO_MINOR,
  cashFlowHealth,
  parseAggregateMoney,
  createSimulationBaseline,
  simulateReport,
} = require('../src/core/health');

const closeTo = (actual, expected, epsilon = 1e-8) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} differs from ${expected}`);
const inputsFrom = (report) => ({
  incomeMinor: report.incomeMinor,
  expenseMinor: report.expenseMinor,
  debtMinor: report.debtMinor,
});

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

function reportFixture(currency = 'MYR') {
  let ledger = model.createEmptyLedger({ currency });
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
  return { ledger, report: periodReport(ledger, '2026-10-01', '2026-10-31') };
}

test('the versioned inherited formula gives 45 for 1000 income, 800 expenses and 400 debt', () => {
  const result = cashFlowHealth({ incomeMinor: 100000, expenseMinor: 80000, debtMinor: 40000 });
  assert.equal(FORMULA_VERSION, 'fyp-cash-flow-v1');
  assert.equal(result.formulaVersion, FORMULA_VERSION);
  assert.equal(result.status, 'available');
  assert.equal(result.outflowMinor, 120000);
  assert.equal(result.netMinor, -20000);
  assert.equal(result.cashFlowRatio, -0.2);
  assert.equal(result.debtToIncomeRatio, 0.4);
  closeTo(result.cashFlowPenaltyPoints, 45);
  closeTo(result.debtPenaltyPoints, 10);
  closeTo(result.rawScore, 45);
  closeTo(result.score, 45);
});

test('exact inherited threshold boundaries have no penalty and score is not rounded internally', () => {
  const boundary = cashFlowHealth({ incomeMinor: 100000, expenseMinor: 45000, debtMinor: 30000 });
  assert.equal(boundary.cashFlowRatio, 0.25);
  assert.equal(boundary.cashFlowPenaltyPoints, 0);
  assert.equal(boundary.debtPenaltyPoints, 0);
  assert.equal(boundary.score, 100);
  const cashCrossed = cashFlowHealth({
    incomeMinor: 100000,
    expenseMinor: 45001,
    debtMinor: 30000,
  });
  closeTo(cashCrossed.score, 99.999);
  assert.notEqual(cashCrossed.score, 100);
  const debtCrossed = cashFlowHealth({
    incomeMinor: 100000,
    expenseMinor: 44999,
    debtMinor: 30001,
  });
  assert.equal(debtCrossed.cashFlowPenaltyPoints, 0);
  closeTo(debtCrossed.debtPenaltyPoints, 0.001);
  closeTo(debtCrossed.score, 99.999);
});

test('score clamps at zero and one hundred without discarding the raw penalties', () => {
  const severe = cashFlowHealth({ incomeMinor: 100000, expenseMinor: 200000, debtMinor: 50000 });
  assert.equal(severe.netMinor, -150000);
  closeTo(severe.rawScore, -95);
  assert.equal(severe.score, 0);
  assert.equal(cashFlowHealth({ incomeMinor: 100000, expenseMinor: 0, debtMinor: 0 }).score, 100);
});

test('zero income preserves money facts but has no score, ratios or invented penalties', () => {
  for (const inputs of [
    { incomeMinor: 0, expenseMinor: 0, debtMinor: 0 },
    { incomeMinor: 0, expenseMinor: 10000, debtMinor: 0 },
    { incomeMinor: 0, expenseMinor: 0, debtMinor: 10000 },
  ]) {
    const result = cashFlowHealth(inputs);
    assert.equal(result.status, 'insufficient-income');
    assert.equal(result.outflowMinor, inputs.expenseMinor + inputs.debtMinor);
    assert.equal(result.netMinor, -result.outflowMinor || 0);
    for (const field of [
      'score',
      'rawScore',
      'cashFlowRatio',
      'debtToIncomeRatio',
      'cashFlowPenaltyPoints',
      'debtPenaltyPoints',
    ]) {
      assert.equal(result[field], null, field);
    }
  }
});

test('negative, fractional, nonfinite, missing and oversized inputs fail before zero-income handling', () => {
  const valid = { incomeMinor: 100000, expenseMinor: 80000, debtMinor: 40000 };
  for (const key of Object.keys(valid)) {
    for (const value of [-1, 0.1, NaN, Infinity, '1', null, undefined, MAX_SCENARIO_MINOR + 1]) {
      assert.throws(() => cashFlowHealth({ ...valid, [key]: value }), /nonnegative integer amount/);
    }
  }
  assert.throws(() => cashFlowHealth({ incomeMinor: 0, expenseMinor: -1, debtMinor: 0 }));
  assert.throws(() => cashFlowHealth(null), /Enter income/);
});

test('score is scale invariant and follows expense/debt/income monotonicity', () => {
  const base = { incomeMinor: 3, expenseMinor: 2, debtMinor: 1 };
  for (const multiplier of [1, 10, 100, 1000]) {
    closeTo(
      cashFlowHealth({
        incomeMinor: base.incomeMinor * multiplier,
        expenseMinor: base.expenseMinor * multiplier,
        debtMinor: base.debtMinor * multiplier,
      }).score,
      cashFlowHealth(base).score,
    );
  }
  for (const incomeMinor of [10000, 100000, 1000000]) {
    for (const expenseMinor of [0, 1000, 10000, 50000, 150000]) {
      for (const debtMinor of [0, 5000, 30000, 40000]) {
        const before = cashFlowHealth({ incomeMinor, expenseMinor, debtMinor }).score;
        assert.ok(
          cashFlowHealth({ incomeMinor, expenseMinor: expenseMinor + 1000, debtMinor }).score <=
            before + 1e-8,
        );
        assert.ok(
          cashFlowHealth({ incomeMinor, expenseMinor, debtMinor: debtMinor + 1000 }).score <=
            before + 1e-8,
        );
        assert.ok(
          cashFlowHealth({ incomeMinor: incomeMinor + 1000, expenseMinor, debtMinor }).score >=
            before - 1e-8,
        );
      }
    }
  }
});

test('aggregate parser accepts zero and every supported currency without monetary rounding', () => {
  for (const currency of model.CURRENCIES) {
    assert.equal(parseAggregateMoney('0', currency.code), 0);
    assert.equal(
      parseAggregateMoney(model.amountInputValue(MAX_SCENARIO_MINOR, currency.code), currency.code),
      MAX_SCENARIO_MINOR,
    );
    if (currency.decimals === 0) {
      assert.equal(parseAggregateMoney('1200', currency.code), 1200);
      assert.throws(() => parseAggregateMoney('0.00', currency.code), /whole-yen/);
      assert.throws(() => parseAggregateMoney('12.5', currency.code), /whole-yen/);
    } else {
      assert.equal(parseAggregateMoney(' 0.00 ', currency.code), 0);
      assert.equal(parseAggregateMoney('00012.5', currency.code), 1250);
      assert.equal(
        parseAggregateMoney('0.10', currency.code) + parseAggregateMoney('0.20', currency.code),
        30,
      );
    }
  }
  assert.equal(parseAggregateMoney('10000000.00'), 1000000000);
  assert.throws(() => model.parseMoney('10000000.00'));
});

test('aggregate parser rejects ambiguous syntax and out-of-range numeric input', () => {
  for (const value of [
    '',
    '-0',
    '-1',
    '+1',
    '.5',
    '1.',
    '1e3',
    '1,000',
    'RM10',
    '0.001',
    'NaN',
    'Infinity',
    0,
    '9'.repeat(100),
  ]) {
    assert.throws(() => parseAggregateMoney(value), undefined, String(value));
  }
  for (const currency of ['MYR', 'JPY']) {
    assert.throws(
      () => parseAggregateMoney(model.amountInputValue(MAX_SCENARIO_MINOR + 1, currency), currency),
      /cannot exceed/,
    );
  }
  assert.throws(() => parseAggregateMoney('0', 'XXX'), /supported wallet currencies/);
});

test('baseline creation freezes scalar report values without retaining mutable report arrays', () => {
  const { report } = reportFixture();
  const baseline = createSimulationBaseline(report);
  assert.equal(Object.isFrozen(baseline), true);
  assert.equal(Object.hasOwn(baseline, 'categoryBreakdown'), false);
  assert.equal(baseline.openingMinor, 75000);
  assert.equal(baseline.netMinor, 145000);
  assert.equal(baseline.closingMinor, 220000);
  assert.equal(baseline.currentBalanceMinor, 268000);
  report.openingMinor = 123;
  report.categoryBreakdown.length = 0;
  assert.equal(baseline.openingMinor, 75000);
  assert.equal(baseline.incomeMinor, 200000);
});

test('baseline rejects missing currency, bad dates, unsafe values and financial non-reconciliation', () => {
  const { report } = reportFixture();
  for (const patch of [
    { currency: undefined },
    { currency: 'XXX' },
    { startDate: '2026-02-30' },
    { endDate: '2026-09-30' },
    { incomeMinor: undefined },
    { expenseMinor: -1 },
    { debtMinor: NaN },
    { openingMinor: 0.1 },
    { currentBalanceMinor: Infinity },
    { currentBalanceMinor: Number.MAX_SAFE_INTEGER },
    { outflowMinor: 1 },
    { netMinor: 1 },
    { closingMinor: 1 },
  ])
    assert.throws(() => createSimulationBaseline({ ...report, ...patch }));
  assert.throws(() => createSimulationBaseline(null));
  const tooMuchRecordedActivity = {
    ...report,
    openingMinor: 0,
    incomeMinor: MAX_SCENARIO_MINOR,
    expenseMinor: MAX_SCENARIO_MINOR,
    debtMinor: 0,
    outflowMinor: MAX_SCENARIO_MINOR,
    netMinor: 0,
    closingMinor: 0,
  };
  assert.throws(() => createSimulationBaseline(tooMuchRecordedActivity), /ledger aggregate limit/);
});

test('October scenario produces score45, closing550, all-record1030 and a correctly based goal', () => {
  const { report } = reportFixture();
  const result = simulateReport(
    createSimulationBaseline(report),
    { incomeMinor: 100000, expenseMinor: 80000, debtMinor: 40000 },
    400000,
  );
  assert.equal(result.baselineHealth.score, 100);
  closeTo(result.health.score, 45);
  assert.equal(result.deltaNetMinor, -165000);
  assert.equal(result.projectedClosingMinor, 55000);
  assert.equal(result.projectedCurrentBalanceMinor, 103000);
  assert.equal(result.goal.balanceMinor, 103000);
  assert.equal(result.goal.percent, 25.75);
  assert.equal(result.goal.remainingMinor, 297000);
});

test('repeated inputs and edit order cannot compound results; reset recovers the recorded baseline', () => {
  const { ledger, report } = reportFixture();
  const originalBytes = JSON.stringify(ledger);
  const baseline = createSimulationBaseline(report);
  const desired = { incomeMinor: 100000, expenseMinor: 80000, debtMinor: 40000 };
  const expected = simulateReport(baseline, desired, 400000);
  for (const input of [
    { ...desired, expenseMinor: 50000 },
    { ...desired, incomeMinor: 200000 },
    { ...desired, debtMinor: 0 },
    desired,
    desired,
  ])
    simulateReport(baseline, input, 400000);
  assert.deepEqual(simulateReport(baseline, desired, 400000), expected);
  const reset = simulateReport(baseline, inputsFrom(baseline), 400000);
  assert.equal(reset.deltaNetMinor, 0);
  assert.equal(reset.health.score, 100);
  assert.equal(reset.projectedClosingMinor, 220000);
  assert.equal(reset.projectedCurrentBalanceMinor, 268000);
  assert.equal(JSON.stringify(ledger), originalBytes);
});

test('all-zero scenario is not reset and does not zero the entire wallet', () => {
  const { report } = reportFixture();
  const result = simulateReport(createSimulationBaseline(report), {
    incomeMinor: 0,
    expenseMinor: 0,
    debtMinor: 0,
  });
  assert.equal(result.health.score, null);
  assert.equal(result.health.status, 'insufficient-income');
  assert.equal(result.deltaNetMinor, -145000);
  assert.equal(result.projectedClosingMinor, 75000);
  assert.equal(result.projectedCurrentBalanceMinor, 123000);
  assert.equal(result.goal, null);
});

test('a baseline containing the original45 fixture resets to45 rather than the October fixture score', () => {
  let ledger = model.createEmptyLedger();
  ledger = add(ledger, 'income', 'income', '1000', '2026-10-01');
  ledger = add(ledger, 'expense', 'expense', '800', '2026-10-17');
  ledger = add(ledger, 'debt', 'debt', '400', '2026-10-17');
  const baseline = createSimulationBaseline(periodReport(ledger, '2026-10-01', '2026-10-31'));
  simulateReport(baseline, { incomeMinor: 200000, expenseMinor: 0, debtMinor: 0 });
  const reset = simulateReport(baseline, inputsFrom(baseline), 100000);
  closeTo(reset.health.score, 45);
  assert.equal(reset.projectedCurrentBalanceMinor, -20000);
  assert.equal(reset.goal.status, 'negative');
  assert.equal(reset.goal.remainingMinor, 120000);
});

test('negative, reached and exceeded what-if goals use the same shared rules as actual balances', () => {
  const baseline = createSimulationBaseline(
    periodReport(model.createEmptyLedger(), '2026-10-01', '2026-10-31'),
  );
  const negative = simulateReport(
    baseline,
    { incomeMinor: 0, expenseMinor: 20000, debtMinor: 0 },
    100000,
  );
  assert.equal(negative.projectedCurrentBalanceMinor, -20000);
  assert.deepEqual(negative.goal, model.goalProgressForBalance(-20000, 100000));
  assert.equal(negative.goal.remainingMinor, 120000);
  assert.equal(negative.goal.percent, 0);
  assert.equal(negative.goal.progress, 0);
  const reached = simulateReport(
    baseline,
    { incomeMinor: 100000, expenseMinor: 0, debtMinor: 0 },
    100000,
  );
  assert.equal(reached.goal.status, 'reached');
  const exceeded = simulateReport(
    baseline,
    { incomeMinor: 120000, expenseMinor: 0, debtMinor: 0 },
    100000,
  );
  assert.equal(exceeded.goal.status, 'exceeded');
  assert.equal(exceeded.goal.percent, 120);
  assert.equal(exceeded.goal.progress, 1);
  assert.equal(exceeded.goal.excessMinor, 20000);
  assert.throws(
    () => simulateReport(baseline, { incomeMinor: 1, expenseMinor: 0, debtMinor: 0 }, 0),
    /positive amount/,
  );
});

test('JPY aggregate inputs and scenario balances remain whole yen with unchanged ratio arithmetic', () => {
  const { report } = reportFixture('JPY');
  const result = simulateReport(
    createSimulationBaseline(report),
    {
      incomeMinor: parseAggregateMoney('1000', 'JPY'),
      expenseMinor: parseAggregateMoney('800', 'JPY'),
      debtMinor: parseAggregateMoney('400', 'JPY'),
    },
    4000,
  );
  closeTo(result.health.score, 45);
  assert.equal(result.projectedClosingMinor, 550);
  assert.equal(result.projectedCurrentBalanceMinor, 1030);
  assert.equal(model.formatMoney(result.projectedCurrentBalanceMinor, 'JPY'), '¥1,030');
  assert.equal(result.goal.remainingMinor, 2970);
});

test('largest supported recorded aggregate can be used as a baseline and extreme scenarios stay exact', () => {
  assert.equal(MAX_SCENARIO_MINOR, model.MAX_AMOUNT_MINOR * model.MAX_TRANSACTIONS);
  const base = model.createEmptyLedger();
  const ledger = {
    ...base,
    wallet: { ...base.wallet, hasTransactionHistory: true },
    transactions: Array.from({ length: model.MAX_TRANSACTIONS }, (_, i) => ({
      id: `maximum-${i}`,
      walletId: base.wallet.id,
      type: 'income',
      title: 'Synthetic maximum',
      categoryId: 'income-salary',
      date: '2026-10-17',
      amountMinor: model.MAX_AMOUNT_MINOR,
    })),
  };
  const baseline = createSimulationBaseline(periodReport(ledger, '2026-10-01', '2026-10-31'));
  assert.equal(baseline.incomeMinor, MAX_SCENARIO_MINOR);
  const result = simulateReport(
    baseline,
    { incomeMinor: 0, expenseMinor: MAX_SCENARIO_MINOR, debtMinor: MAX_SCENARIO_MINOR },
    10000,
  );
  assert.equal(result.projectedClosingMinor, -2 * MAX_SCENARIO_MINOR);
  assert.equal(result.projectedCurrentBalanceMinor, -2 * MAX_SCENARIO_MINOR);
  assert.equal(result.goal.remainingMinor, 2 * MAX_SCENARIO_MINOR + 10000);
  assert.equal(Number.isSafeInteger(result.goal.remainingMinor), true);
  assert.equal(result.health.score, null);
});

test('frozen inputs and output edits cannot mutate a baseline or financial records', () => {
  const { ledger, report } = reportFixture();
  const baseline = createSimulationBaseline(report);
  const inputs = Object.freeze({ incomeMinor: 100000, expenseMinor: 80000, debtMinor: 40000 });
  const reportBytes = JSON.stringify(report);
  const ledgerBytes = JSON.stringify(ledger);
  const result = simulateReport(baseline, inputs, 400000);
  result.inputs.incomeMinor = 1;
  result.health.incomeMinor = 2;
  assert.equal(inputs.incomeMinor, 100000);
  assert.equal(baseline.incomeMinor, 200000);
  assert.equal(JSON.stringify(report), reportBytes);
  assert.equal(JSON.stringify(ledger), ledgerBytes);
  assert.equal(simulateReport(baseline, inputs, 400000).projectedCurrentBalanceMinor, 103000);
});

test('changing budgets or goal targets never changes the actual period cash-flow score', () => {
  let { ledger, report } = reportFixture();
  const score = cashFlowHealth(inputsFrom(report));
  ledger = model.saveBudget(
    ledger,
    model.budgetFromDraft(
      { categoryId: 'expense-food', amount: '1', period: 'month', anchorDate: '2026-10-17' },
      'over-budget',
      ledger,
    ),
  );
  ledger = model.saveGoal(
    ledger,
    model.goalFromDraft({ kind: 'home', amount: '100000' }, 'large-goal', ledger),
  );
  report = periodReport(ledger, '2026-10-01', '2026-10-31');
  assert.deepEqual(cashFlowHealth(inputsFrom(report)), score);
});
