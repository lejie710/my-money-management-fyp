const test = require('node:test'),
  assert = require('node:assert/strict');
const { ledgerFixture, model } = require('./helpers/account-hook-harness.cjs');
const { deferred } = require('./helpers/native-adapter-vm.cjs');
function expense(ledger) {
  return model.saveTransaction(
    ledger,
    model.transactionFromDraft(
      {
        type: 'expense',
        title: 'Synthetic import',
        amount: '5',
        date: '2026-10-18',
        categoryId: 'expense-food',
      },
      'import-one',
      ledger,
    ),
  );
}
test('real ledger compare-and-save rejects a changed owner or stale bytes before any write', async () => {
  const f = ledgerFixture();
  await f.open();
  const view = f.render(),
    bytes = JSON.stringify(view.ledger),
    next = expense(view.ledger),
    before = f.storage.calls.save;
  assert.equal(await view.compareAndSave('different-owner', bytes, next, 'No'), false);
  assert.equal(await view.compareAndSave(view.ownerToken, bytes + ' ', next, 'No'), false);
  assert.equal(f.storage.calls.save, before);
  assert.equal(f.render().ledger.transactions.length, 0);
  f.host.unmount();
});
test('compare-and-save acquires the existing write exclusion synchronously and cannot be overtaken', async () => {
  const f = ledgerFixture();
  await f.open();
  const view = f.render(),
    bytes = JSON.stringify(view.ledger),
    next = expense(view.ledger),
    hold = deferred();
  f.storage.faults.beforeSave = () => hold.promise;
  const pending = view.compareAndSave(view.ownerToken, bytes, next, 'Import confirmed');
  assert.equal(view.getIdentityState().writeInFlight, true);
  assert.equal(await view.compareAndSave(view.ownerToken, bytes, next, 'Duplicate'), false);
  assert.equal(view.acquireIdentityLease().ok, false);
  hold.resolve();
  assert.equal(await pending, true);
  assert.equal(f.render().ledger.transactions.length, 1);
  assert.equal(f.render().status, 'Import confirmed');
  f.host.unmount();
});
