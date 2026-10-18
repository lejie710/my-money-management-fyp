const { MAX_AMOUNT_MINOR } = require('./model');

const CALCULATION_VERSION = 'fixed-rate-monthly-v1';
const MAX_PRINCIPAL_MINOR = MAX_AMOUNT_MINOR;
const RATE_SCALE = 10000;
const MAX_ANNUAL_RATE_UNITS = 1000000;
const MAX_TERM_MONTHS = 600;

function validateRate(units) {
  if (!Number.isSafeInteger(units) || units < 0 || units > MAX_ANNUAL_RATE_UNITS) {
    throw new Error('Annual rate must be between 0% and 100%, with at most four decimal places.');
  }
  return units;
}

function validateMonths(months) {
  if (!Number.isSafeInteger(months) || months < 1 || months > MAX_TERM_MONTHS) {
    throw new Error('Loan term must be a whole number of months between 1 and 600.');
  }
  return months;
}

function parseAnnualRate(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > 32 || !/^\d+(?:\.\d{1,4})?$/.test(text)) {
    throw new Error('Enter an annual percentage from 0 to 100 with at most four decimal places.');
  }
  const [wholeText, fraction = ''] = text.split('.');
  const whole = wholeText.replace(/^0+(?=\d)/, '');
  if (whole.length > 3) return validateRate(MAX_ANNUAL_RATE_UNITS + 1);
  return validateRate(Number(whole) * RATE_SCALE + Number(fraction.padEnd(4, '0')));
}

function formatAnnualRate(annualRateUnits) {
  validateRate(annualRateUnits);
  const whole = Math.floor(annualRateUnits / RATE_SCALE);
  const fraction = String(annualRateUnits % RATE_SCALE)
    .padStart(4, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function parseTermMonths(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > 32 || !/^\d+$/.test(text)) {
    throw new Error('Enter a whole number of months between 1 and 600.');
  }
  const normalized = text.replace(/^0+(?=\d)/, '');
  if (normalized.length > 3) return validateMonths(MAX_TERM_MONTHS + 1);
  return validateMonths(Number(normalized));
}

function roundHalfUp(numerator, denominator) {
  if (numerator < 0n || denominator <= 0n) throw new Error('Invalid nonnegative rational amount.');
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return quotient + (remainder * 2n >= denominator ? 1n : 0n);
}

function publicMoney(value) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Loan amounts exceed the supported exact-integer range.');
  }
  return Number(value);
}

function calculateLoan(inputs) {
  if (!inputs || typeof inputs !== 'object')
    throw new Error('Enter the principal, annual rate, and term.');
  if (
    !Number.isSafeInteger(inputs.principalMinor) ||
    inputs.principalMinor <= 0 ||
    inputs.principalMinor > MAX_PRINCIPAL_MINOR
  ) {
    throw new Error(
      'Principal must be a positive integer amount within the supported principal limit.',
    );
  }
  const annualRateUnits = validateRate(inputs.annualRateUnits);
  const termMonths = validateMonths(inputs.termMonths);
  if (typeof BigInt !== 'function')
    throw new Error('This runtime cannot perform the required exact loan calculation.');

  const principal = BigInt(inputs.principalMinor);
  const rate = BigInt(annualRateUnits);
  const denominator = 12000000n;
  const months = BigInt(termMonths);
  let regularPayment;
  if (rate === 0n) {
    regularPayment = roundHalfUp(principal, months);
  } else {
    const futureFactor = (denominator + rate) ** months;
    const principalFactor = denominator ** months;
    regularPayment = roundHalfUp(
      principal * rate * futureFactor,
      denominator * (futureFactor - principalFactor),
    );
  }
  if (regularPayment === 0n) {
    throw new Error(
      'The monthly payment rounds to zero at this currency precision. Change the principal or term.',
    );
  }
  const firstInterest = roundHalfUp(principal * rate, denominator);
  if (regularPayment <= firstInterest) {
    throw new Error(
      'The rounded monthly payment does not reduce principal at this currency precision. Change the inputs.',
    );
  }

  const schedule = [];
  let balance = principal;
  let totalPaid = 0n;
  let totalInterest = 0n;
  let totalPrincipal = 0n;
  for (let month = 1; month <= termMonths; month += 1) {
    const openingBalance = balance;
    const interest = roundHalfUp(openingBalance * rate, denominator);
    const amountDue = openingBalance + interest;
    const payment =
      month === termMonths || regularPayment >= amountDue ? amountDue : regularPayment;
    const principalPaid = payment - interest;
    if (principalPaid <= 0n || principalPaid > openingBalance) {
      throw new Error('The rounded schedule cannot reduce principal safely.');
    }
    balance = openingBalance - principalPaid;
    totalPaid += payment;
    totalInterest += interest;
    totalPrincipal += principalPaid;
    schedule.push({
      month,
      openingBalanceMinor: publicMoney(openingBalance),
      paymentMinor: publicMoney(payment),
      interestMinor: publicMoney(interest),
      principalPaidMinor: publicMoney(principalPaid),
      closingBalanceMinor: publicMoney(balance),
    });
    if (balance === 0n) break;
  }
  if (balance !== 0n || totalPrincipal !== principal || totalPaid !== principal + totalInterest) {
    throw new Error('The loan schedule did not reconcile.');
  }
  return {
    calculationVersion: CALCULATION_VERSION,
    inputs: { principalMinor: inputs.principalMinor, annualRateUnits, termMonths },
    regularPaymentMinor: publicMoney(regularPayment),
    finalPaymentMinor: schedule[schedule.length - 1].paymentMinor,
    totalPaidMinor: publicMoney(totalPaid),
    totalInterestMinor: publicMoney(totalInterest),
    requestedTermMonths: termMonths,
    actualTermMonths: schedule.length,
    paidOffEarly: schedule.length < termMonths,
    schedule,
  };
}

module.exports = {
  CALCULATION_VERSION,
  MAX_PRINCIPAL_MINOR,
  RATE_SCALE,
  MAX_ANNUAL_RATE_UNITS,
  MAX_TERM_MONTHS,
  parseAnnualRate,
  formatAnnualRate,
  parseTermMonths,
  calculateLoan,
};
