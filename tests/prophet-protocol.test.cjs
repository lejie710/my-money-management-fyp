const test = require('node:test');
const assert = require('node:assert/strict');
const {
  inputFromForecast,
  validateInput,
  validateWire,
  validateResult,
  ForecastError,
} = require('../src/forecast/protocol');
const f = require('./helpers/prophet-fixtures.cjs');
const clone = (x) => JSON.parse(JSON.stringify(x));
test('selected history contains only exact completed monthly expenses and frozen month targets', () => {
  const local = f.localForecast();
  const before = JSON.stringify(local);
  const value = inputFromForecast(local);
  assert.deepEqual(value, f.input());
  assert.equal(JSON.stringify(local), before);
  assert.equal(JSON.stringify(value).includes('Private title'), false);
  assert.deepEqual(Object.keys(value).sort(), [
    'asOfDate',
    'currency',
    'history',
    'targetMonths',
    'version',
  ]);
  assert.ok(Object.isFrozen(value.history[0]));
});
test('wire guards malformed shapes, Unicode dates, leading zeros, gaps and future or partial-month data', () => {
  for (const mutate of [
    (v) => {
      v.extra = 'private';
    },
    (v) => {
      v.requestId = '../bad';
    },
    (v) => {
      v.history[0].expenseMinor = true;
    },
    (v) => {
      v.history[0].expenseMinor = 0;
    },
    (v) => {
      v.history[0].month = '٢٠٢٥-٠٤';
    },
    (v) => {
      v.history[1].month = v.history[0].month;
    },
    (v) => {
      v.history.at(-1).month = '2026-10';
    },
    (v) => {
      v.targetMonths[0] = '2026-10';
    },
    (v) => {
      v.currency = [];
    },
    (v) => {
      v.asOfDate = '2026-02-30';
    },
  ]) {
    const value = f.wire();
    mutate(value);
    assert.throws(() => validateWire(value), ForecastError);
  }
});
test('history limits reject short, padded or oversized data without silent truncation', () => {
  for (const count of [0, 7, 121]) {
    const value = f.input();
    value.history =
      count === 121 ? Array(121).fill(value.history[0]) : value.history.slice(-count || 100);
    assert.throws(() => validateInput(value), ForecastError);
  }
  const value = f.input();
  value.history.slice(2).forEach((row) => {
    row.expenseMinor = 0;
  });
  assert.throws(() => validateInput(value), /three completed/);
});
test('response must match request identity, currency, calendar, fixed settings and exact integer amounts', () => {
  const request = f.wire();
  assert.deepEqual(validateResult(f.result(request), request), f.result(request));
  for (const mutate of [
    (v) => {
      v.requestId = 'another_request_000';
    },
    (v) => {
      v.currency = 'JPY';
    },
    (v) => {
      v.forecast[0].month = '2026-10';
    },
    (v) => {
      v.forecast[0].lead = 1;
    },
    (v) => {
      v.forecast[0].predictedMinor = 1.2;
    },
    (v) => {
      v.forecast[0].predictedMinor = NaN;
    },
    (v) => {
      v.intervals = [1, 2];
    },
    (v) => {
      v.settings.yearly_seasonality = true;
    },
    (v) => {
      v.trainingMonths = 19;
    },
  ]) {
    const value = clone(f.result(request));
    mutate(value);
    assert.throws(() => validateResult(value, request), ForecastError);
  }
});
test('negative predictions are preserved explicitly and cannot lose their warning', () => {
  const request = f.wire();
  const value = f.result(request, [-13, 0, 1, 2, 3, 4]);
  assert.equal(validateResult(value, request).forecast[0].predictedMinor, -13);
  value.hasNegativePredictions = false;
  assert.throws(() => validateResult(value, request), ForecastError);
});
