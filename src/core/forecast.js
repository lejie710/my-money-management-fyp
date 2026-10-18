const {
  validateLedger,
  validDate,
  MAX_AMOUNT_MINOR,
  MAX_TRANSACTIONS,
} = require("./model");
const { periodReport, monthlySeries } = require("./reports");

const FORECAST_VERSION = "recorded-expense-baselines-v1";
const MIN_COMPLETE_MONTHS = 8;
const MIN_ACTIVE_MONTHS = 3;
const MAX_HORIZON = 6;
const MAX_HISTORY_MONTHS = 201 * 12;
const MAX_MONTH_EXPENSE_MINOR = MAX_AMOUNT_MINOR * MAX_TRANSACTIONS;
const MIN_MONTH = 1900 * 12;
const MAX_MONTH = 2100 * 12 + 11;
const FORECAST_METHODS = Object.freeze([
  Object.freeze({ id: "last-value", label: "Last completed month" }),
  Object.freeze({ id: "mean-three", label: "Trailing three-month mean" }),
  Object.freeze({ id: "damped-trend", label: "Damped local trend" }),
]);

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function monthOrdinal(month) {
  if (typeof month !== "string" || !validDate(`${month}-01`))
    throw new Error("Choose a supported calendar month as YYYY-MM.");
  const [year, number] = month.split("-").map(Number);
  return year * 12 + number - 1;
}

function monthName(ordinal) {
  if (!Number.isInteger(ordinal) || ordinal < MIN_MONTH || ordinal > MAX_MONTH)
    throw new Error("The forecast horizon must remain within 1900 to 2100.");
  return `${Math.floor(ordinal / 12)}-${String((ordinal % 12) + 1).padStart(2, "0")}`;
}

function monthEnd(ordinal) {
  const month = monthName(ordinal);
  const [year, number] = month.split("-").map(Number);
  const day = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}

function validateValues(values, minimum = 3) {
  if (
    !Array.isArray(values) ||
    values.length < minimum ||
    values.length > MAX_HISTORY_MONTHS ||
    !values.every(
      (value) =>
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= MAX_MONTH_EXPENSE_MINOR,
    )
  ) {
    throw new Error(
      `Expense history needs ${minimum} to ${MAX_HISTORY_MONTHS} nonnegative exact minor-unit observations within the recorded-ledger limit.`,
    );
  }
}

// Exact rational calculations avoid monetary half-tie drift at large amounts.
// BigInt is private; every public money value remains a JSON-safe Number.
function roundedBounded(numerator, denominator, capMinor) {
  if (denominator <= 0n)
    throw new Error("The prediction denominator is invalid.");
  const cap = BigInt(capMinor);
  if (numerator <= 0n) return 0;
  if (numerator >= cap * denominator) return capMinor;
  const whole = numerator / denominator;
  const result = Number(
    whole + (2n * (numerator % denominator) >= denominator ? 1n : 0n),
  );
  if (!Number.isSafeInteger(result) || result < 0 || result > capMinor)
    throw new Error("Prediction exceeds the supported exact-integer range.");
  return result;
}

function predictExpensePrefix(values, method, lead) {
  validateValues(values);
  if (!FORECAST_METHODS.some((item) => item.id === method))
    throw new Error("Choose a supported recorded-expense method.");
  if (!Number.isInteger(lead) || lead < 1 || lead > MAX_HORIZON + 1)
    throw new Error(
      "Prediction lead must be an integer from one to seven months.",
    );
  const local = values.slice(-6);
  const capMinor = 2 * Math.max(...local);
  if (!Number.isSafeInteger(capMinor))
    throw new Error(
      "Prediction bound exceeds the supported exact-integer range.",
    );
  let numerator, denominator;
  if (method === "last-value") {
    numerator = BigInt(values[values.length - 1]);
    denominator = 1n;
  } else if (method === "mean-three") {
    numerator = values
      .slice(-3)
      .reduce((sum, value) => sum + BigInt(value), 0n);
    denominator = 3n;
  } else {
    const m = BigInt(local.length);
    let sum = 0n,
      cross = 0n,
      centeredSquares = 0n;
    for (let index = 0; index < local.length; index += 1) {
      const centered = 2n * BigInt(index) - (m - 1n);
      const value = BigInt(local[index]);
      sum += value;
      cross += centered * value;
      centeredSquares += centered * centered;
    }
    // b = 2*cross/centeredSquares; phi = 4/5 exactly.
    const dampingDenominator = 5n ** BigInt(lead);
    let dampingNumerator = 0n;
    for (let step = 1; step <= lead; step += 1)
      dampingNumerator += 4n ** BigInt(step) * 5n ** BigInt(lead - step);
    numerator =
      (sum * centeredSquares + cross * (m - 1n) * m) * dampingDenominator +
      2n * cross * m * dampingNumerator;
    denominator = m * centeredSquares * dampingDenominator;
  }
  return {
    predictedMinor: roundedBounded(numerator, denominator, capMinor),
    capMinor,
  };
}

function selectForecastMethod(candidates) {
  if (
    !Array.isArray(candidates) ||
    candidates.length !== FORECAST_METHODS.length
  )
    throw new Error("Compare all three forecast candidates.");
  const byId = new Map(
    candidates.map((candidate) => [candidate?.method, candidate]),
  );
  if (byId.size !== FORECAST_METHODS.length)
    throw new Error("Forecast candidate IDs must be unique.");
  const count = candidates[0]?.foldCount;
  if (!Number.isInteger(count) || count < 1 || count > 12)
    throw new Error("Forecast comparison requires one to twelve common folds.");
  for (const { id } of FORECAST_METHODS) {
    const candidate = byId.get(id);
    if (
      !candidate ||
      candidate.foldCount !== count ||
      !Number.isSafeInteger(candidate.totalAbsoluteErrorMinor) ||
      candidate.totalAbsoluteErrorMinor < 0
    )
      throw new Error(
        "Forecast candidates must use valid error totals and identical folds.",
      );
  }
  const best = candidates.reduce(
    (value, candidate) => Math.min(value, candidate.totalAbsoluteErrorMinor),
    Number.MAX_SAFE_INTEGER,
  );
  // MAE tolerance max(1, 5% of best) converted to an exact sum-of-errors comparison.
  const threshold =
    BigInt(best) > BigInt(20 * count) ? BigInt(best) : BigInt(20 * count);
  return FORECAST_METHODS.find(
    ({ id }) =>
      20n * BigInt(byId.get(id).totalAbsoluteErrorMinor - best) <= threshold,
  ).id;
}

function backtestExpenseHistory(history) {
  if (!Array.isArray(history))
    throw new Error(
      "Expense history must be an array of calendar observations.",
    );
  validateValues(
    history.map((row) => row?.expenseMinor),
    5,
  );
  const months = history.map((row) => monthOrdinal(row?.month));
  if (
    months.some((month, index) => index > 0 && month !== months[index - 1] + 1)
  )
    throw new Error(
      "Backtest history must contain consecutive chronological months, including zero months.",
    );
  const values = history.map((row) => row.expenseMinor);
  const firstOrigin = Math.max(3, history.length - 13);
  const candidates = FORECAST_METHODS.map(({ id, label }) => {
    const folds = [];
    let totalAbsoluteErrorMinor = 0;
    for (let n = firstOrigin; n <= history.length - 2; n += 1) {
      const prediction = predictExpensePrefix(values.slice(0, n), id, 2);
      const actualMinor = values[n + 1];
      const absoluteErrorMinor = Math.abs(
        prediction.predictedMinor - actualMinor,
      );
      totalAbsoluteErrorMinor += absoluteErrorMinor;
      if (!Number.isSafeInteger(totalAbsoluteErrorMinor))
        throw new Error(
          "Backtest error sum exceeds the supported exact-integer range.",
        );
      folds.push({
        trainingMonths: n,
        trainingThroughMonth: history[n - 1].month,
        excludedGapMonth: history[n].month,
        targetMonth: history[n + 1].month,
        lead: 2,
        actualMinor,
        ...prediction,
        absoluteErrorMinor,
      });
    }
    return {
      method: id,
      label,
      foldCount: folds.length,
      totalAbsoluteErrorMinor,
      maeMinor: totalAbsoluteErrorMinor / folds.length,
      folds,
    };
  });
  const selectedMethod = selectForecastMethod(candidates);
  const selected = candidates.find(
    (candidate) => candidate.method === selectedMethod,
  );
  const baseline = candidates[0];
  return freeze({
    metricLabel: "Two-month-ahead MAE",
    lead: 2,
    foldCount: baseline.foldCount,
    firstTargetMonth: baseline.folds[0].targetMonth,
    lastTargetMonth: baseline.folds[baseline.folds.length - 1].targetMonth,
    selectedMethod,
    baselineMaeMinor: baseline.maeMinor,
    selectedMaeMinor: selected.maeMinor,
    relativeImprovementPercent:
      baseline.totalAbsoluteErrorMinor === 0
        ? null
        : (100 *
            (baseline.totalAbsoluteErrorMinor -
              selected.totalAbsoluteErrorMinor)) /
          baseline.totalAbsoluteErrorMinor,
    candidates,
  });
}

function forecastRecordedExpenses(ledger, options) {
  validateLedger(ledger);
  if (!options || !validDate(options.asOfDate))
    throw new Error(
      "Choose a real as-of date as YYYY-MM-DD, within 1900 to 2100.",
    );
  const asOfDate = options.asOfDate,
    horizon = options.horizon === undefined ? 6 : options.horizon;
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > MAX_HORIZON)
    throw new Error(
      "Forecast horizon must be a whole number from one to six months.",
    );
  const categoryId = options.categoryId ?? null;
  const category =
    categoryId === null
      ? null
      : ledger.categories.find(
          (item) => item.id === categoryId && item.type === "expense",
        );
  if (categoryId !== null && !category)
    throw new Error("Choose an existing expense category for this forecast.");
  const asOfMonth = asOfDate.slice(0, 7),
    currentOrdinal = monthOrdinal(asOfMonth);
  const futureMonths = Array.from({ length: horizon }, (_, index) =>
    monthName(currentOrdinal + index + 1),
  );
  const trainingCutoff =
    currentOrdinal === MIN_MONTH ? null : monthEnd(currentOrdinal - 1);
  const selectedTransactions = ledger.transactions.filter(
    (tx) =>
      tx.type === "expense" &&
      (categoryId === null || tx.categoryId === categoryId),
  );
  const selectedLedger = { ...ledger, transactions: selectedTransactions };
  const completed =
    trainingCutoff === null
      ? []
      : selectedTransactions.filter((tx) => tx.date <= trainingCutoff);
  const earliest = completed.reduce(
    (value, tx) => (value === null || tx.date < value ? tx.date : value),
    null,
  );
  const history =
    earliest === null
      ? []
      : monthlySeries(
          selectedLedger,
          `${earliest.slice(0, 7)}-01`,
          trainingCutoff,
        ).map((row) => ({
          month: row.month,
          expenseMinor: row.expenseMinor,
          transactionCount: row.transactionCount,
        }));
  const partialReport = periodReport(
    selectedLedger,
    `${asOfMonth}-01`,
    asOfDate,
  );
  const lastRecordedExpenseMonth = selectedTransactions
    .filter((tx) => tx.date <= asOfDate)
    .reduce(
      (value, tx) =>
        value === null || tx.date.slice(0, 7) > value
          ? tx.date.slice(0, 7)
          : value,
      null,
    );
  const lastTrainingExpenseMonth =
    history.filter((row) => row.transactionCount > 0).at(-1)?.month ?? null;
  const activeMonths = history.filter((row) => row.transactionCount > 0).length;
  const base = {
    configurationVersion: FORECAST_VERSION,
    target: "recorded-expenses",
    currency: ledger.wallet.currency,
    filter: category
      ? {
          kind: "category",
          categoryId: category.id,
          categoryName: category.name,
        }
      : { kind: "all", categoryId: null, categoryName: null },
    asOfDate,
    trainingCutoff,
    horizon,
    history,
    partialMonth: {
      month: asOfMonth,
      startDate: `${asOfMonth}-01`,
      throughDate: asOfDate,
      expenseMinor: partialReport.expenseMinor,
      transactionCount: partialReport.transactionCount,
      excludedFromTraining: true,
    },
    lastRecordedExpenseMonth,
    lastTrainingExpenseMonth,
    eligibility: {
      completedMonths: history.length,
      activeMonths,
      minimumCompletedMonths: MIN_COMPLETE_MONTHS,
      minimumActiveMonths: MIN_ACTIVE_MONTHS,
    },
  };
  let reason = null;
  if (!history.length) reason = "no-completed-expenses";
  else if (history.length < MIN_COMPLETE_MONTHS)
    reason = "too-few-completed-months";
  else if (activeMonths < MIN_ACTIVE_MONTHS) reason = "too-few-active-months";
  if (reason)
    return freeze({
      ...base,
      status: "insufficient-history",
      reason,
      message:
        reason === "no-completed-expenses"
          ? "No selected expense records exist in completed months."
          : reason === "too-few-completed-months"
            ? `At least eight completed calendar months are needed; ${history.length} are recorded.`
            : `At least three completed months with selected expense records are needed; ${activeMonths} are recorded.`,
      selectedMethod: null,
      backtest: null,
      forecast: [],
    });
  const backtest = backtestExpenseHistory(history);
  const values = history.map((row) => row.expenseMinor);
  const forecast = futureMonths.map((month, index) => ({
    month,
    lead: index + 2,
    ...predictExpensePrefix(values, backtest.selectedMethod, index + 2),
  }));
  return freeze({
    ...base,
    status: "available",
    reason: null,
    message:
      "Projection of recorded expenses only. The current partial month is excluded; historical error is not a guarantee of future accuracy.",
    selectedMethod: backtest.selectedMethod,
    backtest,
    forecast,
  });
}

module.exports = {
  FORECAST_VERSION,
  MIN_COMPLETE_MONTHS,
  MIN_ACTIVE_MONTHS,
  MAX_HORIZON,
  MAX_MONTH_EXPENSE_MINOR,
  FORECAST_METHODS,
  predictExpensePrefix,
  selectForecastMethod,
  backtestExpenseHistory,
  forecastRecordedExpenses,
};
