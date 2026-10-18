const test = require('node:test');
const assert = require('node:assert/strict');
const { createLedgerStorage, STORAGE_KEY } = require('../src/demo/storage');
const { createDemoLedger, saveTransaction, transactionFromDraft, totals } = require('../src/demo/ledger');

test('saved edits survive a new storage instance with the same exact totals', async () => {
  const data = new Map();
  const adapter = { async getItem(key) { return data.get(key) ?? null; }, async setItem(key, value) { data.set(key, value); } };
  const store = createLedgerStorage(adapter);
  assert.equal(await store.load(), null);
  let ledger = createDemoLedger(new Date(2026, 9, 17));
  ledger = saveTransaction(ledger, transactionFromDraft({ type: 'expense', amount: '0.30', title: 'Test', category: 'Test', date: '2026-10-17' }, 'test'));
  await store.save(ledger);
  const reloaded = await createLedgerStorage(adapter).load();
  assert.deepEqual(reloaded, ledger);
  assert.deepEqual(totals(reloaded), totals(ledger));
  assert.equal(data.size, 1);
  assert.equal(data.has(STORAGE_KEY), true);
});

test('unreadable or corrupt saved data fails without overwriting existing bytes', async () => {
  for (const content of ['broken JSON', JSON.stringify({ version: 99 })]) {
    let writes = 0;
    const store = createLedgerStorage({ async getItem() { return content; }, async setItem() { writes += 1; } });
    await assert.rejects(() => store.load());
    assert.equal(writes, 0);
  }
  const unavailable = createLedgerStorage({ async getItem() { throw new Error('Storage unavailable'); }, async setItem() { throw new Error('Should not write'); } });
  await assert.rejects(() => unavailable.load(), /unavailable/);
});

test('failed persistence cannot return a successfully saved ledger', async () => {
  const store = createLedgerStorage({ async getItem() { return null; }, async setItem() { throw new Error('Disk full'); } });
  await assert.rejects(() => store.save(createDemoLedger()), /Disk full/);
});
