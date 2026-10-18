const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/core/model');
const v1 = require('../src/demo/ledger');

function add(ledger, id, type, amount, date = '2026-10-17', categoryId) {
  const defaults = { income: 'income-salary', expense: 'expense-food', debt: 'debt-loan' };
  const transaction = model.transactionFromDraft(
    { type, amount, title: id, categoryId: categoryId ?? defaults[type], date },
    id,
    ledger,
  );
  return model.saveTransaction(ledger, transaction);
}

test('all original currencies use exact minor units, with zero-decimal JPY', () => {
  assert.equal(model.CURRENCIES.length, 8);
  for (const currency of model.CURRENCIES) {
    if (currency.code === 'JPY') {
      assert.equal(model.parseMoney('1250', currency.code), 1250);
      assert.equal(model.formatMoney(1250, currency.code), '¥1,250');
      assert.equal(model.amountInputValue(1250, currency.code), '1250');
      assert.throws(() => model.parseMoney('12.50', currency.code), /whole-yen/);
      assert.throws(() => model.parseMoney('12.0', currency.code), /whole-yen/);
    } else {
      assert.equal(model.parseMoney('12.50', currency.code), 1250);
      assert.equal(model.amountInputValue(1250, currency.code), '12.50');
      assert.equal(
        model.parseMoney('0.1', currency.code) + model.parseMoney('0.2', currency.code),
        30,
      );
    }
  }
  assert.equal(model.formatMoney(-120050, 'MYR'), '-RM1,200.50');
  assert.throws(() => model.parseMoney('10', 'XXX'));
  for (const value of ['', '0', '-1', '1e3', '1,000', 'NaN', '0.001', '10000000', '12.50junk']) {
    assert.throws(() => model.parseMoney(value, 'MYR'), undefined, value);
  }
  assert.equal(model.parseMoney('9999999.99'), model.MAX_AMOUNT_MINOR);
  assert.equal(model.parseMoney('999999999', 'JPY'), model.MAX_AMOUNT_MINOR);
});

test('strict calendar dates include leap years and reject silent date rollover', () => {
  for (const date of ['2024-02-29', '2000-02-29', '2026-12-31', '2027-01-01'])
    assert.equal(model.validDate(date), true);
  for (const date of [
    '1900-02-29',
    '2023-02-29',
    '2026-04-31',
    '2026-00-01',
    '2026-13-01',
    '2026-1-01',
    '17/10/2026',
  ])
    assert.equal(model.validDate(date), false, date);
  assert.equal(model.localDate(new Date(2026, 9, 17, 0, 5)), '2026-10-17');
  assert.throws(() => model.localDate(new Date('invalid')));
});

test('fresh setup is empty while sample setup is explicitly marked and populated', () => {
  const fresh = model.createEmptyLedger({ name: 'Travel demo', currency: 'JPY' });
  assert.equal(fresh.mode, 'local');
  assert.equal(fresh.wallet.currency, 'JPY');
  assert.equal(fresh.wallet.hasTransactionHistory, false);
  assert.equal(fresh.transactions.length, 0);
  assert.ok(
    model.TRANSACTION_TYPES.every((type) => fresh.categories.some((item) => item.type === type)),
  );
  const sample = model.createDemoLedger(new Date(2026, 9, 17));
  assert.equal(sample.mode, 'sample');
  assert.equal(sample.wallet.hasTransactionHistory, true);
  assert.equal(sample.transactions.length, 3);
  assert.equal(model.totals(sample).balance, 308800);
  assert.throws(() => model.createEmptyLedger({ name: '  ' }));
});

test('currency can change before history but cannot relabel an existing or deleted ledger', () => {
  const initial = model.createEmptyLedger();
  const yen = model.updateWallet(initial, { name: 'Japan demo', currency: 'JPY' });
  const recorded = add(yen, 'salary', 'income', '1000');
  assert.equal(model.totals(recorded).income, 1000);
  assert.throws(() => model.updateWallet(recorded, { currency: 'USD' }), /Currency cannot change/);
  const emptied = model.deleteTransaction(recorded, 'salary');
  assert.equal(emptied.transactions.length, 0);
  assert.equal(emptied.wallet.hasTransactionHistory, true);
  assert.throws(() => model.updateWallet(emptied, { currency: 'MYR' }), /Currency cannot change/);
  assert.equal(
    model.updateWallet(recorded, { name: 'Renamed wallet' }).wallet.name,
    'Renamed wallet',
  );
  assert.equal(recorded.wallet.name, 'Japan demo');
  assert.equal(initial.wallet.currency, 'MYR');
});

test('category IDs survive rename and used categories cannot be deleted', () => {
  let ledger = model.createEmptyLedger();
  ledger = model.createCategory(ledger, { id: 'custom-coffee', name: ' Coffee ', type: 'expense' });
  assert.equal(ledger.categories.find((item) => item.id === 'custom-coffee').name, 'Coffee');
  assert.throws(
    () => model.createCategory(ledger, { name: ' coffee ', type: 'expense' }),
    /already exists/,
  );
  ledger = add(ledger, 'morning', 'expense', '12.50', '2026-10-17', 'custom-coffee');
  const renamed = model.renameCategory(ledger, 'custom-coffee', 'Café');
  assert.equal(renamed.transactions[0].categoryId, 'custom-coffee');
  assert.equal(model.categoryForTransaction(renamed, renamed.transactions[0]).name, 'Café');
  assert.equal(model.totals(renamed).balance, -1250);
  assert.equal(ledger.categories.find((item) => item.id === 'custom-coffee').name, 'Coffee');
  assert.throws(() => model.deleteCategory(renamed, 'custom-coffee'), /used by a transaction/);
  assert.throws(
    () => model.renameCategory(renamed, 'custom-coffee', 'Food & beverages'),
    /already exists/,
  );
  const deleted = model.deleteCategory(
    model.deleteTransaction(renamed, 'morning'),
    'custom-coffee',
  );
  assert.equal(
    deleted.categories.some((item) => item.id === 'custom-coffee'),
    false,
  );
});

test('transaction category, wallet, IDs, and amount cannot drift apart', () => {
  let ledger = model.createEmptyLedger();
  assert.throws(
    () =>
      model.transactionFromDraft(
        {
          type: 'income',
          title: 'Bad category',
          categoryId: 'expense-food',
          date: '2026-10-17',
          amount: '10',
        },
        'bad',
        ledger,
      ),
    /matching/,
  );
  assert.throws(
    () =>
      model.transactionFromDraft(
        {
          type: 'expense',
          title: 'Bad date',
          categoryId: 'expense-food',
          date: '2026-02-30',
          amount: '10',
        },
        'bad',
        ledger,
      ),
    /real date/,
  );
  ledger = add(ledger, 'one', 'expense', '10');
  assert.throws(() => model.saveTransaction(ledger, ledger.transactions[0]), /already exists/);
  assert.throws(
    () =>
      model.saveTransaction(
        ledger,
        { ...ledger.transactions[0], walletId: 'another-wallet' },
        true,
      ),
    /invalid/,
  );
  assert.throws(
    () => model.saveTransaction(ledger, { ...ledger.transactions[0], amountMinor: 10.5 }, true),
    /invalid/,
  );
  assert.throws(
    () => model.saveTransaction(ledger, { ...ledger.transactions[0], id: 'absent' }, true),
    /no longer exists/,
  );
  assert.throws(() => model.deleteTransaction(ledger, 'absent'), /no longer exists/);
});

test('all-record totals and monthly totals reconcile with debt counted once', () => {
  let ledger = model.createEmptyLedger();
  for (const record of [
    ['income', 'income', '1000', '2026-10-01'],
    ['food-october', 'expense', '80', '2026-10-17'],
    ['food-september', 'expense', '50', '2026-09-30'],
    ['food-november', 'expense', '20', '2026-11-01'],
    ['transport', 'expense', '30', '2026-10-31', 'expense-transport'],
    ['debt', 'debt', '40', '2026-10-31'],
  ])
    ledger = add(ledger, ...record);
  assert.deepEqual(model.totals(ledger), {
    income: 100000,
    expense: 18000,
    debt: 4000,
    balance: 78000,
  });
  assert.deepEqual(model.periodTotals(ledger, '2026-10-01', '2026-10-31'), {
    income: 100000,
    expense: 11000,
    debt: 4000,
    balance: 85000,
  });
  const edited = model.transactionFromDraft(
    {
      type: 'expense',
      title: 'food-october',
      categoryId: 'expense-food',
      date: '2026-10-17',
      amount: '120',
    },
    'food-october',
    ledger,
  );
  ledger = model.saveTransaction(ledger, edited, true);
  assert.equal(model.totals(ledger).balance, 74000);
  ledger = model.deleteTransaction(ledger, 'food-october');
  assert.equal(model.totals(ledger).balance, 86000);
  assert.equal(model.periodTotals(ledger, '2026-10-01', '2026-10-31').expense, 3000);
});

test('inclusive period boundaries handle leap day, year change, and empty periods', () => {
  let ledger = model.createEmptyLedger();
  for (const record of [
    ['leap-before', 'expense', '1', '2024-02-28'],
    ['leap-day', 'expense', '2', '2024-02-29'],
    ['leap-after', 'expense', '4', '2024-03-01'],
    ['year-end', 'expense', '8', '2026-12-31'],
    ['year-start', 'expense', '16', '2027-01-01'],
  ])
    ledger = add(ledger, ...record);
  assert.equal(model.periodTotals(ledger, '2024-02-01', '2024-02-29').expense, 300);
  assert.equal(model.periodTotals(ledger, '2026-12-31', '2027-01-01').expense, 2400);
  assert.deepEqual(model.periodTotals(ledger, '2025-01-01', '2025-12-31'), {
    income: 0,
    expense: 0,
    debt: 0,
    balance: 0,
  });
  assert.throws(() => model.periodTotals(ledger, '2026-10-31', '2026-10-01'), /chronological/);
  assert.throws(() => model.periodTotals(ledger, '2023-02-29', '2023-03-01'), /valid start/);
});

test('v1 migration preserves IDs, wallet, names, dates, amounts, and category spellings', () => {
  const old = v1.createDemoLedger(new Date(2026, 9, 17));
  old.wallet.name = 'My unchanged wallet';
  old.transactions.push({
    id: 'custom-old',
    type: 'expense',
    title: 'My original title',
    category: 'coffee',
    date: '2024-02-29',
    amountCents: 1201,
  });
  old.transactions.push({
    id: 'custom-case',
    type: 'expense',
    title: 'Case variation',
    category: 'Coffee',
    date: '2026-01-01',
    amountCents: 30,
  });
  const before = JSON.stringify(old);
  const migrated = model.migrateLedger(old);
  assert.equal(JSON.stringify(old), before);
  assert.equal(migrated.wallet.id, old.wallet.id);
  assert.equal(migrated.wallet.name, old.wallet.name);
  assert.equal(migrated.wallet.currency, old.wallet.currency);
  assert.equal(migrated.wallet.hasTransactionHistory, true);
  for (const original of old.transactions) {
    const current = migrated.transactions.find((item) => item.id === original.id);
    assert.ok(current);
    assert.equal(current.amountMinor, original.amountCents);
    assert.equal(current.title, original.title);
    assert.equal(current.date, original.date);
    assert.equal(current.type, original.type);
    assert.equal(model.categoryForTransaction(migrated, current).name, original.category);
  }
  assert.deepEqual(model.totals(migrated), v1.totals(old));
  assert.equal(model.migrateLedger(migrated), migrated);
  const caseCategory = model.categoryForTransaction(
    migrated,
    migrated.transactions.find((item) => item.id === 'custom-case'),
  );
  assert.equal(model.renameCategory(migrated, caseCategory.id, caseCategory.name), migrated);
});

test('migration and current schema validation reject corruption instead of discarding records', () => {
  const old = v1.createDemoLedger(new Date(2026, 9, 17));
  for (const bad of [
    { ...old, version: 99 },
    { ...old, wallet: { ...old.wallet, currency: 'USD' } },
    { ...old, transactions: [old.transactions[0], old.transactions[0]] },
    { ...old, transactions: [{ ...old.transactions[0], amountCents: 1.2 }] },
  ])
    assert.throws(() => model.migrateLedger(bad), /safely migrated/);
  const current = model.createDemoLedger(new Date(2026, 9, 17));
  assert.throws(() => model.validateLedger({ ...current, version: 99 }));
  assert.throws(() =>
    model.validateLedger({
      ...current,
      wallet: { ...current.wallet, hasTransactionHistory: false },
    }),
  );
  assert.throws(() => model.validateLedger({ ...current, categories: [] }));
  assert.throws(() =>
    model.validateLedger({
      ...current,
      categories: [...current.categories, current.categories[0]],
    }),
  );
  const emptyOld = { ...old, transactions: [] };
  assert.equal(model.migrateLedger(emptyOld).wallet.hasTransactionHistory, false);
});

test('shared goal calculation preserves actual negative deficits and over-target progress', () => {
  assert.equal(model.goalProgressForBalance(0), null);
  assert.equal(model.goalProgressForBalance(-20000, null), null);
  const negative = model.goalProgressForBalance(-20000, 100000);
  assert.equal(negative.balanceMinor, -20000);
  assert.equal(negative.remainingMinor, 120000);
  assert.equal(negative.percent, 0);
  assert.equal(negative.status, 'negative');
  const exceeded = model.goalProgressForBalance(120000, 100000);
  assert.equal(exceeded.percent, 120);
  assert.equal(exceeded.progress, 1);
  assert.equal(exceeded.excessMinor, 20000);
  const ledger = model.createDemoLedger(new Date(2026, 9, 17));
  const withGoal = model.saveGoal(
    ledger,
    model.goalFromDraft({ kind: 'home', amount: '4000' }, 'goal', ledger),
  );
  assert.deepEqual(
    model.goalProgress(withGoal),
    model.goalProgressForBalance(model.totals(withGoal).balance, 400000),
  );
});

test('shared goal calculation rejects invalid values and exact-integer overflow', () => {
  for (const balance of [0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => model.goalProgressForBalance(balance, 10000), /exact integer/);
  }
  for (const target of [0, -1, 0.1, NaN, Infinity, model.MAX_AMOUNT_MINOR + 1]) {
    assert.throws(() => model.goalProgressForBalance(0, target), /positive amount/);
  }
  assert.throws(
    () => model.goalProgressForBalance(Number.MIN_SAFE_INTEGER, 1),
    /exact-integer range/,
  );
});
