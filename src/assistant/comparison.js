const { validDate } = require('../core/model');
const { periodReport } = require('../core/reports');
const DAY = 86400000;
const iso = (value) => new Date(value).toISOString().slice(0, 10);

/** A whole month compares with the preceding calendar month; other ranges use equal days. */
function previousPeriod(startDate, endDate) {
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate)
    throw new Error('Choose a valid comparison period.');
  const start = Date.parse(startDate + 'T00:00:00Z');
  const end = Date.parse(endDate + 'T00:00:00Z');
  const next = new Date(end + DAY);
  const wholeMonth =
    startDate.endsWith('-01') &&
    next.getUTCDate() === 1 &&
    startDate.slice(0, 7) === endDate.slice(0, 7);
  const previousEnd = start - DAY;
  const previousStart = wholeMonth
    ? Date.UTC(new Date(previousEnd).getUTCFullYear(), new Date(previousEnd).getUTCMonth(), 1)
    : start - (end - start + DAY);
  const range = { startDate: iso(previousStart), endDate: iso(previousEnd) };
  return validDate(range.startDate) && validDate(range.endDate)
    ? { ...range, basis: wholeMonth ? 'previous calendar month' : 'preceding equal-length period' }
    : null;
}
function comparisonFacts(ledger, report, amount, includeCategories = false) {
  const range = previousPeriod(report.startDate, report.endDate);
  if (!range)
    return [
      {
        id: 'comparisonScope',
        label: 'Comparison availability',
        value: 'The previous period is outside the supported calendar. No comparison is supplied.',
      },
    ];
  const previous = periodReport(ledger, range.startDate, range.endDate);
  const facts = [
    {
      id: 'comparisonScope',
      label: 'Comparison period',
      value:
        range.startDate +
        ' through ' +
        range.endDate +
        ', inclusive (' +
        range.basis +
        '). Recorded transactions only; missing entries and incomplete periods can affect the comparison.',
    },
  ];
  for (const [id, label, key] of [
    ['comparisonIncome', 'Recorded income comparison', 'incomeMinor'],
    ['comparisonExpense', 'Recorded expense comparison', 'expenseMinor'],
    ['comparisonDebt', 'Recorded debt-payment comparison', 'debtMinor'],
    ['comparisonNet', 'Recorded net cash-flow comparison', 'netMinor'],
  ]) {
    const delta = report[key] - previous[key];
    if (!Number.isSafeInteger(delta))
      throw new Error('Comparison exceeds supported exact amounts.');
    facts.push({
      id,
      label,
      value:
        'Previous ' +
        amount(previous[key]) +
        '; selected ' +
        amount(report[key]) +
        '; change ' +
        amount(delta) +
        '.',
    });
  }
  if (!includeCategories) return facts;
  const earlier = new Map(
    previous.categoryBreakdown
      .filter((row) => row.type === 'expense')
      .map((row) => [row.categoryId, row.amountMinor]),
  );
  report.categoryBreakdown
    .filter((row) => row.type === 'expense')
    .slice(0, 3)
    .forEach((row, index) => {
      const previousMinor = earlier.get(row.categoryId) || 0;
      const delta = row.amountMinor - previousMinor;
      if (!Number.isSafeInteger(delta))
        throw new Error('Comparison exceeds supported exact amounts.');
      facts.push({
        id: 'categoryTrend' + (index + 1),
        label: row.categoryName + ' comparison',
        value:
          'Previous recorded ' +
          amount(previousMinor) +
          '; selected ' +
          amount(row.amountMinor) +
          '; change ' +
          amount(delta) +
          '. Zero recorded does not establish zero real-world spending.',
      });
    });
  return facts;
}
module.exports = { previousPeriod, comparisonFacts };
