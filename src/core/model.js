// v5 adds optional transaction context while retaining exact financial arithmetic.
// Calendar dates never pass through a timezone conversion.
const {
  createWalletIdentity,
  emptyAchievementState,
  validateAchievementState,
} = require('./achievementSchema');
const {
  validateTransactionContext,
  applyContextPatch,
  promoteLegacyContext,
  photoKey,
  samePhotoRef,
} = require('./transactionContext');
const STORAGE_VERSION = 5;
const MAX_AMOUNT_MINOR = 999999999;
const MAX_TRANSACTIONS = 10000;
const TRANSACTION_TYPES = Object.freeze(['income', 'expense', 'debt']);
const BUDGET_PERIODS = Object.freeze(['week', 'month', 'year']);
const GOAL_KINDS = Object.freeze(
  [
    { value: 'retirement', label: 'Saving for retirement' },
    { value: 'home', label: 'Saving for a home' },
    { value: 'emergencyFund', label: 'Building an emergency fund' },
    { value: 'creditDebt', label: 'Funds toward credit card debt' },
    { value: 'education', label: 'Saving for education' },
    { value: 'stockMarket', label: 'Funds for stock market investing' },
    { value: 'vacation', label: 'Saving for a vacation' },
    { value: 'investmentFund', label: 'Creating an investment fund' },
    { value: 'other', label: 'Other savings goal' },
  ].map(Object.freeze),
);
const CURRENCIES = Object.freeze(
  [
    { code: 'MYR', label: 'Malaysian Ringgit', symbol: 'RM', decimals: 2 },
    { code: 'USD', label: 'US Dollar', symbol: 'US$', decimals: 2 },
    { code: 'EUR', label: 'Euro', symbol: '€', decimals: 2 },
    { code: 'GBP', label: 'British Pound', symbol: '£', decimals: 2 },
    { code: 'JPY', label: 'Japanese Yen', symbol: '¥', decimals: 0 },
    { code: 'AUD', label: 'Australian Dollar', symbol: 'A$', decimals: 2 },
    { code: 'CAD', label: 'Canadian Dollar', symbol: 'C$', decimals: 2 },
    { code: 'CNY', label: 'Chinese Yuan', symbol: 'CN¥', decimals: 2 },
  ].map(Object.freeze),
);

const DEFAULT_CATEGORIES = Object.freeze(
  [
    ['income-salary', 'Salary', 'income'],
    ['income-other', 'Other income', 'income'],
    ['income-transfer', 'Incoming transfer', 'income'],
    ['income-interest', 'Collect interest', 'income'],
    ['income-uncategorized', 'Uncategorized income', 'income'],
    ['expense-food', 'Food & beverages', 'expense'],
    ['expense-bills', 'Bills & utilities', 'expense'],
    ['expense-shopping', 'Shopping', 'expense'],
    ['expense-family', 'Family', 'expense'],
    ['expense-transport', 'Transport', 'expense'],
    ['expense-health', 'Health & fitness', 'expense'],
    ['expense-education', 'Education', 'expense'],
    ['expense-entertainment', 'Entertainment', 'expense'],
    ['expense-insurance', 'Insurance', 'expense'],
    ['expense-gifts', 'Gifts & donations', 'expense'],
    ['expense-other', 'Other expenses', 'expense'],
    ['debt-loan', 'Debt / loan', 'debt'],
  ].map(([id, name, type]) => Object.freeze({ id, name, type, isDefault: true })),
);

function currencyInfo(currency = 'MYR') {
  const info = CURRENCIES.find((item) => item.code === currency);
  if (!info) throw new Error('Choose one of the supported wallet currencies.');
  return info;
}

function localDate(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()))
    throw new Error('A valid date is required.');
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function parseMoney(value, currency = 'MYR') {
  const { decimals } = currencyInfo(currency);
  const text = typeof value === 'string' ? value.trim() : '';
  const expression = decimals === 0 ? /^\d{1,9}$/ : /^\d{1,7}(?:\.\d{1,2})?$/;
  if (!expression.test(text)) {
    throw new Error(
      decimals === 0
        ? 'Enter a positive whole-yen amount. JPY does not use decimal places.'
        : 'Enter a positive amount with no more than two decimal places.',
    );
  }
  const [whole, fraction = ''] = text.split('.');
  const minor =
    Number(whole) * 10 ** decimals + (decimals === 0 ? 0 : Number(fraction.padEnd(2, '0')));
  if (!Number.isSafeInteger(minor) || minor <= 0 || minor > MAX_AMOUNT_MINOR) {
    throw new Error(
      `Amount must be between ${formatMoney(1, currency)} and ${formatMoney(MAX_AMOUNT_MINOR, currency)}.`,
    );
  }
  return minor;
}

function amountInputValue(amountMinor, currency = 'MYR') {
  const { decimals } = currencyInfo(currency);
  if (!Number.isSafeInteger(amountMinor))
    throw new Error('Money must be a whole number of minor units.');
  return (amountMinor / 10 ** decimals).toFixed(decimals);
}

function formatMoney(amountMinor, currency = 'MYR') {
  const { symbol, decimals } = currencyInfo(currency);
  if (!Number.isSafeInteger(amountMinor))
    throw new Error('Money must be a whole number of minor units.');
  const [whole, fraction] = amountInputValue(Math.abs(amountMinor), currency).split('.');
  return `${amountMinor < 0 ? '-' : ''}${symbol}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${decimals ? `.${fraction}` : ''}`;
}

function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(id);
}

function validText(text, maximum) {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= maximum;
}

function normalizedName(name) {
  return name.trim().normalize('NFC').toLowerCase();
}

function validCategory(category) {
  return (
    category &&
    typeof category === 'object' &&
    validId(category.id) &&
    validText(category.name, 40) &&
    TRANSACTION_TYPES.includes(category.type) &&
    typeof category.isDefault === 'boolean'
  );
}

function validTransaction(transaction, ledger, categoriesById) {
  if (
    !transaction ||
    typeof transaction !== 'object' ||
    !validId(transaction.id) ||
    transaction.walletId !== ledger.wallet.id ||
    !TRANSACTION_TYPES.includes(transaction.type) ||
    !validText(transaction.title, 80) ||
    !validDate(transaction.date) ||
    !Number.isSafeInteger(transaction.amountMinor) ||
    transaction.amountMinor <= 0 ||
    transaction.amountMinor > MAX_AMOUNT_MINOR
  )
    return false;
  const category = categoriesById
    ? categoriesById.get(transaction.categoryId)
    : ledger.categories.find((item) => item.id === transaction.categoryId);
  return Boolean(category && category.type === transaction.type);
}

function validateCoreLedger(ledger, expectedVersion) {
  const invalid = () => {
    throw new Error('Saved wallet data has an unsupported or invalid format.');
  };
  if (
    !ledger ||
    typeof ledger !== 'object' ||
    ledger.version !== expectedVersion ||
    !['sample', 'local'].includes(ledger.mode) ||
    !ledger.wallet ||
    !validId(ledger.wallet.id) ||
    !validText(ledger.wallet.name, 80) ||
    !CURRENCIES.some((item) => item.code === ledger.wallet.currency) ||
    typeof ledger.wallet.hasTransactionHistory !== 'boolean' ||
    !Array.isArray(ledger.categories) ||
    ledger.categories.length > MAX_TRANSACTIONS + DEFAULT_CATEGORIES.length ||
    !ledger.categories.every(validCategory) ||
    !Array.isArray(ledger.transactions) ||
    ledger.transactions.length > MAX_TRANSACTIONS
  )
    invalid();
  // Categories are structurally validated above; one index serves every reference
  // in this validation boundary, including planning records in the caller.
  const categoriesById = new Map(ledger.categories.map((item) => [item.id, item]));
  if (
    categoriesById.size !== ledger.categories.length ||
    !ledger.transactions.every((item) => validTransaction(item, ledger, categoriesById)) ||
    new Set(ledger.transactions.map((item) => item.id)).size !== ledger.transactions.length ||
    (ledger.transactions.length > 0 && !ledger.wallet.hasTransactionHistory)
  )
    invalid();
  return categoriesById;
}

function periodBounds(period, anchorDate = localDate()) {
  if (!BUDGET_PERIODS.includes(period)) throw new Error('Choose a week, month, or year budget.');
  if (!validDate(anchorDate)) throw new Error('Choose a valid date for this budget period.');
  const [year, month, day] = anchorDate.split('-').map(Number);
  let start;
  let end;
  if (period === 'week') {
    start = new Date(Date.UTC(year, month - 1, day));
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    end = new Date(start.getTime());
    end.setUTCDate(end.getUTCDate() + 6);
  } else if (period === 'month') {
    start = new Date(Date.UTC(year, month - 1, 1));
    end = new Date(Date.UTC(year, month, 0));
  } else {
    start = new Date(Date.UTC(year, 0, 1));
    end = new Date(Date.UTC(year, 11, 31));
  }
  const result = {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
  if (!validDate(result.startDate) || !validDate(result.endDate)) {
    throw new Error('Choose a complete budget period within 1900 to 2100.');
  }
  return result;
}

function validBudget(budget, ledger, categoriesById) {
  if (
    !budget ||
    typeof budget !== 'object' ||
    !validId(budget.id) ||
    budget.walletId !== ledger.wallet.id ||
    !Number.isSafeInteger(budget.plannedMinor) ||
    budget.plannedMinor <= 0 ||
    budget.plannedMinor > MAX_AMOUNT_MINOR ||
    !BUDGET_PERIODS.includes(budget.period) ||
    !validDate(budget.startDate) ||
    !validDate(budget.endDate)
  )
    return false;
  const category = categoriesById
    ? categoriesById.get(budget.categoryId)
    : ledger.categories.find((item) => item.id === budget.categoryId);
  if (!category || category.type !== 'expense') return false;
  try {
    const bounds = periodBounds(budget.period, budget.startDate);
    return budget.startDate === bounds.startDate && budget.endDate === bounds.endDate;
  } catch {
    return false;
  }
}

function budgetPeriodKey(budget) {
  return JSON.stringify([budget.categoryId, budget.period, budget.startDate, budget.endDate]);
}

function validGoal(goal, ledger) {
  return (
    goal &&
    typeof goal === 'object' &&
    validId(goal.id) &&
    goal.walletId === ledger.wallet.id &&
    GOAL_KINDS.some((item) => item.value === goal.kind) &&
    Number.isSafeInteger(goal.targetMinor) &&
    goal.targetMinor > 0 &&
    goal.targetMinor <= MAX_AMOUNT_MINOR
  );
}

function validatePlanningLedger(ledger, version) {
  const categoriesById = validateCoreLedger(ledger, version);
  if (
    !Array.isArray(ledger.budgets) ||
    ledger.budgets.length > 10000 ||
    !ledger.budgets.every((item) => validBudget(item, ledger, categoriesById)) ||
    new Set(ledger.budgets.map((item) => item.id)).size !== ledger.budgets.length ||
    new Set(ledger.budgets.map(budgetPeriodKey)).size !== ledger.budgets.length ||
    (ledger.goal !== null && !validGoal(ledger.goal, ledger))
  ) {
    throw new Error('Saved budgets or savings goal have an unsupported or invalid format.');
  }
  return ledger;
}

function validateLedger(ledger) {
  validatePlanningLedger(ledger, STORAGE_VERSION);
  validateAchievementState(ledger.achievements, ledger.wallet, ledger.mode);
  const photos = new Map();
  for (const transaction of ledger.transactions) {
    if (transaction.context !== undefined)
      validateTransactionContext(transaction.context, ledger.wallet.incarnationId);
    const photo = transaction.context?.photo;
    if (photo) {
      const key = photoKey(photo);
      if (photos.has(key) && !samePhotoRef(photos.get(key), photo))
        throw new Error('Saved photo metadata is ambiguous.');
      photos.set(key, photo);
    }
  }
  return ledger;
}

function createEmptyLedger(options = {}, context) {
  const identity = createWalletIdentity(context);
  return validateLedger({
    version: STORAGE_VERSION,
    mode: 'local',
    wallet: {
      id: 'personal',
      name: options.name === undefined ? 'My personal wallet' : String(options.name).trim(),
      currency: options.currency ?? 'MYR',
      hasTransactionHistory: false,
      ...identity,
    },
    achievements: emptyAchievementState(identity.incarnationId),
    categories: DEFAULT_CATEGORIES.map((item) => ({ ...item })),
    transactions: [],
    budgets: [],
    goal: null,
  });
}

function createDemoLedger(date = new Date(), context) {
  const ledger = createEmptyLedger({}, context);
  const today = localDate(date);
  return validateLedger({
    ...ledger,
    mode: 'sample',
    wallet: { ...ledger.wallet, hasTransactionHistory: true },
    transactions: [
      {
        id: 'sample-salary',
        walletId: ledger.wallet.id,
        title: 'Monthly salary',
        categoryId: 'income-salary',
        type: 'income',
        amountMinor: 320000,
        date: `${today.slice(0, 8)}01`,
      },
      {
        id: 'sample-groceries',
        walletId: ledger.wallet.id,
        title: 'Weekly groceries',
        categoryId: 'expense-food',
        type: 'expense',
        amountMinor: 8640,
        date: today,
      },
      {
        id: 'sample-transport',
        walletId: ledger.wallet.id,
        title: 'Train and bus',
        categoryId: 'expense-transport',
        type: 'expense',
        amountMinor: 2560,
        date: today,
      },
    ],
  });
}

function categoryForTransaction(ledger, transaction) {
  const category = ledger.categories.find((item) => item.id === transaction.categoryId);
  if (!category) throw new Error('The transaction category no longer exists.');
  return category;
}

function transactionFromDraft(draft, id, ledger) {
  validateLedger(ledger);
  if (!draft || !TRANSACTION_TYPES.includes(draft.type))
    throw new Error('Choose an income, expense, or debt payment.');
  const title = typeof draft.title === 'string' ? draft.title.trim() : '';
  if (!validText(title, 80)) throw new Error('Enter a title of 1 to 80 characters.');
  const category = ledger.categories.find((item) => item.id === draft.categoryId);
  if (!category || category.type !== draft.type)
    throw new Error('Choose a category matching the transaction type.');
  const date = typeof draft.date === 'string' ? draft.date.trim() : '';
  if (!validDate(date)) throw new Error('Enter a real date as YYYY-MM-DD, between 1900 and 2100.');
  const transaction = {
    ...ledger.transactions.find((item) => item.id === id),
    id,
    walletId: ledger.wallet.id,
    type: draft.type,
    title,
    categoryId: category.id,
    date,
    amountMinor: parseMoney(draft.amount, ledger.wallet.currency),
  };
  if (!validTransaction(transaction, ledger))
    throw new Error('This transaction contains an invalid value.');
  return transaction;
}

function saveTransaction(ledger, transaction, editing = false) {
  validateLedger(ledger);
  if (!validTransaction(transaction, ledger))
    throw new Error('This transaction contains an invalid value.');
  const exists = ledger.transactions.some((item) => item.id === transaction.id);
  if (editing && !exists) throw new Error('This transaction no longer exists.');
  if (!editing && exists) throw new Error('This transaction already exists. Please try again.');
  return validateLedger({
    ...ledger,
    wallet: { ...ledger.wallet, hasTransactionHistory: true },
    transactions: editing
      ? ledger.transactions.map((item) =>
          item.id === transaction.id
            ? {
                ...item,
                ...transaction,
                ...(transaction.context === undefined && item.context !== undefined
                  ? { context: item.context }
                  : {}),
              }
            : item,
        )
      : [...ledger.transactions, { ...transaction }],
  });
}

function deleteTransaction(ledger, id) {
  validateLedger(ledger);
  if (!ledger.transactions.some((item) => item.id === id))
    throw new Error('This transaction no longer exists.');
  return { ...ledger, transactions: ledger.transactions.filter((item) => item.id !== id) };
}

function assertCategoryName(ledger, name, type, ignoredId) {
  if (!validText(name, 40)) throw new Error('Enter a category name of 1 to 40 characters.');
  if (!TRANSACTION_TYPES.includes(type)) throw new Error('Choose a valid category type.');
  if (
    ledger.categories.some(
      (item) =>
        item.id !== ignoredId &&
        item.type === type &&
        normalizedName(item.name) === normalizedName(name),
    )
  ) {
    throw new Error('A category with this name already exists for this transaction type.');
  }
}

function createCategory(ledger, options) {
  validateLedger(ledger);
  const name = typeof options?.name === 'string' ? options.name.trim() : '';
  const type = options?.type;
  assertCategoryName(ledger, name, type);
  const id =
    options.id ?? `category-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  if (!validId(id) || ledger.categories.some((item) => item.id === id))
    throw new Error('This category identifier is invalid or already in use.');
  return validateLedger({
    ...ledger,
    categories: [...ledger.categories, { id, name, type, isDefault: false }],
  });
}

function renameCategory(ledger, id, newName) {
  validateLedger(ledger);
  const existing = ledger.categories.find((item) => item.id === id);
  if (!existing) throw new Error('This category no longer exists.');
  const name = typeof newName === 'string' ? newName.trim() : '';
  if (name === existing.name) return ledger;
  assertCategoryName(ledger, name, existing.type, id);
  return validateLedger({
    ...ledger,
    categories: ledger.categories.map((item) => (item.id === id ? { ...item, name } : item)),
  });
}

function deleteCategory(ledger, id) {
  validateLedger(ledger);
  if (!ledger.categories.some((item) => item.id === id))
    throw new Error('This category no longer exists.');
  if (ledger.transactions.some((item) => item.categoryId === id))
    throw new Error(
      'This category is used by a transaction. Change that transaction before deleting it.',
    );
  if (ledger.budgets.some((item) => item.categoryId === id))
    throw new Error(
      'This category is used by a budget. Change or remove that budget before deleting it.',
    );
  return { ...ledger, categories: ledger.categories.filter((item) => item.id !== id) };
}

function canChangeCurrency(ledger) {
  validateLedger(ledger);
  return (
    !ledger.wallet.hasTransactionHistory && ledger.budgets.length === 0 && ledger.goal === null
  );
}

function updateWallet(ledger, changes) {
  validateLedger(ledger);
  const name = changes.name === undefined ? ledger.wallet.name : String(changes.name).trim();
  if (!validText(name, 80)) throw new Error('Enter a wallet name of 1 to 80 characters.');
  const currency = changes.currency ?? ledger.wallet.currency;
  currencyInfo(currency);
  if (currency !== ledger.wallet.currency && !canChangeCurrency(ledger)) {
    throw new Error(
      'Currency cannot change while transaction history, budgets, or a savings goal use it. Start a fresh wallet to choose another currency.',
    );
  }
  return validateLedger({ ...ledger, wallet: { ...ledger.wallet, name, currency } });
}

function sumTransactions(transactions) {
  const result = { income: 0, expense: 0, debt: 0, balance: 0 };
  for (const transaction of transactions) result[transaction.type] += transaction.amountMinor;
  result.balance = result.income - result.expense - result.debt;
  return result;
}

function totals(ledger) {
  validateLedger(ledger);
  return sumTransactions(ledger.transactions);
}

function periodTotals(ledger, startDate, endDate) {
  validateLedger(ledger);
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate)
    throw new Error('Choose a valid start and end date in chronological order.');
  return sumTransactions(
    ledger.transactions.filter((item) => item.date >= startDate && item.date <= endDate),
  );
}

function budgetFromDraft(draft, id, ledger) {
  validateLedger(ledger);
  if (!draft) throw new Error('Enter the budget details.');
  const category = ledger.categories.find((item) => item.id === draft.categoryId);
  if (!category || category.type !== 'expense')
    throw new Error('Choose an expense category for this budget.');
  const bounds = periodBounds(
    draft.period,
    typeof draft.anchorDate === 'string' ? draft.anchorDate.trim() : '',
  );
  const budget = {
    id,
    walletId: ledger.wallet.id,
    categoryId: category.id,
    plannedMinor: parseMoney(draft.amount, ledger.wallet.currency),
    period: draft.period,
    ...bounds,
  };
  if (!validBudget(budget, ledger)) throw new Error('This budget contains an invalid value.');
  return budget;
}

function saveBudget(ledger, budget, editing = false) {
  validateLedger(ledger);
  if (!validBudget(budget, ledger)) throw new Error('This budget contains an invalid value.');
  const existing = ledger.budgets.find((item) => item.id === budget.id);
  if (editing && !existing) throw new Error('This budget no longer exists.');
  if (!editing && existing) throw new Error('This budget already exists. Please try again.');
  if (
    ledger.budgets.some(
      (item) => item.id !== budget.id && budgetPeriodKey(item) === budgetPeriodKey(budget),
    )
  ) {
    throw new Error(
      'A budget already exists for this category and period. Edit that budget instead.',
    );
  }
  return validateLedger({
    ...ledger,
    budgets: editing
      ? ledger.budgets.map((item) => (item.id === budget.id ? { ...item, ...budget } : item))
      : [...ledger.budgets, { ...budget }],
  });
}

function deleteBudget(ledger, id) {
  validateLedger(ledger);
  if (!ledger.budgets.some((item) => item.id === id))
    throw new Error('This budget no longer exists.');
  return { ...ledger, budgets: ledger.budgets.filter((item) => item.id !== id) };
}

function budgetProgress(ledger, budget) {
  validateLedger(ledger);
  if (!validBudget(budget, ledger)) throw new Error('This budget contains an invalid value.');
  const matching = ledger.transactions.filter(
    (item) =>
      item.type === 'expense' &&
      item.categoryId === budget.categoryId &&
      item.date >= budget.startDate &&
      item.date <= budget.endDate,
  );
  const spentMinor = matching.reduce((sum, item) => sum + item.amountMinor, 0);
  const percent = (spentMinor / budget.plannedMinor) * 100;
  return {
    spentMinor,
    remainingMinor: Math.max(0, budget.plannedMinor - spentMinor),
    overMinor: Math.max(0, spentMinor - budget.plannedMinor),
    percent,
    progress: Math.min(1, spentMinor / budget.plannedMinor),
    status:
      spentMinor < budget.plannedMinor
        ? 'under'
        : spentMinor === budget.plannedMinor
          ? 'at'
          : 'over',
    transactionCount: matching.length,
  };
}

function goalFromDraft(draft, id, ledger) {
  validateLedger(ledger);
  if (!draft || !GOAL_KINDS.some((item) => item.value === draft.kind))
    throw new Error('Choose a savings goal.');
  const goal = {
    id,
    walletId: ledger.wallet.id,
    kind: draft.kind,
    targetMinor: parseMoney(draft.amount, ledger.wallet.currency),
  };
  if (!validGoal(goal, ledger)) throw new Error('This savings goal contains an invalid value.');
  return goal;
}

function saveGoal(ledger, goal) {
  validateLedger(ledger);
  if (!validGoal(goal, ledger)) throw new Error('This savings goal contains an invalid value.');
  if (ledger.goal && ledger.goal.id !== goal.id)
    throw new Error('Edit or remove the existing savings goal before creating another.');
  return validateLedger({ ...ledger, goal: { ...ledger.goal, ...goal } });
}

function deleteGoal(ledger) {
  validateLedger(ledger);
  return ledger.goal === null ? ledger : { ...ledger, goal: null };
}

function goalProgress(ledger) {
  validateLedger(ledger);
  const balanceMinor = sumTransactions(ledger.transactions).balance;
  return goalProgressForBalance(balanceMinor, ledger.goal?.targetMinor ?? null);
}

function goalProgressForBalance(balanceMinor, targetMinor = null) {
  if (!Number.isSafeInteger(balanceMinor)) {
    throw new Error('Goal balance must be an exact integer number of minor units.');
  }
  if (targetMinor === null) return null;
  if (!Number.isSafeInteger(targetMinor) || targetMinor <= 0 || targetMinor > MAX_AMOUNT_MINOR) {
    throw new Error('Goal target must be a positive amount within the supported limit.');
  }
  const remaining = targetMinor - balanceMinor;
  const excess = balanceMinor - targetMinor;
  if (!Number.isSafeInteger(remaining) || !Number.isSafeInteger(excess)) {
    throw new Error('Goal arithmetic exceeds the supported exact-integer range.');
  }
  const percent = (Math.max(0, balanceMinor) / targetMinor) * 100;
  return {
    balanceMinor,
    targetMinor,
    remainingMinor: Math.max(0, remaining),
    excessMinor: Math.max(0, excess),
    percent,
    progress: Math.min(1, Math.max(0, balanceMinor) / targetMinor),
    status:
      balanceMinor < 0
        ? 'negative'
        : balanceMinor === 0
          ? 'not-started'
          : balanceMinor < targetMinor
            ? 'in-progress'
            : balanceMinor === targetMinor
              ? 'reached'
              : 'exceeded',
  };
}

function addAchievementOwnership(value, context) {
  const hasReserved =
    Object.hasOwn(value.wallet, 'incarnationId') ||
    Object.hasOwn(value.wallet, 'trackingStartedOn') ||
    Object.hasOwn(value, 'achievements');
  if (hasReserved) {
    validateAchievementState(value.achievements, value.wallet, value.mode);
    return value;
  }
  const identity = createWalletIdentity(context);
  return {
    ...value,
    wallet: { ...value.wallet, ...identity },
    achievements: emptyAchievementState(identity.incarnationId),
  };
}

function patchTransactionContext(transaction, patch, ledger) {
  validateLedger(ledger);
  if (!validTransaction(transaction, ledger))
    throw new Error('This transaction contains an invalid value.');
  const saved = ledger.transactions.find((item) => item.id === transaction.id);
  const base =
    transaction.context === undefined && saved?.context !== undefined
      ? { ...transaction, context: saved.context }
      : transaction;
  return applyContextPatch(base, patch, ledger.wallet.incarnationId);
}

function finishMigration(value, context) {
  const identified = addAchievementOwnership(value, context);
  return validateLedger({
    ...identified,
    transactions: identified.transactions.map((transaction) =>
      promoteLegacyContext(transaction, identified.wallet.incarnationId),
    ),
  });
}

function validateOriginalLedger(old) {
  if (
    !old ||
    old.version !== 1 ||
    !old.wallet ||
    !validId(old.wallet.id) ||
    !validText(old.wallet.name, 80) ||
    old.wallet.currency !== 'MYR' ||
    !Array.isArray(old.transactions) ||
    old.transactions.length > MAX_TRANSACTIONS ||
    new Set(old.transactions.map((item) => item?.id)).size !== old.transactions.length ||
    !old.transactions.every(
      (item) =>
        item &&
        validId(item.id) &&
        TRANSACTION_TYPES.includes(item.type) &&
        validText(item.title, 80) &&
        validText(item.category, 40) &&
        validDate(item.date) &&
        Number.isSafeInteger(item.amountCents) &&
        item.amountCents > 0 &&
        item.amountCents <= MAX_AMOUNT_MINOR,
    )
  ) {
    throw new Error(
      'The previous demo data cannot be safely migrated. Its saved data has been preserved.',
    );
  }
  return old;
}

/** Read-only reference inspection; never migrates, allocates an owner, or writes data. */
function collectStoredPhotoReferences(value) {
  if (value?.version === 1) validateOriginalLedger(value);
  else if (value?.version === 2) validateCoreLedger(value, 2);
  else if (value?.version === 3 || value?.version === 4)
    validatePlanningLedger(value, value.version);
  else if (value?.version === STORAGE_VERSION) validateLedger(value);
  else throw new Error('Photo references cannot be confirmed in an unsupported saved format.');
  const hasIdentity =
    Object.hasOwn(value.wallet, 'incarnationId') ||
    Object.hasOwn(value.wallet, 'trackingStartedOn') ||
    Object.hasOwn(value, 'achievements');
  if (value.version >= 4 || hasIdentity)
    validateAchievementState(value.achievements, value.wallet, value.mode);
  const references = new Map();
  for (const transaction of value.transactions) {
    if (transaction.context === undefined) continue;
    validateTransactionContext(transaction.context, value.wallet.incarnationId);
    const photo = transaction.context.photo;
    if (!photo) continue;
    if (!hasIdentity) throw new Error('A retained photo has no confirmed wallet owner.');
    const key = photoKey(photo);
    if (references.has(key) && !samePhotoRef(references.get(key), photo))
      throw new Error('Retained photo metadata is ambiguous.');
    references.set(key, photo);
  }
  return Array.from(references.values(), (photo) => ({ ...photo }));
}

function migrateLedger(value, context) {
  if (value?.version === STORAGE_VERSION) return validateLedger(value);
  if (value?.version === 2 || value?.version === 3 || value?.version === 4) {
    if (value.version === 2) validateCoreLedger(value, 2);
    else validatePlanningLedger(value, value.version);
    if (value.version === 4) validateAchievementState(value.achievements, value.wallet, value.mode);
    // Preserve extra fields on a known schema; validate reserved fields if already present.
    return finishMigration(
      {
        ...value,
        version: STORAGE_VERSION,
        budgets: Object.hasOwn(value, 'budgets') ? value.budgets : [],
        goal: Object.hasOwn(value, 'goal') ? value.goal : null,
      },
      context,
    );
  }
  // Validate the old complete payload before constructing or writing anything.
  const old = validateOriginalLedger(value);
  const categories = DEFAULT_CATEGORIES.map((item) => ({ ...item }));
  const claimed = new Set();
  let imported = 0;
  const transactions = old.transactions.map((item) => {
    let category = categories.find(
      (candidate) => candidate.type === item.type && candidate.name === item.category,
    );
    if (!category) {
      category = categories.find(
        (candidate) =>
          !claimed.has(candidate.id) &&
          candidate.type === item.type &&
          normalizedName(candidate.name) === normalizedName(item.category),
      );
      if (category) category.name = item.category;
    }
    if (!category) {
      imported += 1;
      category = {
        id: `imported-category-${imported}`,
        name: item.category,
        type: item.type,
        isDefault: false,
      };
      categories.push(category);
    }
    claimed.add(category.id);
    const { amountCents, category: oldCategoryName, ...preserved } = item;
    return {
      ...preserved,
      id: item.id,
      walletId: old.wallet.id,
      type: item.type,
      title: item.title,
      categoryId: category.id,
      date: item.date,
      amountMinor: amountCents,
    };
  });
  return finishMigration(
    {
      ...old,
      version: STORAGE_VERSION,
      mode: Object.hasOwn(old, 'mode') ? old.mode : 'sample',
      wallet: {
        ...old.wallet,
        id: old.wallet.id,
        name: old.wallet.name,
        currency: 'MYR',
        hasTransactionHistory: old.transactions.length > 0,
      },
      categories,
      transactions,
      budgets: Object.hasOwn(old, 'budgets') ? old.budgets : [],
      goal: Object.hasOwn(old, 'goal') ? old.goal : null,
    },
    context,
  );
}

module.exports = {
  STORAGE_VERSION,
  MAX_AMOUNT_MINOR,
  MAX_TRANSACTIONS,
  TRANSACTION_TYPES,
  BUDGET_PERIODS,
  GOAL_KINDS,
  CURRENCIES,
  DEFAULT_CATEGORIES,
  currencyInfo,
  localDate,
  validDate,
  parseMoney,
  amountInputValue,
  formatMoney,
  validateLedger,
  createEmptyLedger,
  createDemoLedger,
  migrateLedger,
  patchTransactionContext,
  collectStoredPhotoReferences,
  categoryForTransaction,
  transactionFromDraft,
  saveTransaction,
  deleteTransaction,
  createCategory,
  renameCategory,
  deleteCategory,
  updateWallet,
  canChangeCurrency,
  totals,
  periodTotals,
  periodBounds,
  budgetFromDraft,
  saveBudget,
  deleteBudget,
  budgetProgress,
  goalFromDraft,
  saveGoal,
  deleteGoal,
  goalProgress,
  goalProgressForBalance,
};
