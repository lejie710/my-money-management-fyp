const {
  createEmptyLedger,
  saveTransaction,
  transactionFromDraft,
  goalFromDraft,
  saveGoal,
  budgetFromDraft,
  saveBudget,
  createCategory,
  patchTransactionContext,
} = require('../core/model');
const { completeWeeklyReview } = require('../core/achievements');

const TEST_SCENARIOS = Object.freeze([
  'report-reconciliation',
  'health-goal',
  'achievements-completion',
  'export-verification',
  'forecast-verification',
]);
const ACHIEVEMENT_CLOCK = Object.freeze({
  today: '2026-11-02',
  nowMs: Date.parse('2026-11-02T09:00:00+08:00'),
});
const FORECAST_CLOCK = Object.freeze({
  today: '2026-10-18',
  nowMs: Date.parse('2026-10-18T12:00:00+08:00'),
});
const REPORT_ROWS = Object.freeze(
  [
    ['sep-income', 'September salary', 'income', 'income-salary', '2026-09-01', '1000.00'],
    ['sep-food', 'September food', 'expense', 'expense-food', '2026-09-15', '200.00'],
    ['sep-debt', 'September debt payment', 'debt', 'debt-loan', '2026-09-30', '50.00'],
    ['oct-income', 'October salary', 'income', 'income-salary', '2026-10-01', '2000.00'],
    ['oct-food-early', 'Food on 15 October', 'expense', 'expense-food', '2026-10-15', '120.00'],
    ['oct-food-late', 'Food on 30 October', 'expense', 'expense-food', '2026-10-30', '80.00'],
    ['oct-transport', 'October transport', 'expense', 'expense-transport', '2026-10-31', '50.00'],
    ['oct-debt', 'October debt payment', 'debt', 'debt-loan', '2026-10-31', '300.00'],
    ['nov-income', 'November income', 'income', 'income-salary', '2026-11-01', '500.00'],
    ['nov-food', 'November food', 'expense', 'expense-food', '2026-11-01', '20.00'],
  ].map(Object.freeze),
);

function validateTestScenario(namespace, scenario) {
  if (scenario === undefined || scenario === '') return null;
  if (typeof namespace !== 'string' || !namespace.trim()) {
    throw new Error('A verification scenario requires an isolated test data namespace.');
  }
  if (!TEST_SCENARIOS.includes(scenario)) {
    throw new Error('Unknown verification scenario. Check the local test configuration.');
  }
  return scenario;
}

function createVerificationLedger(namespace, scenario) {
  const selected = validateTestScenario(namespace, scenario);
  if (!selected) {
    throw new Error('Choose an explicit verification scenario.');
  }
  if (selected === 'achievements-completion') return achievementFixture();
  if (selected === 'export-verification') return exportFixture();
  if (selected === 'forecast-verification') return forecastFixture();
  let ledger = {
    ...createEmptyLedger({
      name: selected === 'health-goal' ? 'Health example wallet' : 'Report example wallet',
    }),
    mode: 'sample',
  };
  for (const [suffix, title, type, categoryId, date, amount] of REPORT_ROWS) {
    ledger = saveTransaction(
      ledger,
      transactionFromDraft({ title, type, categoryId, date, amount }, `report-${suffix}`, ledger),
    );
  }
  if (selected === 'health-goal') {
    ledger = saveGoal(
      ledger,
      goalFromDraft({ kind: 'emergencyFund', amount: '4000' }, 'health-example-goal', ledger),
    );
  }
  return ledger;
}

function exportFixture() {
  let ledger = {
    ...createEmptyLedger({ name: 'Export verification wallet', currency: 'JPY' }),
    mode: 'sample',
  };
  const add = (id, title, categoryId, amount, notes = '') => {
    let transaction = transactionFromDraft(
      { title, type: 'expense', categoryId, date: '2026-10-17', amount },
      id,
      ledger,
    );
    if (notes) transaction = patchTransactionContext(transaction, { notes }, ledger);
    ledger = saveTransaction(ledger, transaction);
  };
  for (let index = 1; index <= 64; index += 1) {
    const suffix = String(index).padStart(2, '0');
    ledger = createCategory(ledger, {
      id: `export-category-${suffix}`,
      name: `Long category ${suffix} for page wrapping`,
      type: 'expense',
    });
    add(
      `export-row-${suffix}`,
      `Synthetic category expense ${suffix}`,
      `export-category-${suffix}`,
      String(index),
    );
  }
  add(
    'export-unicode',
    'Lunch 午餐 日本語 café',
    'expense-food',
    '1234',
    'Line one: 午餐 日本語 café.\nLine two: exact whole-yen amount.\n<synthetic> & escaped text.',
  );
  add(
    'export-overflow',
    'Long optional notes',
    'expense-food',
    '5678',
    'Synthetic notes for QR overflow. '.repeat(60),
  );
  add('export-boundary', 'QR byte boundary', 'expense-food', '999', 'A');
  const { createTransactionExportSnapshot, buildTransactionQr } = require('../core/exports');
  const output = buildTransactionQr(
    createTransactionExportSnapshot(ledger, 'export-boundary', { notes: true }, 1792281600000),
    { notes: true },
  );
  if (!output.ok || output.byteLength >= 1024)
    throw new Error('The export fixture boundary changed.');
  const boundary = ledger.transactions.find((item) => item.id === 'export-boundary');
  ledger = saveTransaction(
    ledger,
    patchTransactionContext(boundary, { notes: 'A'.repeat(1025 - output.byteLength) }, ledger),
    true,
  );
  return ledger;
}

function verificationClock(namespace, scenario) {
  const selected = validateTestScenario(namespace, scenario);
  if (selected === 'forecast-verification') return { ...FORECAST_CLOCK };
  return selected === 'achievements-completion' ? { ...ACHIEVEMENT_CLOCK } : null;
}

function forecastFixture() {
  let ledger = {
    ...createEmptyLedger(
      { name: 'Forecast verification wallet', currency: 'MYR' },
      { clock: FORECAST_CLOCK },
    ),
    mode: 'sample',
  };
  const add = (id, title, type, categoryId, date, amount) => {
    ledger = saveTransaction(
      ledger,
      transactionFromDraft({ title, type, categoryId, date, amount }, id, ledger),
    );
  };
  // Complete Food expenses: Apr 2025 through Sep 2026, MYR 100..270.
  for (let index = 0; index < 18; index += 1) {
    const date = new Date(Date.UTC(2025, 3 + index, 15)).toISOString().slice(0, 10);
    const month = date.slice(0, 7);
    add(`forecast-food-${month}`, `Synthetic Food ${month}`, 'expense', 'expense-food', date, String(100 + index * 10));
  }
  // These are intentional exclusion checks, never additional training samples.
  add('forecast-current-food', 'Synthetic current partial Food', 'expense', 'expense-food', '2026-10-18', '9999.99');
  add('forecast-after-as-of-food', 'Synthetic Food after as-of date', 'expense', 'expense-food', '2026-10-19', '77777.77');
  add('forecast-future-food', 'Synthetic future Food outlier', 'expense', 'expense-food', '2026-11-01', '88888.88');
  add('forecast-current-transport', 'Synthetic current-only Transport', 'expense', 'expense-transport', '2026-10-18', '42.00');
  // Earlier income/debt must neither start expense history nor enter its totals.
  add('forecast-earlier-income', 'Synthetic earlier income', 'income', 'income-salary', '2024-01-15', '100000.00');
  add('forecast-earlier-debt', 'Synthetic earlier debt payment', 'debt', 'debt-loan', '2025-02-15', '200000.00');
  add('forecast-training-income', 'Synthetic September income outlier', 'income', 'income-salary', '2026-09-15', '500000.00');
  add('forecast-training-debt', 'Synthetic September debt outlier', 'debt', 'debt-loan', '2026-09-15', '400000.00');
  return ledger;
}

function achievementFixture() {
  let ledger = createEmptyLedger(
    { name: 'Achievement verification wallet' },
    { clock: { today: '2026-10-01', nowMs: Date.parse('2026-10-01T09:00:00+08:00') } },
  );
  const add = (id, type, categoryId, date, amount) => {
    ledger = saveTransaction(
      ledger,
      transactionFromDraft({ title: id, type, categoryId, date, amount }, id, ledger),
    );
  };
  for (let day = 5; day <= 11; day += 1) {
    const date = `2026-10-${String(day).padStart(2, '0')}`;
    add(`fixture-income-${day}`, 'income', 'income-salary', date, '100');
    add(`fixture-food-${day}`, 'expense', 'expense-food', date, '10');
  }
  for (const categoryId of [
    'expense-transport',
    'expense-bills',
    'expense-shopping',
    'expense-health',
  ])
    add(`fixture-${categoryId}`, 'expense', categoryId, '2026-10-15', '1');
  for (const month of ['2026-10-01', '2026-11-01']) {
    ledger = saveBudget(
      ledger,
      budgetFromDraft(
        { categoryId: 'expense-food', period: 'month', anchorDate: month, amount: '100' },
        `fixture-budget-${month}`,
        ledger,
      ),
    );
  }
  ledger = saveGoal(
    ledger,
    goalFromDraft({ kind: 'emergencyFund', amount: '500' }, 'fixture-goal', ledger),
  );
  for (const date of ['2026-10-12', '2026-10-19', '2026-10-26'])
    ledger = completeWeeklyReview(ledger, {
      today: date,
      nowMs: Date.parse(`${date}T09:00:00+08:00`),
    });
  return ledger;
}

module.exports = {
  TEST_SCENARIOS,
  validateTestScenario,
  createVerificationLedger,
  verificationClock,
};
