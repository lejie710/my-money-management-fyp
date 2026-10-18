const { validateLedger, validDate } = require('./model');

const TYPE_ORDER = Object.freeze({ income: 0, expense: 1, debt: 2 });

function safeAdd(left, right) {
  const result = left + right;
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    !Number.isSafeInteger(result)
  ) {
    throw new Error('Report amounts exceed the supported exact-integer range.');
  }
  return result;
}

function validateRange(startDate, endDate) {
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) {
    throw new Error('Choose real start and end dates in chronological order, within 1900 to 2100.');
  }
}

function prepareLedger(ledger) {
  validateLedger(ledger);
  let currentBalanceMinor = 0;
  for (const transaction of ledger.transactions) {
    currentBalanceMinor = safeAdd(
      currentBalanceMinor,
      transaction.type === 'income' ? transaction.amountMinor : -transaction.amountMinor,
    );
  }
  return {
    currency: ledger.wallet.currency,
    transactions: ledger.transactions,
    categories: new Map(ledger.categories.map((category) => [category.id, category])),
    currentBalanceMinor,
  };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Shared by single-period reports and every monthly chart entry.
function buildReport(prepared, startDate, endDate) {
  let openingMinor = 0;
  let closingFromHistory = 0;
  let transactionCount = 0;
  const activity = { income: 0, expense: 0, debt: 0 };
  const groups = new Map();

  for (const transaction of prepared.transactions) {
    const signedAmount =
      transaction.type === 'income' ? transaction.amountMinor : -transaction.amountMinor;
    if (transaction.date < startDate) openingMinor = safeAdd(openingMinor, signedAmount);
    if (transaction.date <= endDate) closingFromHistory = safeAdd(closingFromHistory, signedAmount);
    if (transaction.date < startDate || transaction.date > endDate) continue;

    transactionCount += 1;
    activity[transaction.type] = safeAdd(activity[transaction.type], transaction.amountMinor);
    const key = JSON.stringify([transaction.type, transaction.categoryId]);
    let group = groups.get(key);
    if (!group) {
      group = {
        categoryId: transaction.categoryId,
        categoryName: prepared.categories.get(transaction.categoryId).name,
        type: transaction.type,
        amountMinor: 0,
        transactionCount: 0,
      };
      groups.set(key, group);
    }
    group.amountMinor = safeAdd(group.amountMinor, transaction.amountMinor);
    group.transactionCount += 1;
  }

  const incomeMinor = activity.income;
  const expenseMinor = activity.expense;
  const debtMinor = activity.debt;
  const outflowMinor = safeAdd(expenseMinor, debtMinor);
  const netMinor = safeAdd(incomeMinor, -outflowMinor);
  const closingMinor = safeAdd(openingMinor, netMinor);
  if (closingMinor !== closingFromHistory)
    throw new Error('Report closing balance did not reconcile with the recorded transactions.');

  const categoryBreakdown = Array.from(groups.values(), (group) => ({
    ...group,
    typeTotalMinor: activity[group.type],
    shareOfType: group.amountMinor / activity[group.type],
  })).sort(
    (left, right) =>
      TYPE_ORDER[left.type] - TYPE_ORDER[right.type] ||
      right.amountMinor - left.amountMinor ||
      compareText(left.categoryName, right.categoryName) ||
      compareText(left.categoryId, right.categoryId),
  );

  return {
    startDate,
    endDate,
    currency: prepared.currency,
    openingMinor,
    incomeMinor,
    expenseMinor,
    debtMinor,
    outflowMinor,
    netMinor,
    closingMinor,
    currentBalanceMinor: prepared.currentBalanceMinor,
    transactionCount,
    hasActivity: transactionCount > 0,
    categoryBreakdown,
    ratios: {
      retainedNetToIncome: incomeMinor > 0 ? netMinor / incomeMinor : null,
      expenseToIncome: incomeMinor > 0 ? expenseMinor / incomeMinor : null,
      debtToIncome: incomeMinor > 0 ? debtMinor / incomeMinor : null,
      outflowToIncome: incomeMinor > 0 ? outflowMinor / incomeMinor : null,
    },
  };
}

function periodReport(ledger, startDate, endDate) {
  validateRange(startDate, endDate);
  return buildReport(prepareLedger(ledger), startDate, endDate);
}

function monthlySeries(ledger, startDate, endDate) {
  validateRange(startDate, endDate);
  const prepared = prepareLedger(ledger);
  const [startYear, startMonth] = startDate.split('-').map(Number);
  const [endYear, endMonth] = endDate.split('-').map(Number);
  const firstIndex = startYear * 12 + startMonth - 1;
  const lastIndex = endYear * 12 + endMonth - 1;
  const series = [];

  // Strict supported dates bound this loop to at most 201 * 12 months.
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const year = Math.floor(index / 12);
    const monthIndex = index % 12;
    const month = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
    const calendarStart = `${month}-01`;
    const calendarEnd = new Date(Date.UTC(year, monthIndex + 1, 0)).toISOString().slice(0, 10);
    const clippedStart = startDate > calendarStart ? startDate : calendarStart;
    const clippedEnd = endDate < calendarEnd ? endDate : calendarEnd;
    series.push({
      ...buildReport(prepared, clippedStart, clippedEnd),
      month,
      isPartialPeriod: clippedStart !== calendarStart || clippedEnd !== calendarEnd,
    });
  }
  return series;
}

module.exports = { periodReport, monthlySeries };
