const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/core/model');
const {
  CALCULATION_VERSION,
  MAX_PRINCIPAL_MINOR,
  RATE_SCALE,
  MAX_ANNUAL_RATE_UNITS,
  MAX_TERM_MONTHS,
  parseAnnualRate,
  formatAnnualRate,
  parseTermMonths,
  calculateLoan,
} = require('../src/core/loan');

function assertSchedule(result) {
  assert.equal(result.calculationVersion, CALCULATION_VERSION);
  assert.equal(result.schedule.length, result.actualTermMonths);
  assert.equal(result.requestedTermMonths, result.inputs.termMonths);
  assert.equal(result.paidOffEarly, result.actualTermMonths < result.requestedTermMonths);
  assert.ok(result.actualTermMonths >= 1 && result.actualTermMonths <= MAX_TERM_MONTHS);
  let expectedOpening = result.inputs.principalMinor;
  let principalSum = 0;
  let interestSum = 0;
  let paymentSum = 0;
  for (const [index, row] of result.schedule.entries()) {
    assert.equal(row.month, index + 1);
    assert.equal(row.openingBalanceMinor, expectedOpening);
    for (const value of Object.values(row)) {
      assert.equal(Number.isSafeInteger(value), true);
      assert.ok(value >= 0);
    }
    // Independent half-up form, using the CURRENT balance and the nominal monthly rate.
    const exactInterest =
      (2n * BigInt(row.openingBalanceMinor) * BigInt(result.inputs.annualRateUnits) + 12000000n) /
      24000000n;
    assert.equal(row.interestMinor, Number(exactInterest));
    assert.equal(row.paymentMinor, row.interestMinor + row.principalPaidMinor);
    assert.equal(row.closingBalanceMinor, row.openingBalanceMinor - row.principalPaidMinor);
    assert.ok(row.principalPaidMinor > 0);
    assert.ok(row.closingBalanceMinor < row.openingBalanceMinor);
    if (index < result.schedule.length - 1)
      assert.equal(row.paymentMinor, result.regularPaymentMinor);
    expectedOpening = row.closingBalanceMinor;
    principalSum += row.principalPaidMinor;
    interestSum += row.interestMinor;
    paymentSum += row.paymentMinor;
  }
  assert.equal(expectedOpening, 0);
  assert.equal(principalSum, result.inputs.principalMinor);
  assert.equal(interestSum, result.totalInterestMinor);
  assert.equal(paymentSum, result.totalPaidMinor);
  assert.equal(result.totalPaidMinor, result.inputs.principalMinor + result.totalInterestMinor);
  assert.equal(result.finalPaymentMinor, result.schedule.at(-1).paymentMinor);
}

test('annual-rate parser and formatter retain exact four-decimal percentage units', () => {
  assert.equal(RATE_SCALE, 10000);
  assert.equal(MAX_ANNUAL_RATE_UNITS, 1000000);
  for (const [text, expected] of [
    ['0', 0],
    ['0.0000', 0],
    ['0.0001', 1],
    ['1', 10000],
    [' 005.2500 ', 52500],
    ['12', 120000],
    ['12.3456', 123456],
    ['100.0000', 1000000],
  ])
    assert.equal(parseAnnualRate(text), expected);
  assert.equal(formatAnnualRate(52500), '5.25');
  assert.equal(formatAnnualRate(1), '0.0001');
  assert.equal(formatAnnualRate(0), '0');
  assert.equal(formatAnnualRate(1000000), '100');
  for (const units of [0, 1, 100, 10000, 12345, 123456, 1000000]) {
    assert.equal(parseAnnualRate(formatAnnualRate(units)), units);
  }
});

test('rate parser rejects ambiguous, nonfinite, over-precision and out-of-bound inputs', () => {
  for (const input of [
    '',
    '-0',
    '-1',
    '+1',
    '.5',
    '1.',
    '1e2',
    '1,000',
    '12%',
    '100.0001',
    '0.00001',
    '101',
    'NaN',
    'Infinity',
    12,
    null,
    '9'.repeat(100),
  ]) {
    assert.throws(() => parseAnnualRate(input), undefined, String(input));
  }
  for (const units of [-1, 0.5, NaN, Infinity, 1000001, '50000'])
    assert.throws(() => formatAnnualRate(units));
});

test('term parser accepts whole months from one through six hundred', () => {
  assert.equal(MAX_TERM_MONTHS, 600);
  assert.equal(parseTermMonths('1'), 1);
  assert.equal(parseTermMonths(' 0012 '), 12);
  assert.equal(parseTermMonths('600'), 600);
  for (const input of [
    '',
    '0',
    '-1',
    '+1',
    '12.0',
    '1.5',
    '1e2',
    '12 months',
    '601',
    'Infinity',
    null,
    12,
    '9'.repeat(100),
  ]) {
    assert.throws(() => parseTermMonths(input), undefined, String(input));
  }
});

// Anchors calculated independently with Python Decimal at precision 120, ROUND_HALF_UP.
const fixtures = [
  {
    name: 'zero-rate 1200 over12 months gives100 per month and no interest',
    input: { principalMinor: 120000, annualRateUnits: 0, termMonths: 12 },
    expected: {
      regularPaymentMinor: 10000,
      finalPaymentMinor: 10000,
      totalPaidMinor: 120000,
      totalInterestMinor: 0,
      actualTermMonths: 12,
    },
  },
  {
    name: '1200 at12percent for12 months matches the independent Decimal schedule',
    input: { principalMinor: 120000, annualRateUnits: 120000, termMonths: 12 },
    expected: {
      regularPaymentMinor: 10662,
      finalPaymentMinor: 10660,
      totalPaidMinor: 127942,
      totalInterestMinor: 7942,
      actualTermMonths: 12,
    },
  },
  {
    name: '10000 at5percent for36 months matches the independent Decimal schedule',
    input: { principalMinor: 1000000, annualRateUnits: 50000, termMonths: 36 },
    expected: {
      regularPaymentMinor: 29971,
      finalPaymentMinor: 29969,
      totalPaidMinor: 1078954,
      totalInterestMinor: 78954,
      actualTermMonths: 36,
    },
  },
  {
    name: 'final adjustment can exceed the regular payment without leaving unpaid principal',
    input: { principalMinor: 10000, annualRateUnits: 10000, termMonths: 36 },
    expected: {
      regularPaymentMinor: 282,
      finalPaymentMinor: 285,
      totalPaidMinor: 10155,
      totalInterestMinor: 155,
      actualTermMonths: 36,
    },
  },
  {
    name: 'tiny whole-yen loan reports early payoff caused by minor-unit rounding',
    input: { principalMinor: 2, annualRateUnits: 0, termMonths: 3 },
    expected: {
      regularPaymentMinor: 1,
      finalPaymentMinor: 1,
      totalPaidMinor: 2,
      totalInterestMinor: 0,
      actualTermMonths: 2,
    },
  },
  {
    name: 'maximum principal and600-month zero-rate term remain exact',
    input: { principalMinor: 999999999, annualRateUnits: 0, termMonths: 600 },
    expected: {
      regularPaymentMinor: 1666667,
      finalPaymentMinor: 1666466,
      totalPaidMinor: 999999999,
      totalInterestMinor: 0,
      actualTermMonths: 600,
    },
  },
  {
    name: 'smallest positive annual rate avoids cancellation and discloses rounded early payoff',
    input: { principalMinor: 100000, annualRateUnits: 1, termMonths: 600 },
    expected: {
      regularPaymentMinor: 167,
      finalPaymentMinor: 134,
      totalPaidMinor: 100000,
      totalInterestMinor: 0,
      actualTermMonths: 599,
    },
  },
];

for (const fixture of fixtures) {
  test(fixture.name, () => {
    const result = calculateLoan(fixture.input);
    for (const [key, expected] of Object.entries(fixture.expected))
      assert.equal(result[key], expected, key);
    assertSchedule(result);
  });
}

test('independent positive-rate fixtures match first and final row amounts', () => {
  const small = calculateLoan({ principalMinor: 120000, annualRateUnits: 120000, termMonths: 12 });
  assert.deepEqual(small.schedule[0], {
    month: 1,
    openingBalanceMinor: 120000,
    paymentMinor: 10662,
    interestMinor: 1200,
    principalPaidMinor: 9462,
    closingBalanceMinor: 110538,
  });
  assert.deepEqual(small.schedule.at(-1), {
    month: 12,
    openingBalanceMinor: 10554,
    paymentMinor: 10660,
    interestMinor: 106,
    principalPaidMinor: 10554,
    closingBalanceMinor: 0,
  });
  const larger = calculateLoan({ principalMinor: 1000000, annualRateUnits: 50000, termMonths: 36 });
  assert.deepEqual(larger.schedule[0], {
    month: 1,
    openingBalanceMinor: 1000000,
    paymentMinor: 29971,
    interestMinor: 4167,
    principalPaidMinor: 25804,
    closingBalanceMinor: 974196,
  });
  assert.deepEqual(larger.schedule.at(-1), {
    month: 36,
    openingBalanceMinor: 29845,
    paymentMinor: 29969,
    interestMinor: 124,
    principalPaidMinor: 29845,
    closingBalanceMinor: 0,
  });
});

test('exact half-unit payment and interest ties round upward, including whole-yen amounts', () => {
  const halfPayment = calculateLoan({ principalMinor: 1, annualRateUnits: 0, termMonths: 2 });
  assert.equal(halfPayment.regularPaymentMinor, 1);
  assert.equal(halfPayment.actualTermMonths, 1);
  assert.equal(halfPayment.paidOffEarly, true);
  const halfInterest = calculateLoan({
    principalMinor: 6,
    annualRateUnits: 1000000,
    termMonths: 1,
  });
  assert.equal(halfInterest.schedule[0].interestMinor, 1);
  assert.equal(halfInterest.regularPaymentMinor, 7);
  assert.equal(halfInterest.finalPaymentMinor, 7);
  assert.equal(model.formatMoney(halfInterest.totalPaidMinor, 'JPY'), '¥7');
  assertSchedule(halfPayment);
  assertSchedule(halfInterest);
});

test('zero-rounded and nonreducing payments are explicit failures rather than stuck schedules', () => {
  assert.throws(
    () => calculateLoan({ principalMinor: 1, annualRateUnits: 0, termMonths: 3 }),
    /rounds to zero/,
  );
  assert.throws(
    () => calculateLoan({ principalMinor: 999999999, annualRateUnits: 1000000, termMonths: 600 }),
    /does not reduce principal/,
  );
});

test('one-month payment can exceed the principal input cap while remaining a safe output', () => {
  const result = calculateLoan({
    principalMinor: MAX_PRINCIPAL_MINOR,
    annualRateUnits: MAX_ANNUAL_RATE_UNITS,
    termMonths: 1,
  });
  assert.equal(MAX_PRINCIPAL_MINOR, model.MAX_AMOUNT_MINOR);
  assert.equal(result.totalInterestMinor, 83333333);
  assert.equal(result.totalPaidMinor, 1083333332);
  assert.ok(result.regularPaymentMinor > MAX_PRINCIPAL_MINOR);
  assertSchedule(result);
});

test('invalid principal, rate and term inputs are rejected before exponentiation or iteration', () => {
  const valid = { principalMinor: 120000, annualRateUnits: 120000, termMonths: 12 };
  for (const principalMinor of [
    0,
    -1,
    0.1,
    NaN,
    Infinity,
    '120000',
    null,
    undefined,
    MAX_PRINCIPAL_MINOR + 1,
    Number.MAX_SAFE_INTEGER,
  ]) {
    assert.throws(() => calculateLoan({ ...valid, principalMinor }), /Principal must/);
  }
  for (const annualRateUnits of [
    -1,
    0.1,
    NaN,
    Infinity,
    '120000',
    null,
    undefined,
    MAX_ANNUAL_RATE_UNITS + 1,
  ]) {
    assert.throws(() => calculateLoan({ ...valid, annualRateUnits }), /Annual rate/);
  }
  for (const termMonths of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    '12',
    null,
    undefined,
    MAX_TERM_MONTHS + 1,
  ]) {
    assert.throws(() => calculateLoan({ ...valid, termMonths }), /Loan term/);
  }
  assert.throws(() => calculateLoan(null), /Enter the principal/);
  assert.throws(() => calculateLoan({}));
});

test('a grid of rate and term combinations reconciles every row or explicitly rejects precision limits', () => {
  let successes = 0;
  let precisionRejections = 0;
  for (const principalMinor of [100, 9999, 120000, 1000000]) {
    for (const annualRateUnits of [0, 1, 10000, 50000, 120000, 1000000]) {
      for (const termMonths of [1, 2, 12, 36, 600]) {
        let result;
        try {
          result = calculateLoan({ principalMinor, annualRateUnits, termMonths });
        } catch (error) {
          assert.match(error.message, /rounds to zero|does not reduce principal/);
          precisionRejections += 1;
          continue;
        }
        assertSchedule(result);
        successes += 1;
      }
    }
  }
  assert.ok(successes > 100);
  assert.ok(precisionRejections > 0);
});

test('public results are JSON-safe numbers and repeat calculation never mutates inputs or the ledger', () => {
  const inputs = Object.freeze({ principalMinor: 120000, annualRateUnits: 120000, termMonths: 12 });
  const ledger = model.createDemoLedger(new Date(2026, 9, 17));
  const ledgerBefore = JSON.stringify(ledger);
  const result = calculateLoan(inputs);
  const copy = JSON.parse(JSON.stringify(result));
  assert.deepEqual(copy, result);
  const walk = (value) => {
    assert.notEqual(typeof value, 'bigint');
    if (typeof value === 'number') assert.equal(Number.isSafeInteger(value), true);
    if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(result);
  result.inputs.principalMinor = 1;
  result.schedule[0].paymentMinor = 2;
  const again = calculateLoan(inputs);
  assert.deepEqual(again, copy);
  assert.equal(inputs.principalMinor, 120000);
  assert.equal(JSON.stringify(ledger), ledgerBefore);
});
