const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAmount, validDate, localDate, createDemoLedger, transactionFromDraft, saveTransaction, deleteTransaction, totals, validateLedger } = require('../src/demo/ledger');

test('money input uses exact sen and rejects ambiguous or invalid values', () => {
  assert.equal(parseAmount('0.10'), 10);
  assert.equal(parseAmount('0.20'), 20);
  assert.equal(parseAmount(' 12.5 '), 1250);
  assert.equal(parseAmount('9999999.99'), 999999999);
  for (const value of ['', '0', '-1', '1.999', '1e3', '1,000', 'NaN', '10000000', 'RM5']) {
    assert.throws(() => parseAmount(value), undefined, value);
  }
});

test('calendar dates reject rollover dates and preserve the local calendar day', () => {
  assert.equal(validDate('2024-02-29'), true);
  for (const date of ['2023-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '17/10/2026', '2026-1-01', '1899-12-31']) {
    assert.equal(validDate(date), false, date);
  }
  assert.equal(localDate(new Date(2026, 9, 17, 0, 5)), '2026-10-17');
});

test('add, edit, and delete update exact totals and leave prior state unchanged', () => {
  const original = { ...createDemoLedger(new Date(2026, 9, 17)), transactions: [] };
  const make = (id, type, amount) => transactionFromDraft({ type, amount, title: id, category: 'Test', date: '2026-10-17' }, id);
  let ledger = saveTransaction(original, make('salary', 'income', '100.00'));
  ledger = saveTransaction(ledger, make('coffee', 'expense', '0.10'));
  ledger = saveTransaction(ledger, make('food', 'expense', '0.20'));
  ledger = saveTransaction(ledger, make('loan', 'debt', '10.00'));
  assert.deepEqual(totals(ledger), { income: 10000, expense: 30, debt: 1000, balance: 8970 });
  ledger = saveTransaction(ledger, make('coffee', 'expense', '1.00'), true);
  assert.equal(totals(ledger).balance, 8880);
  ledger = deleteTransaction(ledger, 'loan');
  assert.equal(totals(ledger).balance, 9880);
  assert.equal(original.transactions.length, 0);
  assert.throws(() => saveTransaction(ledger, make('salary', 'income', '1')));
  assert.throws(() => saveTransaction(ledger, make('missing', 'income', '1'), true));
  assert.throws(() => deleteTransaction(ledger, 'missing'));
});

test('saving requires a real date and meaningful title and category', () => {
  const draft = { type: 'expense', amount: '12.50', title: ' Lunch ', category: ' Food ', date: '2026-10-17' };
  assert.equal(transactionFromDraft(draft, 'test').title, 'Lunch');
  for (const patch of [{ title: ' ' }, { category: '' }, { date: '2026-02-30' }, { type: 'other' }]) {
    assert.throws(() => transactionFromDraft({ ...draft, ...patch }, 'test'));
  }
});

test('persisted schema rejects duplicate IDs, invalid amounts, and unknown versions', () => {
  const ledger = createDemoLedger(new Date(2026, 9, 17));
  assert.throws(() => validateLedger({ ...ledger, version: 2 }));
  assert.throws(() => validateLedger({ ...ledger, transactions: [ledger.transactions[0], ledger.transactions[0]] }));
  assert.throws(() => validateLedger({ ...ledger, transactions: [{ ...ledger.transactions[0], amountCents: 0.1 }] }));
  assert.deepEqual(totals({ ...ledger, transactions: [] }), { income: 0, expense: 0, debt: 0, balance: 0 });
});
