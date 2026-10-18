const {
  MAX_AMOUNT_MINOR,
  MAX_TRANSACTIONS,
  currencyInfo,
  validDate,
  formatMoney,
  goalProgressForBalance,
} = require('./model');

const FORMULA_VERSION = 'fyp-cash-flow-v1';
const MAX_SCENARIO_MINOR = MAX_AMOUNT_MINOR * MAX_TRANSACTIONS;

function safeAdd(left, right) {
  const result = left + right;
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    !Number.isSafeInteger(result)
  ) {
    throw new Error('Scenario arithmetic exceeds the supported exact-integer range.');
  }
  return result;
}

function aggregateValue(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SCENARIO_MINOR) {
    throw new Error(`${label} must be a nonnegative integer amount within the aggregate limit.`);
  }
  return value === 0 ? 0 : value;
}

function signedAggregateValue(value, label) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_SCENARIO_MINOR) {
    throw new Error(`${label} must be an exact integer amount within the aggregate limit.`);
  }
  return value === 0 ? 0 : value;
}

function readInputs(inputs) {
  if (!inputs || typeof inputs !== 'object')
    throw new Error('Enter income, expenses, and debt payments.');
  return {
    incomeMinor: aggregateValue(inputs.incomeMinor, 'Income'),
    expenseMinor: aggregateValue(inputs.expenseMinor, 'Expenses'),
    debtMinor: aggregateValue(inputs.debtMinor, 'Debt payments'),
  };
}

function cashFlowHealth(inputs) {
  const amounts = readInputs(inputs);
  const outflowMinor = safeAdd(amounts.expenseMinor, amounts.debtMinor);
  const netMinor = safeAdd(amounts.incomeMinor, -outflowMinor);
  const common = { ...amounts, formulaVersion: FORMULA_VERSION, outflowMinor, netMinor };
  if (amounts.incomeMinor === 0) {
    return {
      ...common,
      status: 'insufficient-income',
      score: null,
      rawScore: null,
      cashFlowRatio: null,
      debtToIncomeRatio: null,
      cashFlowPenaltyPoints: null,
      debtPenaltyPoints: null,
    };
  }

  const cashFlowRatio = netMinor / amounts.incomeMinor;
  const debtToIncomeRatio = amounts.debtMinor / amounts.incomeMinor;
  const cashFlowPenaltyPoints = Math.max(0, 0.25 - cashFlowRatio) * 100;
  const debtPenaltyPoints = Math.max(0, debtToIncomeRatio - 0.3) * 100;
  const rawScore = 100 - cashFlowPenaltyPoints - debtPenaltyPoints;
  if (
    ![cashFlowRatio, debtToIncomeRatio, cashFlowPenaltyPoints, debtPenaltyPoints, rawScore].every(
      Number.isFinite,
    )
  ) {
    throw new Error('The scenario could not produce finite ratios.');
  }
  return {
    ...common,
    status: 'available',
    score: Math.max(0, Math.min(100, rawScore)),
    rawScore,
    cashFlowRatio,
    debtToIncomeRatio,
    cashFlowPenaltyPoints,
    debtPenaltyPoints,
  };
}

function parseAggregateMoney(value, currency = 'MYR') {
  const { decimals } = currencyInfo(currency);
  const text = typeof value === 'string' ? value.trim() : '';
  const validText = decimals === 0 ? /^\d+$/ : /^\d+(?:\.\d{1,2})?$/;
  if (text.length > 64 || !validText.test(text)) {
    throw new Error(
      decimals === 0
        ? 'Enter zero or a positive whole-yen amount. JPY does not use decimal places.'
        : 'Enter zero or a positive amount with no more than two decimal places.',
    );
  }
  const [wholeText, fraction = ''] = text.split('.');
  const whole = wholeText.replace(/^0+(?=\d)/, '');
  const maximumWholeDigits = String(Math.floor(MAX_SCENARIO_MINOR / 10 ** decimals)).length;
  if (whole.length > maximumWholeDigits) {
    throw new Error(`Amount cannot exceed ${formatMoney(MAX_SCENARIO_MINOR, currency)}.`);
  }
  const minor =
    Number(whole) * 10 ** decimals + (decimals === 0 ? 0 : Number(fraction.padEnd(2, '0')));
  if (!Number.isSafeInteger(minor) || minor > MAX_SCENARIO_MINOR) {
    throw new Error(`Amount cannot exceed ${formatMoney(MAX_SCENARIO_MINOR, currency)}.`);
  }
  return minor;
}

function createSimulationBaseline(report) {
  if (
    !report ||
    typeof report !== 'object' ||
    !validDate(report.startDate) ||
    !validDate(report.endDate) ||
    report.startDate > report.endDate
  ) {
    throw new Error('The simulation requires a report with a valid selected date range.');
  }
  if (typeof report.currency !== 'string')
    throw new Error('The report baseline must specify its wallet currency.');
  const currency = currencyInfo(report.currency).code;
  const inputs = readInputs(report);
  const openingMinor = signedAggregateValue(report.openingMinor, 'Opening balance');
  const outflowMinor = aggregateValue(report.outflowMinor, 'Recorded outflow');
  const netMinor = signedAggregateValue(report.netMinor, 'Recorded net');
  const closingMinor = signedAggregateValue(report.closingMinor, 'Closing balance');
  const currentBalanceMinor = signedAggregateValue(
    report.currentBalanceMinor,
    'All-record balance',
  );
  const calculatedOutflow = safeAdd(inputs.expenseMinor, inputs.debtMinor);
  const calculatedNet = safeAdd(inputs.incomeMinor, -calculatedOutflow);
  if (safeAdd(inputs.incomeMinor, calculatedOutflow) > MAX_SCENARIO_MINOR) {
    throw new Error('The recorded period activity exceeds the supported ledger aggregate limit.');
  }
  if (
    outflowMinor !== calculatedOutflow ||
    netMinor !== calculatedNet ||
    closingMinor !== safeAdd(openingMinor, calculatedNet)
  ) {
    throw new Error(
      'The report baseline does not reconcile. Refresh the selected report before simulating.',
    );
  }
  return Object.freeze({
    startDate: report.startDate,
    endDate: report.endDate,
    currency,
    openingMinor,
    ...inputs,
    outflowMinor,
    netMinor,
    closingMinor,
    currentBalanceMinor,
  });
}

function simulateReport(baseline, inputs, goalTargetMinor = null) {
  const snapshot = createSimulationBaseline(baseline);
  const health = cashFlowHealth(inputs);
  const baselineHealth = cashFlowHealth(snapshot);
  const deltaNetMinor = safeAdd(health.netMinor, -snapshot.netMinor);
  const projectedClosingMinor = safeAdd(snapshot.openingMinor, health.netMinor);
  const projectedCurrentBalanceMinor = safeAdd(snapshot.currentBalanceMinor, deltaNetMinor);
  return {
    inputs: {
      incomeMinor: health.incomeMinor,
      expenseMinor: health.expenseMinor,
      debtMinor: health.debtMinor,
    },
    baselineHealth,
    health,
    deltaNetMinor,
    projectedClosingMinor,
    projectedCurrentBalanceMinor,
    goal: goalProgressForBalance(projectedCurrentBalanceMinor, goalTargetMinor),
  };
}

module.exports = {
  FORMULA_VERSION,
  MAX_SCENARIO_MINOR,
  cashFlowHealth,
  parseAggregateMoney,
  createSimulationBaseline,
  simulateReport,
};
