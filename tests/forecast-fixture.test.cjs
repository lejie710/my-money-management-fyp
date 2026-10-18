const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const model = require('../src/core/model');
const forecast = require('../src/core/forecast');
const fixtures = require('../src/verification/fixtures');
const { createHookHost, loadTsSource } = require('./helpers/hook-host.cjs');
// Existing verification-fixtures.test.cjs separately retains all prior scenario/storage checks.

const SCENARIO = 'forecast-verification',
  NAMESPACE = 'forecast-native-reference';
const clock = () => fixtures.verificationClock(NAMESPACE, SCENARIO);
const ledger = () => fixtures.createVerificationLedger(NAMESPACE, SCENARIO);
// Literal independent reference from FORECAST_ACCEPTANCE; never derived by fitting
// another invocation of the implementation under test.
const HISTORY = [
  ['2025-04', 10000],
  ['2025-05', 11000],
  ['2025-06', 12000],
  ['2025-07', 13000],
  ['2025-08', 14000],
  ['2025-09', 15000],
  ['2025-10', 16000],
  ['2025-11', 17000],
  ['2025-12', 18000],
  ['2026-01', 19000],
  ['2026-02', 20000],
  ['2026-03', 21000],
  ['2026-04', 22000],
  ['2026-05', 23000],
  ['2026-06', 24000],
  ['2026-07', 25000],
  ['2026-08', 26000],
  ['2026-09', 27000],
];
const FUTURE = [
  ['2026-11', 2, 28440],
  ['2026-12', 3, 28952],
  ['2027-01', 4, 29362],
  ['2027-02', 5, 29689],
  ['2027-03', 6, 29951],
  ['2027-04', 7, 30161],
];
const output = (value = ledger(), categoryId = null) =>
  forecast.forecastRecordedExpenses(value, {
    asOfDate: clock().today,
    categoryId,
  });

test('forecast scenario and clock require an explicit isolated namespace, preserve old scenarios and start as sample MYR data', () => {
  for (const scenario of [
    'report-reconciliation',
    'health-goal',
    'achievements-completion',
    'export-verification',
    SCENARIO,
  ])
    assert.ok(fixtures.TEST_SCENARIOS.includes(scenario));
  assert.equal(fixtures.TEST_SCENARIOS.filter((scenario) => scenario === SCENARIO).length, 1);
  for (const namespace of [undefined, '', ' ']) {
    assert.throws(() => fixtures.createVerificationLedger(namespace, SCENARIO), /isolated/);
    assert.throws(() => fixtures.verificationClock(namespace, SCENARIO), /isolated/);
  }
  assert.equal(clock().today, '2026-10-18');
  assert.equal(clock().nowMs, 1792296000000);
  const mutableClock = clock();
  mutableClock.today = '2099-01-01';
  assert.equal(clock().today, '2026-10-18');
  const data = ledger();
  model.validateLedger(data);
  assert.equal(data.mode, 'sample');
  assert.equal(data.wallet.currency, 'MYR');
  assert.equal(data.wallet.name, 'Forecast verification wallet');
  assert.equal(data.transactions.length, 26);
});

test('fixture has exactly the independently specified 18 complete expense months and eligibility', () => {
  const result = output();
  assert.deepEqual(
    result.history.map(({ month, expenseMinor }) => [month, expenseMinor]),
    HISTORY,
  );
  assert.ok(result.history.every((row) => row.transactionCount === 1));
  assert.equal(result.trainingCutoff, '2026-09-30');
  assert.deepEqual(result.eligibility, {
    completedMonths: 18,
    activeMonths: 18,
    minimumCompletedMonths: 8,
    minimumActiveMonths: 3,
  });
  assert.equal(result.status, 'available');
  assert.equal(result.reason, null);
});

test('selected method and all two-month-ahead MAEs match the independent oracle and exact calendar folds', () => {
  const result = output();
  assert.equal(result.selectedMethod, 'damped-trend');
  assert.equal(result.backtest.metricLabel, 'Two-month-ahead MAE');
  assert.equal(result.backtest.foldCount, 12);
  assert.equal(result.backtest.firstTargetMonth, '2025-10');
  assert.equal(result.backtest.lastTargetMonth, '2026-09');
  assert.deepEqual(
    result.backtest.candidates.map(({ method, maeMinor, foldCount }) => [
      method,
      maeMinor,
      foldCount,
    ]),
    [
      ['last-value', 2000, 12],
      ['mean-three', 3000, 12],
      ['damped-trend', 560, 12],
    ],
  );
  for (const candidate of result.backtest.candidates) {
    assert.equal(candidate.folds[0].trainingThroughMonth, '2025-08');
    assert.equal(candidate.folds[0].excludedGapMonth, '2025-09');
    assert.equal(candidate.folds[0].targetMonth, '2025-10');
    assert.equal(candidate.folds.at(-1).trainingThroughMonth, '2026-07');
    assert.equal(candidate.folds.at(-1).excludedGapMonth, '2026-08');
    assert.equal(candidate.folds.at(-1).targetMonth, '2026-09');
  }
});

test('six projections use exact reference minor units and strict future November through April labels', () => {
  const result = output();
  assert.deepEqual(
    result.forecast.map(({ month, lead, predictedMinor }) => [month, lead, predictedMinor]),
    FUTURE,
  );
  assert.equal(
    result.forecast.some((row) => row.month <= '2026-10'),
    false,
  );
  assert.equal(result.forecast.length, 6);
  assert.ok(
    result.forecast.every(
      (row) => Number.isSafeInteger(row.predictedMinor) && row.predictedMinor >= 0,
    ),
  );
});

test('current partial, later October, future November, earlier income and debt never leak into training or projections', () => {
  const data = ledger(),
    full = output(data);
  const trainingOnly = {
    ...data,
    transactions: data.transactions.filter((row) => row.id.startsWith('forecast-food-')),
  };
  const clean = output(trainingOnly);
  assert.deepEqual(full.history, clean.history);
  assert.deepEqual(full.backtest, clean.backtest);
  assert.deepEqual(full.forecast, clean.forecast);
  assert.equal(full.partialMonth.month, '2026-10');
  assert.equal(full.partialMonth.throughDate, '2026-10-18');
  assert.equal(full.partialMonth.expenseMinor, 1004199); // MYR 9,999.99 Food +42.00 Transport.
  assert.equal(full.partialMonth.transactionCount, 2);
  assert.equal(clean.partialMonth.expenseMinor, 0);
  assert.equal(full.lastRecordedExpenseMonth, '2026-10');
  assert.equal(full.lastTrainingExpenseMonth, '2026-09');
});

test('Food preserves the exact reference while current-only Transport exercises an honest insufficient category', () => {
  const data = ledger(),
    food = output(data, 'expense-food'),
    transport = output(data, 'expense-transport');
  assert.deepEqual(
    food.history.map(({ month, expenseMinor }) => [month, expenseMinor]),
    HISTORY,
  );
  assert.deepEqual(
    food.forecast.map(({ month, lead, predictedMinor }) => [month, lead, predictedMinor]),
    FUTURE,
  );
  assert.equal(food.partialMonth.expenseMinor, 999999);
  assert.equal(transport.status, 'insufficient-history');
  assert.equal(transport.reason, 'no-completed-expenses');
  assert.equal(transport.eligibility.completedMonths, 0);
  assert.equal(transport.eligibility.activeMonths, 0);
  assert.equal(transport.partialMonth.expenseMinor, 4200);
  assert.equal(transport.partialMonth.transactionCount, 1);
  assert.equal(transport.backtest, null);
  assert.equal(transport.selectedMethod, null);
  assert.deepEqual(transport.forecast, []);
  assert.throws(() => output(data, 'income-salary'), /expense/i);
});

test('fixture forecast reopens deterministically from serialized ledger bytes without financial writes', () => {
  const data = ledger(),
    before = JSON.stringify(data),
    first = output(data);
  assert.deepEqual(output(data), first);
  assert.deepEqual(output(JSON.parse(before)), first);
  assert.equal(JSON.stringify(data), before);
  const separate = ledger();
  separate.transactions[0].title = 'Changed only this fixture instance';
  assert.notEqual(separate.transactions[0].title, data.transactions[0].title);
  assert.equal(Object.isFrozen(first), true);
});

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (typeof tree.type === 'function') return find(tree.type(tree.props), predicate);
  if (predicate(tree)) return tree;
  for (const child of (tree.props?.children ?? []).flat(Infinity)) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
const byId = (tree, id) => find(tree, (item) => item.props?.testID === id);
function text(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (!tree || typeof tree !== 'object') return '';
  if (typeof tree.type === 'function') return text(tree.type(tree.props));
  return (tree.props?.children ?? []).flat(Infinity).map(text).join('');
}
test('actual staged forecast UI can apply the Transport insufficient state and return to the exact Food reference', () => {
  const host = createHookHost(),
    data = ledger(),
    before = JSON.stringify(data);
  host.react.useMemo = (factory, deps) => {
    const memo = host.react.useRef(null);
    if (!memo.current || deps.some((item, index) => !Object.is(item, memo.current.deps[index])))
      memo.current = { deps, value: factory() };
    return memo.current.value;
  };
  const ui = loadTsSource(path.join(__dirname, '../src/ui/ForecastSheet.tsx'), {
    react: host.react,
    'react-native': {
      Keyboard: { dismiss() {} },
      StyleSheet: { create: (value) => value },
      Text: 'Text',
      View: 'View',
    },
    '../core/model': model,
    '../core/forecast': forecast,
    './components': {
      Action: 'Action',
      Choice: 'Choice',
      Field: 'Field',
      FormError: 'FormError',
      Sheet: 'Sheet',
    },
    './theme': { colors: {}, ui: {} },
    './useProphetForecast': require('./helpers/account-hook-harness.cjs').loadSource(
      path.join(__dirname, '../src/ui/useProphetForecast.ts'),
      { react: host.react, '../forecast/protocol': require('../src/forecast/protocol') },
      { AbortController },
    ),
  });
  const render = () =>
    host.render(() =>
      ui.ForecastSheet({
        ledger: data,
        initialAsOfDate: clock().today,
        onClose() {},
      }),
    );
  let tree = render();
  assert.match(text(byId(tree, 'forecast-selected-mae')), /5\.60/);
  assert.match(text(byId(tree, 'forecast-future-2026-11')), /284\.40/);
  byId(tree, 'forecast-category-search').props.onChangeText('Transport');
  tree = render();
  byId(tree, 'forecast-category-expense-transport').props.onPress();
  tree = render();
  byId(tree, 'forecast-apply').props.onPress();
  tree = render();
  assert.ok(byId(tree, 'forecast-insufficient'));
  assert.equal(byId(tree, 'forecast-future-panel'), null);
  assert.match(text(byId(tree, 'forecast-history-counts')), /0 completed history months; 0 months/);
  assert.match(text(byId(tree, 'forecast-partial-amount')), /42\.00/);
  byId(tree, 'forecast-category-search').props.onChangeText('Food');
  tree = render();
  byId(tree, 'forecast-category-expense-food').props.onPress();
  tree = render();
  byId(tree, 'forecast-apply').props.onPress();
  tree = render();
  assert.equal(byId(tree, 'forecast-insufficient'), null);
  assert.match(text(byId(tree, 'forecast-applied-selection')), /Food/);
  assert.match(text(byId(tree, 'forecast-method')), /Damped/);
  assert.match(text(byId(tree, 'forecast-future-2027-04')), /301\.61/);
  assert.equal(JSON.stringify(data), before);
  host.unmount();
});
