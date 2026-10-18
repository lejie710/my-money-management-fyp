// The local preview stores money as integer sen and calendar dates as YYYY-MM-DD.
const STORAGE_VERSION = 1;
const MAX_CENTS = 999999999;
const TYPES = ['income', 'expense', 'debt'];

function localDate(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseAmount(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(text)) {
    throw new Error('Enter a positive amount with no more than two decimal places.');
  }
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents <= 0 || cents > MAX_CENTS) throw new Error('Amount must be between RM0.01 and RM9,999,999.99.');
  return cents;
}

function validTransaction(transaction) {
  return transaction && typeof transaction === 'object'
    && typeof transaction.id === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(transaction.id)
    && TYPES.includes(transaction.type)
    && typeof transaction.title === 'string' && transaction.title.trim().length > 0 && transaction.title.length <= 80
    && typeof transaction.category === 'string' && transaction.category.trim().length > 0 && transaction.category.length <= 40
    && validDate(transaction.date)
    && Number.isSafeInteger(transaction.amountCents) && transaction.amountCents > 0 && transaction.amountCents <= MAX_CENTS;
}

function validateLedger(ledger) {
  if (!ledger || ledger.version !== STORAGE_VERSION || !ledger.wallet
    || ledger.wallet.id !== 'personal' || ledger.wallet.currency !== 'MYR'
    || typeof ledger.wallet.name !== 'string' || !ledger.wallet.name.trim() || ledger.wallet.name.length > 80
    || !Array.isArray(ledger.transactions) || ledger.transactions.length > 10000
    || !ledger.transactions.every(validTransaction)
    || new Set(ledger.transactions.map(item => item.id)).size !== ledger.transactions.length) {
    throw new Error('Saved demo data has an unsupported or invalid format.');
  }
  return ledger;
}

function transactionFromDraft(draft, id) {
  const transaction = {
    id,
    type: draft.type,
    title: draft.title.trim(),
    category: draft.category.trim(),
    date: draft.date.trim(),
    amountCents: parseAmount(draft.amount),
  };
  if (!transaction.title || transaction.title.length > 80) throw new Error('Enter a title of 1 to 80 characters.');
  if (!transaction.category || transaction.category.length > 40) throw new Error('Enter a category of 1 to 40 characters.');
  if (!validDate(transaction.date)) throw new Error('Enter a real date as YYYY-MM-DD, between 1900 and 2100.');
  if (!validTransaction(transaction)) throw new Error('This transaction contains an invalid value.');
  return transaction;
}

function saveTransaction(ledger, transaction, editing = false) {
  validateLedger(ledger);
  if (!validTransaction(transaction)) throw new Error('This transaction contains an invalid value.');
  const exists = ledger.transactions.some(item => item.id === transaction.id);
  if (editing && !exists) throw new Error('This transaction no longer exists.');
  if (!editing && exists) throw new Error('This transaction already exists. Please try again.');
  return validateLedger({ ...ledger, transactions: editing
    ? ledger.transactions.map(item => item.id === transaction.id ? { ...transaction } : item)
    : [...ledger.transactions, { ...transaction }] });
}

function deleteTransaction(ledger, id) {
  validateLedger(ledger);
  if (!ledger.transactions.some(item => item.id === id)) throw new Error('This transaction no longer exists.');
  return { ...ledger, transactions: ledger.transactions.filter(item => item.id !== id) };
}

function totals(ledger) {
  validateLedger(ledger);
  const result = { income: 0, expense: 0, debt: 0, balance: 0 };
  for (const transaction of ledger.transactions) result[transaction.type] += transaction.amountCents;
  result.balance = result.income - result.expense - result.debt;
  return result;
}

function formatMoney(cents) {
  const value = (Math.abs(cents) / 100).toFixed(2);
  const [whole, fraction] = value.split('.');
  return `${cents < 0 ? '-' : ''}RM${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

function createDemoLedger(date = new Date()) {
  const today = localDate(date);
  return validateLedger({
    version: STORAGE_VERSION,
    wallet: { id: 'personal', name: 'My personal wallet', currency: 'MYR' },
    transactions: [
      { id: 'sample-salary', title: 'Monthly salary', category: 'Salary', type: 'income', amountCents: 320000, date: `${today.slice(0, 8)}01` },
      { id: 'sample-groceries', title: 'Weekly groceries', category: 'Food & beverages', type: 'expense', amountCents: 8640, date: today },
      { id: 'sample-transport', title: 'Train and bus', category: 'Transport', type: 'expense', amountCents: 2560, date: today },
    ],
  });
}

module.exports = { STORAGE_VERSION, localDate, validDate, parseAmount, validateLedger, transactionFromDraft, saveTransaction, deleteTransaction, totals, formatMoney, createDemoLedger };
