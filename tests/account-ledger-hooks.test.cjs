const test = require('node:test'),
  assert = require('node:assert/strict');
const { ledgerFixture, ledger, store, clock, model, owner } = require('./helpers/account-hook-harness.cjs');
const { deferred, flush } = require('./helpers/native-adapter-vm.cjs');
function add(value, id = 'entry-one') {
  return model.saveTransaction(
    value,
    model.transactionFromDraft(
      {
        type: 'expense',
        title: 'Synthetic expense',
        categoryId: 'expense-other',
        date: '2026-10-18',
        amount: '1.00',
      },
      id,
      value,
    ),
  );
}

test('default guest hook preserves isolated v5 startup and deferred startup performs no store read', async () => {
  const normal = ledgerFixture({ autoDefault: true, defer: false });
  await normal.open();
  assert.equal(normal.render().ledger.version, 5);
  assert.equal(normal.render().ledger.mode, 'local');
  assert.ok(normal.bytes.has('@mymoney/test/account-hook-test/v5'));
  assert.equal(
    [...normal.bytes.keys()].some((key) => key.startsWith('@mymoney/core/')),
    false,
  );
  const deferredHook = ledgerFixture();
  deferredHook.render();
  await flush();
  assert.equal(deferredHook.storage.calls.load, 0);
  assert.equal(deferredHook.storage.calls.read, 0);
  assert.equal(deferredHook.render().acquireIdentityLease().ok, true);
});

test('identity lease freezes saves/restores synchronously and rejects counterfeit lease or owner release', async () => {
  const f = ledgerFixture();
  await f.open();
  const view = f.render(),
    before = f.storage.calls.save;
  const held = view.acquireIdentityLease();
  assert.equal(held.ok, true);
  assert.equal(await view.save(add(view.ledger), 'Saved'), false);
  assert.equal(await view.restore(), false);
  assert.equal(f.storage.calls.save, before);
  assert.equal(view.isIdentityLeaseReady(held.lease), true);
  assert.equal(view.releaseIdentityLease({}, view.ownerToken), false);
  assert.equal(view.releaseIdentityLease(held.lease, 'different-owner'), false);
  assert.equal(view.releaseIdentityLease(held.lease, view.ownerToken), true);
});

test('an in-flight financial write refuses identity acquisition before React rerenders', async () => {
  const f = ledgerFixture();
  await f.open();
  const work = deferred();
  f.storage.faults.beforeSave = () => work.promise;
  const view = f.render(),
    pending = view.save(add(view.ledger), 'Saved');
  assert.equal(view.acquireIdentityLease().ok, false);
  assert.equal(view.getIdentityState().writeInFlight, true);
  work.resolve();
  assert.equal(await pending, true);
  assert.equal(f.render().acquireIdentityLease().ok, true);
});

test('a remounted hook shares the pending financial write and cannot bypass its identity exclusion', async () => {
  const f = ledgerFixture();
  await f.open();
  const work = deferred();
  f.storage.faults.beforeSave = () => work.promise;
  const before = f.render(),
    pending = before.save(add(before.ledger), 'Saved after remount');
  const remounted = f.remount();
  assert.equal(remounted.saving, true);
  assert.equal(remounted.getIdentityState().writeInFlight, true);
  assert.equal(remounted.acquireIdentityLease().ok, false);
  assert.equal(await remounted.restore(), false);
  work.resolve();
  assert.equal(await pending, true);
  assert.equal(f.render().saving, false);
  assert.equal(f.render().ledger.transactions.length, 1);
  assert.equal(f.render().status, 'Saved after remount');
  assert.equal(f.render().acquireIdentityLease().ok, true);
  assert.equal(f.storage.calls.save, 1);
});

test('same-incarnation restore renews callback generation without permitting a previous editor write', async () => {
  const f = ledgerFixture();
  await f.open();
  const before = f.render();
  f.storage.data = { ...before.ledger, wallet: { ...before.ledger.wallet, name: 'Restored name' } };
  assert.equal(await before.restore(), true);
  const restored = f.render(),
    writes = f.storage.calls.save;
  assert.equal(restored.ledger.wallet.incarnationId, before.ledger.wallet.incarnationId);
  assert.notEqual(restored.bindingToken, before.bindingToken);
  assert.equal(await before.save(add(before.ledger), 'Stale editor'), false);
  assert.equal(f.storage.calls.save, writes);
  assert.equal(restored.ledger.wallet.name, 'Restored name');
});

test('old-family save and restore closures cannot touch another UID with an equal incarnation', async () => {
  const f = ledgerFixture();
  await f.open();
  const old = f.render(),
    held = old.acquireIdentityLease();
  const familyB = { scope: f.family.scope, actor: { kind: 'firebase', uid: 'synthetic-B' } },
    dataB = ledger('B'),
    storageB = store(dataB);
  const adoption = await old.adoptIdentityTarget(
    held.lease,
    f.target(familyB, dataB, storageB),
    () => true,
  );
  assert.equal(adoption.ok, true);
  assert.equal(f.render().identityPending, true);
  assert.equal(old.releaseIdentityLease(held.lease, f.render().ownerToken), true);
  const reads = f.storage.calls.read,
    writesB = storageB.calls.save;
  assert.equal(await old.save(add(old.ledger), 'Stale'), false);
  assert.equal(await old.restore(), false);
  assert.equal(f.storage.calls.read, reads);
  assert.equal(storageB.calls.save, writesB);
  assert.equal(f.render().ledger.wallet.name, 'B');
});

test('Start fresh renews generation so stale same-family callbacks cannot resurrect the old wallet', async () => {
  const f = ledgerFixture();
  await f.open();
  const old = f.render();
  old.registerTransitionGuard({
    async prepare() {
      return { ok: true, pending: false };
    },
    async resume() {
      return { ok: true, pending: false };
    },
  });
  const fresh = ledger('Fresh', 'fresh-incarnation');
  assert.equal(await old.save(fresh, 'Fresh'), true);
  const current = f.render(),
    reads = f.storage.calls.read,
    writes = f.storage.calls.save;
  assert.notEqual(current.bindingToken, old.bindingToken);
  assert.equal(await old.save(old.ledger, 'Resurrect'), false);
  assert.equal(await old.restore(), false);
  assert.equal(f.storage.calls.save, writes);
  assert.equal(f.storage.calls.read, reads);
  assert.equal(current.ledger.wallet.incarnationId, 'fresh-incarnation');
});

test('uncertain financial write blocks identity until an active-store restore confirms it without reseeding', async () => {
  const f = ledgerFixture();
  await f.open();
  const old = f.render();
  f.storage.faults.beforeSave = async () => {
    throw Error('Write failed');
  };
  f.storage.faults.read = async () => {
    throw Error('Read unknown');
  };
  assert.equal(await old.save(add(old.ledger), 'Uncertain'), false);
  assert.equal(f.render().uncertain, true);
  assert.equal(f.render().acquireIdentityLease().ok, false);
  const loads = f.storage.calls.load;
  f.storage.faults.beforeSave = null;
  f.storage.faults.read = null;
  assert.equal(await f.render().restore(), true);
  assert.equal(f.storage.calls.load, loads);
  assert.equal(f.render().uncertain, false);
  assert.equal(f.render().acquireIdentityLease().ok, true);
});

test('a failed active-store restore blocks old editor saves until saved records can be read again', async () => {
  const f = ledgerFixture();
  await f.open();
  const before = f.render(),
    writes = f.storage.calls.save;
  f.storage.faults.read = async () => {
    throw Error('Read unavailable');
  };
  assert.equal(await before.restore(), false);
  assert.equal(f.render().loadError, true);
  assert.equal(await before.save(add(before.ledger), 'Unsafe stale save'), false);
  assert.equal(f.storage.calls.save, writes);
  assert.equal(f.render().acquireIdentityLease().ok, false);
  f.storage.faults.read = null;
  assert.equal(await f.render().restore(), true);
  assert.equal(await f.render().save(add(f.render().ledger), 'Recovered save'), true);
});

test('adoption reconciles milestones durably under the lease and returns the actual saved ledger', async () => {
  const f = ledgerFixture();
  await f.open();
  const held = f.render().acquireIdentityLease();
  const familyB = { scope: f.family.scope, actor: { kind: 'firebase', uid: 'synthetic-B' } },
    dataB = add(ledger('B')),
    storageB = store(dataB);
  const result = await f
    .render()
    .adoptIdentityTarget(held.lease, f.target(familyB, dataB, storageB), () => true);
  assert.equal(result.ok, true);
  assert.ok(result.durableLedger.achievements.awards.length > dataB.achievements.awards.length);
  assert.equal(JSON.stringify(result.durableLedger), JSON.stringify(storageB.data));
  assert.equal(f.render().identityPending, true);
});

test('unknown adoption writes retain the lease, disable SDK readiness and never publish or reseed another family', async () => {
  const f = ledgerFixture();
  await f.open();
  const before = f.render(),
    held = before.acquireIdentityLease();
  const familyB = { scope: f.family.scope, actor: { kind: 'firebase', uid: 'synthetic-B' } },
    dataB = add(ledger('B')),
    storageB = store(dataB);
  storageB.faults.afterSave = async () => {
    throw Error('Write response lost');
  };
  storageB.faults.read = async () => {
    throw Error('Read unknown');
  };
  const result = await before.adoptIdentityTarget(
    held.lease,
    f.target(familyB, dataB, storageB),
    () => true,
  );
  assert.equal(result.walletWriteUnconfirmed, true);
  assert.equal(f.render().ledger.wallet.name, 'A');
  assert.equal(before.isIdentityLeaseReady(held.lease), false);
  assert.equal(before.releaseIdentityLease(held.lease, before.ownerToken), false);
  const familyC = { scope: f.family.scope, actor: { kind: 'firebase', uid: 'synthetic-C' } },
    dataC = ledger('C'),
    storageC = store(dataC);
  assert.equal(
    (await before.adoptIdentityTarget(held.lease, f.target(familyC, dataC, storageC), () => true))
      .ok,
    false,
  );
  assert.equal(storageC.calls.save, 0);
  assert.equal(storageC.calls.read, 0);
  storageB.faults.afterSave = null;
  storageB.faults.read = null;
  const actual = storageB.data;
  assert.equal(
    (await before.adoptIdentityTarget(held.lease, f.target(familyB, actual, storageB), () => true))
      .ok,
    true,
  );
  assert.equal(before.isIdentityLeaseReady(held.lease), true);
  assert.equal(storageB.calls.load, 0);
});

test('adoption checks target currentness after delayed storage and exposes no stale target result', async () => {
  const f = ledgerFixture();
  await f.open();
  const held = f.render().acquireIdentityLease(),
    read = deferred();
  let current = true;
  const familyB = { scope: f.family.scope, actor: { kind: 'firebase', uid: 'synthetic-B' } },
    dataB = ledger('B'),
    storageB = store(dataB);
  storageB.faults.read = () => read.promise;
  const pending = f
    .render()
    .adoptIdentityTarget(held.lease, f.target(familyB, dataB, storageB), () => current);
  assert.equal(f.render().isIdentityLeaseReady(held.lease), false);
  current = false;
  read.resolve();
  assert.equal((await pending).ok, false);
  assert.equal(f.render().ledger.wallet.name, 'A');
});

test('multiple commit observers are independent and a retired observer error cannot overwrite a new family', async () => {
  const f = ledgerFixture();
  await f.open();
  const late = deferred(),
    seen = [];
  f.render().registerCommitObserver(() => {
    seen.push('first');
    return late.promise;
  });
  const remove = f.render().registerCommitObserver(() => {
    seen.push('second');
  });
  assert.equal(await f.render().save(add(f.render().ledger), 'Saved'), true);
  assert.deepEqual(seen, ['first', 'second']);
  remove();
  const held = f.render().acquireIdentityLease(),
    familyB = { scope: f.family.scope, actor: { kind: 'firebase', uid: 'synthetic-B' } },
    dataB = ledger('B'),
    storageB = store(dataB);
  await f.render().adoptIdentityTarget(held.lease, f.target(familyB, dataB, storageB), () => true);
  f.render().releaseIdentityLease(held.lease, f.render().ownerToken);
  late.reject(Error('Old observer failure'));
  await flush();
  assert.equal(f.render().saveError, '');
  f.render().registerCommitObserver(() => {
    seen.push('third');
  });
  await f.render().save(add(f.render().ledger, 'entry-B'), 'B saved');
  assert.deepEqual(seen, ['first', 'second', 'third']);
});
