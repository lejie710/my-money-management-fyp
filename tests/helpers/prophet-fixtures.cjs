const { VERSION, SETTINGS } = require('../../src/forecast/protocol');
const { createEmptyLedger, saveTransaction } = require('../../src/core/model');
const { forecastRecordedExpenses } = require('../../src/core/forecast');
const provider = {
  engine: 'prophet',
  processing: 'local',
  version: VERSION,
  maxHistoryMonths: 120,
};
const configuration = {
  version: 2,
  runId: 'forecast-test',
  url: 'http://127.0.0.1:8787/v1/recognize',
  token: 'p'.repeat(43),
  providers: { ocr: null, assistant: null, forecast: provider },
};
function input() {
  return {
    version: VERSION,
    currency: 'MYR',
    asOfDate: '2026-10-18',
    history: Array.from({ length: 18 }, (_, i) => {
      const n = 2025 * 12 + 3 + i;
      return {
        month: `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`,
        expenseMinor: 10000 + 1000 * i,
      };
    }),
    targetMonths: ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04'],
  };
}
function wire(id = 'forecast_test_request_001') {
  return { ...input(), requestId: id };
}
function result(request = wire(), values = [29000, 30000, 31000, 32000, 33000, 34000]) {
  return {
    version: VERSION,
    requestId: request.requestId,
    provider: 'prophet',
    currency: request.currency,
    asOfDate: request.asOfDate,
    trainingThroughMonth: request.history.at(-1).month,
    trainingMonths: request.history.length,
    predictionUnit: 'currency-minor-unit',
    rounding: 'half-away-from-zero',
    negativePredictionPolicy: 'preserve-and-label',
    hasNegativePredictions: values.some((v) => v < 0),
    intervals: null,
    settings: { ...SETTINGS },
    forecast: request.targetMonths.map((month, i) => ({
      month,
      lead: i + 2,
      predictedMinor: values[i],
    })),
  };
}
function ledger() {
  let value = createEmptyLedger({ name: 'Fictional reference wallet' });
  for (const [index, row] of input().history.entries())
    value = saveTransaction(value, {
      id: `forecast-${index}`,
      walletId: value.wallet.id,
      type: 'expense',
      title: 'Private title is excluded',
      date: row.month + '-15',
      categoryId: 'expense-food',
      amountMinor: row.expenseMinor,
    });
  return value;
}
function localForecast() {
  return forecastRecordedExpenses(ledger(), { asOfDate: '2026-10-18' });
}
module.exports = { provider, configuration, input, wire, result, ledger, localForecast };
