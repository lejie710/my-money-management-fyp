const test = require("node:test");
const assert = require("node:assert/strict");
const m = require("../src/core/model");
const f = require("../src/core/forecast");
const clock = {
  today: "2025-01-01",
  nowMs: Date.parse("2025-01-01T12:00:00Z"),
};

function monthAt(start, offset) {
  const [year, month] = start.split("-").map(Number),
    ordinal = year * 12 + month - 1 + offset;
  return `${Math.floor(ordinal / 12)}-${String((ordinal % 12) + 1).padStart(2, "0")}`;
}
function transaction(ledger, id, type, date, amountMinor, categoryId) {
  const category =
    categoryId ??
    { expense: "expense-food", income: "income-salary", debt: "debt-loan" }[
      type
    ];
  return m.saveTransaction(ledger, {
    id,
    walletId: ledger.wallet.id,
    type,
    title: id,
    date,
    amountMinor,
    categoryId: category,
  });
}
function ledgerFrom(
  values,
  { start = "2025-04", currency = "MYR", categoryId = "expense-food" } = {},
) {
  let ledger = m.createEmptyLedger(
    { currency },
    { clock, newIncarnationId: () => "forecast-fixture" },
  );
  if (!ledger.categories.some((category) => category.id === categoryId))
    ledger = m.createCategory(ledger, {
      id: categoryId,
      name: "Receipt purchases",
      type: "expense",
    });
  values.forEach((amount, index) => {
    if (amount > 0)
      ledger = transaction(
        ledger,
        `expense-${index}`,
        "expense",
        `${monthAt(start, index)}-15`,
        amount,
        categoryId,
      );
  });
  return ledger;
}
const forecast = (ledger, options = {}) =>
  f.forecastRecordedExpenses(ledger, { asOfDate: "2026-10-18", ...options });
const numericHistory = (values, start = "2026-02") =>
  values.map((expenseMinor, index) => ({
    month: monthAt(start, index),
    expenseMinor,
  }));
function financialResult(result) {
  return {
    history: result.history,
    forecast: result.forecast,
    backtest: result.backtest,
    selectedMethod: result.selectedMethod,
    trainingCutoff: result.trainingCutoff,
  };
}
function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

test("constant18-month reference has12 two-month-ahead folds and six future-only months", () => {
  const result = forecast(ledgerFrom(Array(18).fill(10000)));
  assert.equal(result.configurationVersion, "recorded-expense-baselines-v1");
  assert.equal(result.target, "recorded-expenses");
  assert.equal(result.status, "available");
  assert.equal(result.trainingCutoff, "2026-09-30");
  assert.equal(result.history.length, 18);
  assert.equal(result.history[0].month, "2025-04");
  assert.equal(result.history[17].month, "2026-09");
  assert.equal(result.selectedMethod, "last-value");
  assert.equal(result.backtest.metricLabel, "Two-month-ahead MAE");
  assert.equal(result.backtest.foldCount, 12);
  assert.equal(result.backtest.firstTargetMonth, "2025-10");
  assert.equal(result.backtest.lastTargetMonth, "2026-09");
  assert.deepEqual(
    result.backtest.candidates.map((c) => c.maeMinor),
    [0, 0, 0],
  );
  assert.equal(result.backtest.relativeImprovementPercent, null);
  assert.deepEqual(
    result.forecast.map((row) => row.month),
    ["2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04"],
  );
  assert.deepEqual(
    result.forecast.map((row) => row.lead),
    [2, 3, 4, 5, 6, 7],
  );
  assert.deepEqual(
    result.forecast.map((row) => row.predictedMinor),
    Array(6).fill(10000),
  );
  assert.equal(result.partialMonth.month, "2026-10");
  assert.equal(result.partialMonth.expenseMinor, 0);
  assert.equal(result.partialMonth.excludedFromTraining, true);
});

test("independent rising100-to270 reference matches exact MAEs and six damped predictions", () => {
  const result = forecast(
    ledgerFrom(
      Array.from({ length: 18 }, (_, index) => (100 + 10 * index) * 100),
    ),
  );
  assert.equal(result.selectedMethod, "damped-trend");
  assert.deepEqual(
    result.backtest.candidates.map((candidate) => candidate.maeMinor),
    [2000, 3000, 560],
  );
  assert.deepEqual(
    result.forecast.map((row) => row.predictedMinor),
    [28440, 28952, 29362, 29689, 29951, 30161],
  );
  assert.equal(result.backtest.relativeImprovementPercent, 72);
  assert.ok(result.backtest.candidates.every((c) => c.foldCount === 12));
});

test("eight months with recorded gaps stay eight observations, four active months and four exact lead2 folds", () => {
  const values = [10000, 0, 10000, 0, 10000, 0, 10000, 0];
  const result = forecast(ledgerFrom(values, { start: "2026-02" }));
  assert.equal(result.status, "available");
  assert.equal(result.eligibility.completedMonths, 8);
  assert.equal(result.eligibility.activeMonths, 4);
  assert.deepEqual(
    result.history.map((row) => row.expenseMinor),
    values,
  );
  assert.deepEqual(
    result.history.map((row) => row.transactionCount),
    [1, 0, 1, 0, 1, 0, 1, 0],
  );
  assert.equal(result.backtest.foldCount, 4);
  const first = result.backtest.candidates[0].folds[0];
  assert.deepEqual(first, {
    trainingMonths: 3,
    trainingThroughMonth: "2026-04",
    excludedGapMonth: "2026-05",
    targetMonth: "2026-06",
    lead: 2,
    actualMinor: 10000,
    predictedMinor: 10000,
    capMinor: 20000,
    absoluteErrorMinor: 0,
  });
});

test("current partial, later-in-current-month and future expenses cannot leak into fitted values or error comparison", () => {
  const initial = ledgerFrom(
    Array.from({ length: 18 }, (_, i) => (100 + 10 * i) * 100),
  );
  const expected = forecast(initial);
  let changed = transaction(
    initial,
    "partial",
    "expense",
    "2026-10-18",
    90000000,
  );
  changed = transaction(
    changed,
    "current-future",
    "expense",
    "2026-10-19",
    80000000,
  );
  changed = transaction(changed, "future", "expense", "2026-11-01", 70000000);
  const actual = forecast(changed);
  assert.deepEqual(financialResult(actual), financialResult(expected));
  assert.equal(actual.partialMonth.expenseMinor, 90000000);
  assert.equal(actual.partialMonth.transactionCount, 1);
  assert.equal(actual.lastRecordedExpenseMonth, "2026-10");
  assert.equal(actual.lastTrainingExpenseMonth, "2026-09");
});

test("income and debt never change target history, eligibility, partial expenses or forecast", () => {
  const original = ledgerFrom(Array(18).fill(10000));
  let modified = transaction(
    original,
    "old-income",
    "income",
    "1900-01-01",
    999999999,
  );
  modified = transaction(modified, "salary", "income", "2026-10-17", 90000000);
  modified = transaction(modified, "old-debt", "debt", "2025-04-15", 80000000);
  modified = transaction(
    modified,
    "partial-debt",
    "debt",
    "2026-10-17",
    70000000,
  );
  assert.deepEqual(forecast(modified), forecast(original));
  let noExpenses = m.createEmptyLedger(
    {},
    { clock, newIncarnationId: () => "income-only" },
  );
  noExpenses = transaction(noExpenses, "income", "income", "2025-04-01", 10000);
  assert.equal(forecast(noExpenses).reason, "no-completed-expenses");
  assert.equal(forecast(noExpenses).history.length, 0);
});

test("receipt origin/context and a Receipt category are ordinary expenses, never filtered out", () => {
  const original = ledgerFrom(Array(18).fill(10000), {
    categoryId: "receipt-category",
  });
  const enriched = {
    ...original,
    transactions: original.transactions.map((t) => ({
      ...t,
      origin: {
        kind: "receipt",
        captureId: `capture-${t.id}`,
        confirmedAtMs: clock.nowMs,
      },
      context: {
        notes: "Synthetic receipt note",
        photo: null,
        withPerson: { name: "Synthetic person", source: "manual" },
        location: { label: "Synthetic shop", source: "manual" },
      },
      legacyNote: "Synthetic receipt metadata",
    })),
  };
  assert.deepEqual(forecast(enriched), forecast(original));
  const filtered = forecast(enriched, { categoryId: "receipt-category" });
  assert.equal(filtered.status, "available");
  assert.deepEqual(
    filtered.forecast.map((row) => row.predictedMinor),
    Array(6).fill(10000),
  );
});

test("no history is fabricated before first selected expense and income does not establish its start", () => {
  let ledger = ledgerFrom([0, 0, 100, 0, 0, 100, 0, 100], { start: "2026-02" });
  ledger = transaction(ledger, "old-income", "income", "2020-01-01", 10000);
  const result = forecast(ledger);
  assert.equal(result.history[0].month, "2026-04");
  assert.equal(result.history.length, 6);
  assert.equal(result.reason, "too-few-completed-months");
});

test("empty, only current/future, short, sparse and missing-category histories return ordinary insufficient states", () => {
  const cases = [
    [ledgerFrom([]), "no-completed-expenses", 0, 0],
    [ledgerFrom([100], { start: "2026-10" }), "no-completed-expenses", 0, 0],
    [ledgerFrom([100], { start: "2026-11" }), "no-completed-expenses", 0, 0],
    [
      ledgerFrom(Array(7).fill(100), { start: "2026-03" }),
      "too-few-completed-months",
      7,
      7,
    ],
    [
      ledgerFrom([100, 0, 0, 0, 0, 0, 100, 0], { start: "2026-02" }),
      "too-few-active-months",
      8,
      2,
    ],
  ];
  for (const [ledger, reason, months, active] of cases) {
    const result = forecast(ledger);
    assert.equal(result.status, "insufficient-history");
    assert.equal(result.reason, reason);
    assert.equal(result.eligibility.completedMonths, months);
    assert.equal(result.eligibility.activeMonths, active);
    assert.deepEqual(result.forecast, []);
    assert.equal(result.backtest, null);
    assert.equal(result.selectedMethod, null);
  }
  const filtered = forecast(ledgerFrom(Array(18).fill(100)), {
    categoryId: "expense-transport",
  });
  assert.equal(filtered.reason, "no-completed-expenses");
  assert.equal(filtered.filter.categoryName, "Transport");
});

test("stable category filtering applies to all history, partial and projection components and survives rename", () => {
  let ledger = ledgerFrom(Array(18).fill(10000));
  for (let i = 0; i < 18; i++)
    ledger = transaction(
      ledger,
      `transport-${i}`,
      "expense",
      `${monthAt("2025-04", i)}-20`,
      5000,
      "expense-transport",
    );
  ledger = transaction(ledger, "food-now", "expense", "2026-10-01", 3000);
  ledger = transaction(
    ledger,
    "train-now",
    "expense",
    "2026-10-01",
    800,
    "expense-transport",
  );
  const selected = forecast(ledger, { categoryId: "expense-transport" });
  assert.equal(selected.partialMonth.expenseMinor, 800);
  assert.ok(selected.history.every((row) => row.expenseMinor === 5000));
  assert.ok(selected.forecast.every((row) => row.predictedMinor === 5000));
  const renamed = forecast(
    m.renameCategory(ledger, "expense-transport", "Rail & bus"),
    { categoryId: "expense-transport" },
  );
  assert.equal(renamed.filter.categoryName, "Rail & bus");
  assert.deepEqual(financialResult(renamed), financialResult(selected));
});

test("transaction edit, deletion and category move immediately recalculate history without stale forecast state", () => {
  const original = ledgerFrom(Array(18).fill(10000)),
    before = forecast(original);
  const last = original.transactions.at(-1),
    edited = m.saveTransaction(original, { ...last, amountMinor: 20000 }, true);
  assert.equal(forecast(edited).history.at(-1).expenseMinor, 20000);
  assert.notDeepEqual(forecast(edited).forecast, before.forecast);
  const deleted = m.deleteTransaction(original, last.id);
  assert.equal(forecast(deleted).history.at(-1).expenseMinor, 0);
  assert.equal(forecast(deleted).history.at(-1).transactionCount, 0);
  const moved = m.saveTransaction(
    original,
    { ...last, categoryId: "expense-transport" },
    true,
  );
  assert.equal(
    forecast(moved, { categoryId: "expense-food" }).history.at(-1).expenseMinor,
    0,
  );
  const movedDate = m.saveTransaction(
    original,
    { ...last, date: "2026-10-01" },
    true,
  );
  assert.equal(forecast(movedDate).history.at(-1).expenseMinor, 0);
  assert.equal(forecast(movedDate).partialMonth.expenseMinor, 10000);
});

test("a held-out target or excluded gap can alter errors later but cannot alter its fold prediction or cap", () => {
  const history = numericHistory([100, 200, 300, 400, 500, 600, 700, 800]);
  const original = f.backtestExpenseHistory(history);
  for (const index of [3, 4]) {
    const changed = history.map((row, i) =>
        i === index ? { ...row, expenseMinor: 999999999 } : row,
      ),
      result = f.backtestExpenseHistory(changed);
    for (let method = 0; method < 3; method++) {
      const a = original.candidates[method].folds[0],
        b = result.candidates[method].folds[0];
      assert.equal(b.predictedMinor, a.predictedMinor);
      assert.equal(b.capMinor, a.capMinor);
      assert.equal(b.capMinor, 600);
      if (index === 4)
        assert.notEqual(b.absoluteErrorMinor, a.absoluteErrorMinor);
    }
  }
});

test("method selection uses exact unrounded tolerance and declared simplicity, independent of input order", () => {
  const candidates = (last, mean, trend) => [
    { method: "last-value", foldCount: 10, totalAbsoluteErrorMinor: last },
    { method: "mean-three", foldCount: 10, totalAbsoluteErrorMinor: mean },
    { method: "damped-trend", foldCount: 10, totalAbsoluteErrorMinor: trend },
  ];
  assert.equal(
    f.selectForecastMethod(candidates(1000, 970, 960)),
    "last-value",
  );
  assert.equal(
    f.selectForecastMethod(candidates(1020, 1000, 960)),
    "mean-three",
  );
  assert.equal(
    f.selectForecastMethod(candidates(1050, 1030, 960)),
    "damped-trend",
  );
  assert.equal(f.selectForecastMethod(candidates(10, 0, 0)), "last-value"); // one minor MAE tolerance
  assert.equal(
    f.selectForecastMethod(candidates(1000, 970, 960).reverse()),
    "last-value",
  );
  assert.equal(
    f.selectForecastMethod(candidates(1009, 1008, 960)),
    "mean-three",
  ); // 100.8 is exactly 5% above96;100.9 is outside
  assert.equal(
    f.backtestExpenseHistory(numericHistory([1, 2, 3, 4, 5, 6, 7, 8]))
      .selectedMethod,
    "last-value",
  );
});

test("negative trends clip to zero, outliers remain bounded, and the cap uses only the most recent six", () => {
  for (let lead = 1; lead <= 7; lead++)
    assert.equal(
      f.predictExpensePrefix(
        [600, 500, 400, 300, 200, 100],
        "damped-trend",
        lead,
      ).predictedMinor,
      lead === 1 ? 20 : 0,
    );
  for (const method of f.FORECAST_METHODS) {
    const value = f.predictExpensePrefix(
      [999999999, 100, 100, 100, 100, 100, 100],
      method.id,
      7,
    );
    assert.equal(value.capMinor, 200);
    assert.equal(value.predictedMinor, 100);
  }
  for (let lead = 1; lead <= 7; lead++) {
    const value = f.predictExpensePrefix(
      [1, 1, 1, 1, 1, 999999999],
      "damped-trend",
      lead,
    );
    assert.ok(
      value.predictedMinor >= 0 && value.predictedMinor <= value.capMinor,
    );
    assert.equal(value.capMinor, 1999999998);
  }
});

test("rounding happens once in minor units and works for JPY and every supported wallet currency", () => {
  const yen = forecast(
    ledgerFrom(
      Array.from({ length: 18 }, (_, i) => 100 + 10 * i),
      { currency: "JPY" },
    ),
  );
  assert.equal(yen.currency, "JPY");
  assert.equal(yen.selectedMethod, "damped-trend");
  assert.equal(yen.backtest.selectedMaeMinor, 6);
  assert.deepEqual(
    yen.forecast.map((row) => row.predictedMinor),
    [284, 290, 294, 297, 300, 302],
  );
  assert.equal(
    f.predictExpensePrefix([0, 0, 1], "mean-three", 2).predictedMinor,
    0,
  );
  assert.equal(
    f.predictExpensePrefix([0, 1, 1], "mean-three", 2).predictedMinor,
    1,
  );
  for (const currency of m.CURRENCIES) {
    const result = forecast(
      ledgerFrom(Array(18).fill(100), { currency: currency.code }),
    );
    assert.equal(result.currency, currency.code);
    assert.ok(result.forecast.every((row) => row.predictedMinor === 100));
  }
});

test("large legal aggregates stay exact safe integers and public results contain no BigInt", () => {
  const maximum = f.MAX_MONTH_EXPENSE_MINOR;
  for (const method of f.FORECAST_METHODS) {
    const result = f.predictExpensePrefix(Array(6).fill(maximum), method.id, 7);
    assert.equal(result.predictedMinor, maximum);
    assert.equal(result.capMinor, 2 * maximum);
    assert.ok(Number.isSafeInteger(result.predictedMinor));
    assert.doesNotThrow(() => JSON.stringify(result));
  }
  const result = f.backtestExpenseHistory(
    numericHistory([maximum, 0, maximum, 0, maximum, 0, maximum, 0]),
  );
  assert.ok(
    result.candidates.every(
      (candidate) =>
        Number.isFinite(candidate.maeMinor) &&
        Number.isSafeInteger(candidate.totalAbsoluteErrorMinor),
    ),
  );
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("exact rational trend half-ties round up even near the maximum legal aggregate", () => {
  // OLS over [0,0,15] has lastFit12.5 and slope7.5; lead1 adds6 =>18.5.
  assert.equal(
    f.predictExpensePrefix([0, 0, 15], "damped-trend", 1).predictedMinor,
    19,
  );
  const offset = f.MAX_MONTH_EXPENSE_MINOR - 15;
  assert.equal(
    f.predictExpensePrefix([offset, offset, offset + 15], "damped-trend", 1)
      .predictedMinor,
    offset + 19,
  );
});

test("backtest MAE retains fractional minor units rather than rounding before method comparison", () => {
  const result = f.backtestExpenseHistory(
    numericHistory([1, 1, 1, 1, 1, 1, 2, 2]),
  );
  assert.equal(result.candidates[0].totalAbsoluteErrorMinor, 2);
  assert.equal(result.candidates[0].foldCount, 4);
  assert.equal(result.candidates[0].maeMinor, 0.5);
  assert.equal(result.selectedMethod, "last-value");
});

test("calendar ordering, leap day and as-of month end keep the complete/partial/future boundary", () => {
  let ledger = ledgerFrom(Array(8).fill(100), { start: "2023-06" });
  ledger = transaction(ledger, "leap", "expense", "2024-02-29", 500);
  const leap = forecast(ledger, { asOfDate: "2024-02-29" });
  assert.equal(leap.trainingCutoff, "2024-01-31");
  assert.equal(leap.history.length, 8);
  assert.equal(leap.partialMonth.expenseMinor, 500);
  assert.equal(leap.forecast[0].month, "2024-03");
  const march = forecast(ledger, { asOfDate: "2024-03-01" });
  assert.equal(march.trainingCutoff, "2024-02-29");
  assert.equal(march.history.at(-1).expenseMinor, 500);
  assert.equal(march.forecast[0].month, "2024-04");
  const monthEnd = forecast(ledgerFrom(Array(18).fill(100)), {
    asOfDate: "2026-10-31",
  });
  assert.equal(monthEnd.trainingCutoff, "2026-09-30");
  assert.equal(monthEnd.forecast[0].month, "2026-11");
  assert.deepEqual(
    forecast(ledgerFrom(Array(8).fill(100), { start: "2026-02" })).history.map(
      (row) => row.month,
    ),
    [
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ],
  );
});

test("supported boundary months and explicit horizons cannot overflow or silently shorten", () => {
  const start = forecast(ledgerFrom([]), { asOfDate: "1900-01-01" });
  assert.equal(start.trainingCutoff, null);
  assert.equal(start.status, "insufficient-history");
  const ledger = ledgerFrom(Array(8).fill(100), { start: "2100-03" }),
    last = forecast(ledger, { asOfDate: "2100-11-01", horizon: 1 });
  assert.equal(last.forecast.length, 1);
  assert.equal(last.forecast[0].month, "2100-12");
  assert.throws(
    () => forecast(ledger, { asOfDate: "2100-11-01", horizon: 2 }),
    /horizon/,
  );
  assert.throws(
    () => forecast(ledger, { asOfDate: "2100-12-31", horizon: 1 }),
    /horizon/,
  );
  assert.equal(
    forecast(ledgerFrom(Array(18).fill(100)), { horizon: 1 }).forecast.length,
    1,
  );
});

test("long dormant histories retain zero months and do not claim completeness or guaranteed accuracy", () => {
  let ledger = ledgerFrom([100], { start: "1900-01" });
  ledger = transaction(ledger, "middle", "expense", "1950-01-01", 100);
  ledger = transaction(ledger, "recent", "expense", "2000-01-01", 100);
  const result = forecast(ledger, { asOfDate: "2100-06-01" });
  assert.equal(result.history.length, 2405);
  assert.equal(result.status, "available");
  assert.ok(result.forecast.every((row) => row.predictedMinor === 0));
  assert.equal(result.backtest.baselineMaeMinor, 0);
  assert.equal(result.backtest.relativeImprovementPercent, null);
  assert.match(result.message, /not a guarantee/);
});

test("repeated calls are deterministic and frozen snapshots do not mutate the original ledger", () => {
  const ledger = ledgerFrom(Array(18).fill(10000)),
    raw = JSON.stringify(ledger);
  deepFreeze(ledger);
  const first = forecast(ledger),
    second = forecast(ledger);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(ledger), raw);
  assert.ok(Object.isFrozen(first.history));
  assert.ok(Object.isFrozen(first.backtest.candidates[0].folds[0]));
  assert.doesNotThrow(() => JSON.stringify(first));
});

test("invalid dates, category/type choices, horizons, histories and candidate comparisons fail explicitly", () => {
  const ledger = ledgerFrom(Array(18).fill(100));
  for (const asOfDate of [
    "2026-02-30",
    "2026-1-01",
    "1899-12-31",
    "2101-01-01",
    "not a date",
    null,
  ])
    assert.throws(() => forecast(ledger, { asOfDate }));
  for (const horizon of [0, 7, 1.5, "6", NaN, Infinity, null])
    assert.throws(() => forecast(ledger, { horizon }));
  for (const categoryId of ["absent", "income-salary", "debt-loan", ""])
    assert.throws(() => forecast(ledger, { categoryId }), /expense category/);
  for (const values of [
    [1, 2],
    [1, 2, -1],
    [1, 2, 0.1],
    [1, 2, NaN],
    [1, 2, Infinity],
    [1, 2, f.MAX_MONTH_EXPENSE_MINOR + 1],
  ])
    assert.throws(() => f.predictExpensePrefix(values, "last-value", 2));
  assert.throws(() => f.predictExpensePrefix([1, 2, 3], "Prophet", 2));
  assert.throws(() => f.predictExpensePrefix([1, 2, 3], "last-value", 8));
  assert.throws(
    () => f.backtestExpenseHistory(numericHistory([1, 2, 3, 4, 5]).reverse()),
    /chronological/,
  );
  const missing = numericHistory([1, 2, 3, 4, 5, 6]);
  missing.splice(2, 1);
  assert.throws(() => f.backtestExpenseHistory(missing), /consecutive/);
  assert.throws(() => f.selectForecastMethod([]));
  assert.throws(() =>
    f.selectForecastMethod([
      { method: "last-value", foldCount: 4, totalAbsoluteErrorMinor: 0 },
      { method: "mean-three", foldCount: 3, totalAbsoluteErrorMinor: 0 },
      { method: "damped-trend", foldCount: 4, totalAbsoluteErrorMinor: 0 },
    ]),
  );
  assert.throws(() =>
    f.forecastRecordedExpenses(
      { ...ledger, version: 99 },
      { asOfDate: "2026-10-18" },
    ),
  );
});
