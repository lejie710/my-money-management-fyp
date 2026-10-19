const test = require('node:test'),
  assert = require('node:assert/strict');
const model = require('../src/core/model');
const { createEverydayCloudController } = require('../src/cloud/everydayController');
const { encodeDataFamily } = require('../src/accounts/identity');
const { sha256Hex } = require('../src/cloud/hash');
const { photoKey } = require('../src/core/transactionContext');
const { inspectImageHeader } = require('../src/attachments/imageHeader');
const fs = require('node:fs'),
  path = require('node:path');
const clock = { today: '2026-10-19', nowMs: Date.UTC(2026, 9, 19) };
const clone = (value) => JSON.parse(JSON.stringify(value));
const family = {
  scope: { kind: 'test', namespace: 'cloud-controller' },
  actor: { kind: 'firebase-hosted', projectId: 'demo-controller', uid: 'owner-a' },
};
const guest = { scope: family.scope, actor: { kind: 'local' } };
const empty = (id) =>
  model.createEmptyLedger({ name: 'Everyday wallet' }, { clock, newIncarnationId: () => id });
const expense = (value) =>
  model.saveTransaction(
    value,
    model.transactionFromDraft(
      {
        title: 'Coffee',
        amount: '12.50',
        date: clock.today,
        categoryId: 'expense-food',
        type: 'expense',
      },
      'coffee',
      value,
    ),
  );
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function fixture() {
  let selected = clone(family),
    owner = 'owner-a-wallet',
    ledger = empty('cloud'),
    source = expense(empty('local')),
    sourceFamily = clone(family),
    serial = 0;
  const bindingToken = {};
  const calls = {
      read: 0,
      refresh: 0,
      save: 0,
      stage: 0,
      close: 0,
      retry: 0,
      discard: 0,
      readPhoto: 0,
    },
    faults = {
      beforeRead: null,
      beforeSave: null,
      beforeStage: null,
      cleanupPending: false,
      retry: false,
    };
  const status = {
    status: 'online',
    busy: false,
    message: 'Cloud wallet is up to date.',
    revision: 1,
    readOnly: false,
    draft: null,
    photosPending: 0,
  };
  const store = {
    getSnapshot: () => status,
    subscribe: () => () => {},
    async refresh() {
      calls.refresh++;
      return clone(ledger);
    },
    async discardDraft(token) {
      calls.discard++;
      assert.equal(token, status.draft.token);
      status.draft = null;
    },
  };
  const bytes = new Uint8Array(
    fs.readFileSync(path.join(__dirname, 'fixtures/images/receipt-a.png')),
  );
  const files = {
    async read() {
      calls.readPhoto++;
      return bytes;
    },
    async stage(target, actualStore, incarnation, photos, read, current) {
      calls.stage++;
      assert.equal(actualStore, store);
      assert.equal(encodeDataFamily(target), encodeDataFamily(selected));
      if (faults.beforeStage) await faults.beforeStage();
      current();
      const refs = {};
      for (const item of photos) {
        assert.equal(sha256Hex(await read(item)), item.sha256);
        refs[item.sha256] = {
          id: 'photo-account-copy',
          ownerIncarnationId: incarnation,
          fileName: 'photo-account-copy.png',
          ...inspectImageHeader(bytes),
        };
      }
      return {
        refs,
        async close() {
          calls.close++;
          return { pending: faults.cleanupPending };
        },
      };
    },
  };
  const controller = createEverydayCloudController({
    getSetup: () => ({
      configured: true,
      signedIn: !!selected,
      family: selected,
      ownerToken: owner,
      sessionToken: owner,
    }),
    storeFor: () => store,
    getBinding: () =>
      selected
        ? {
            family: selected,
            ledger,
            ownerToken: owner,
            bindingToken,
            identityPending: false,
            allowed: true,
            async compareAndSave(token, expected, next) {
              calls.save++;
              if (faults.beforeSave) await faults.beforeSave();
              if (token !== owner || expected !== JSON.stringify(ledger)) return false;
              ledger = clone(next);
              return true;
            },
          }
        : null,
    async readLocal() {
      calls.read++;
      if (faults.beforeRead) await faults.beforeRead();
      return { family: sourceFamily, ledger: clone(source) };
    },
    async refreshAccount() {
      return { ok: true };
    },
    async retryOperation(_, token) {
      calls.retry++;
      assert.equal(token, status.draft.token);
      return !faults.retry;
    },
    files,
    newId: () => 'preview-' + ++serial,
  });
  controller.ownerChanged();
  return {
    controller,
    calls,
    faults,
    status,
    bytes,
    store,
    get ledger() {
      return ledger;
    },
    set ledger(value) {
      ledger = value;
    },
    get source() {
      return source;
    },
    set source(value) {
      source = value;
    },
    set sourceFamily(value) {
      sourceFamily = value;
    },
    set owner(value) {
      owner = value;
    },
    set family(value) {
      selected = value;
    },
  };
}
test('opening Cloud Wallet is read-only; explicit preview copies nothing until exact confirmation', async () => {
  const f = fixture(),
    original = clone(f.source);
  f.controller.getSnapshot();
  assert.equal(f.calls.read, 0);
  assert.equal(f.calls.save, 0);
  assert.equal(await f.controller.previewCopy('local-account'), true);
  const preview = f.controller.getSnapshot().preview;
  assert.equal(preview.transactions, 1);
  assert.equal(preview.balanceMinor, -1250);
  assert.equal(f.calls.save, 0);
  assert.equal(f.calls.refresh, 0);
  assert.equal(await f.controller.confirmCopy(preview.token), true);
  assert.deepEqual(f.ledger, original);
  assert.deepEqual(f.source, original);
  assert.equal(f.calls.save, 1);
  assert.equal(f.controller.getSnapshot().preview, null);
});
test('cancelled, stale-token, nonempty and changed-source copy confirmations never save', async () => {
  for (const mode of ['cancel', 'token', 'target', 'source']) {
    const f = fixture();
    await f.controller.previewCopy('local-account');
    let token = f.controller.getSnapshot().preview.token;
    if (mode === 'cancel') f.controller.cancelPreview();
    if (mode === 'token') token += '-wrong';
    if (mode === 'target') f.ledger = expense(f.ledger);
    if (mode === 'source')
      f.source = { ...f.source, wallet: { ...f.source.wallet, name: 'Changed' } };
    assert.equal(await f.controller.confirmCopy(token), false);
    assert.equal(f.calls.save, 0);
  }
  const f = fixture();
  f.ledger = expense(f.ledger);
  assert.equal(await f.controller.previewCopy('guest'), false);
  assert.equal(f.calls.read, 0);
});
test('server target changes between preview and confirmation preserve both wallets', async () => {
  const f = fixture();
  await f.controller.previewCopy('local-account');
  const token = f.controller.getSnapshot().preview.token;
  f.store.refresh = async () => expense(f.ledger);
  assert.equal(await f.controller.confirmCopy(token), false);
  assert.equal(f.calls.save, 0);
  assert.equal(f.ledger.transactions.length, 0);
  assert.equal(f.source.transactions.length, 1);
});
test('owner changes hide old preview synchronously and retire a late source read', async () => {
  const f = fixture();
  await f.controller.previewCopy('local-account');
  f.family = { ...family, actor: { ...family.actor, uid: 'owner-b' } };
  f.owner = 'owner-b-wallet';
  assert.equal(f.controller.getSnapshot().preview, null);
  assert.equal(f.controller.getSnapshot().error, '');
  const g = fixture(),
    gate = deferred();
  g.faults.beforeRead = () => gate.promise;
  const pending = g.controller.previewCopy('guest');
  g.family = null;
  g.owner = null;
  gate.resolve();
  assert.equal(await pending, false);
  assert.equal(g.controller.getSnapshot().preview, null);
  assert.equal(g.calls.save, 0);
});
test('single-flight controller rejects overlapping copy and refresh actions', async () => {
  const f = fixture(),
    gate = deferred();
  f.faults.beforeRead = () => gate.promise;
  const pending = f.controller.previewCopy('guest');
  assert.equal(await f.controller.previewCopy('local-account'), false);
  assert.equal(await f.controller.refresh(), false);
  assert.equal(f.calls.read, 1);
  gate.resolve();
  assert.equal(await pending, true);
});
test('guest photo copy stages into the target family only after confirmation and keeps source refs unchanged', async () => {
  const f = fixture();
  f.sourceFamily = guest;
  const photo = {
    id: 'photo-guest',
    ownerIncarnationId: f.source.wallet.incarnationId,
    fileName: 'photo-guest.png',
    ...inspectImageHeader(f.bytes),
  };
  f.source.transactions[0] = model.patchTransactionContext(
    f.source.transactions[0],
    { photo, notes: 'Fictional receipt' },
    f.source,
  );
  const original = clone(f.source);
  assert.equal(await f.controller.previewCopy('guest'), true);
  assert.equal(f.calls.stage, 0);
  assert.equal(f.calls.readPhoto, 0);
  assert.equal(await f.controller.confirmCopy(f.controller.getSnapshot().preview.token), true);
  assert.equal(f.calls.stage, 1);
  assert.equal(f.calls.close, 1);
  assert.notEqual(photoKey(f.ledger.transactions[0].context.photo), photoKey(photo));
  assert.deepEqual(f.source, original);
});
test('failed confirmed copy still closes staged photos and does not report a saved wallet', async () => {
  const f = fixture();
  f.sourceFamily = guest;
  const photo = {
    id: 'photo-guest',
    ownerIncarnationId: f.source.wallet.incarnationId,
    fileName: 'photo-guest.png',
    ...inspectImageHeader(f.bytes),
  };
  f.source.transactions[0] = model.patchTransactionContext(
    f.source.transactions[0],
    { photo },
    f.source,
  );
  await f.controller.previewCopy('guest');
  f.faults.beforeSave = async () => {
    throw Error('private storage details');
  };
  f.faults.cleanupPending = true;
  assert.equal(await f.controller.confirmCopy(f.controller.getSnapshot().preview.token), false);
  assert.equal(f.calls.close, 1);
  assert.equal(f.ledger.transactions.length, 0);
  assert.match(f.controller.getSnapshot().message, /cleanup/);
  assert.equal(f.controller.getSnapshot().error.includes('private storage'), false);
});
test('retry and discard require the live draft token and never discard submitted operations', async () => {
  const f = fixture();
  f.status.draft = {
    token: 'wallet-draft-one',
    phase: 'submitted',
    baseRevision: 1,
    transactions: 1,
    photos: 0,
  };
  assert.equal(f.controller.getSnapshot().canDiscardDraft, false);
  assert.equal(await f.controller.discardDraft('wallet-draft-one'), false);
  assert.equal(await f.controller.retryDraft('different'), false);
  assert.equal(f.calls.retry, 0);
  assert.equal(await f.controller.retryDraft('wallet-draft-one'), true);
  assert.equal(f.calls.retry, 1);
  f.status.draft = { ...f.status.draft, phase: 'conflict' };
  assert.equal(f.controller.getSnapshot().canRetryDraft, false);
  assert.equal(await f.controller.discardDraft('wrong'), false);
  assert.equal(f.calls.discard, 0);
  assert.equal(await f.controller.discardDraft('wallet-draft-one'), true);
  assert.equal(f.calls.discard, 1);
});

test('real financial lease A-to-B-to-A and same-family restoration retire delayed copy preparation', async () => {
  const {
    ledgerFixture,
    store: localStore,
    ledger: runtimeLedger,
  } = require('./helpers/account-hook-harness.cjs');
  for (const transition of ['a-b-a', 'same-family']) {
    const finance = ledgerFixture({ initial: runtimeLedger('Cloud', 'cloud') });
    await finance.open();
    const a = family,
      b = { ...family, actor: { ...family.actor, uid: 'owner-b' } },
      storeA = localStore(runtimeLedger('Cloud', 'cloud')),
      storeB = localStore(runtimeLedger('Cloud B', 'cloud-b'));
    async function adopt(next, targetStore) {
      const current = finance.render(),
        held = current.acquireIdentityLease();
      assert.equal(held.ok, true);
      const result = await current.adoptIdentityTarget(
        held.lease,
        finance.target(next, targetStore.data, targetStore),
        () => true,
      );
      assert.equal(result.ok, true);
      assert.equal(
        finance.render().releaseIdentityLease(held.lease, finance.render().ownerToken),
        true,
      );
    }
    await adopt(a, storeA);
    let selected = a,
      gate = null,
      saveCalls = 0;
    const cloud = {
      getSnapshot: () => ({
        status: 'online',
        busy: false,
        readOnly: false,
        revision: 1,
        draft: null,
        photosPending: 0,
        message: '',
      }),
      subscribe: () => () => {},
      async refresh() {
        return storeA.data;
      },
    };
    const controller = createEverydayCloudController({
      getSetup: () => ({
        configured: true,
        signedIn: true,
        family: selected,
        ownerToken: finance.render().ownerToken,
        sessionToken: 'stable-account-presentation',
      }),
      storeFor: () => cloud,
      getBinding() {
        const live = finance.render().getIdentityState();
        return {
          ...live,
          allowed: !live.identityPending && !live.writeInFlight && !live.uncertain,
          compareAndSave(...args) {
            saveCalls++;
            return finance.render().compareAndSave(...args);
          },
        };
      },
      async readLocal() {
        if (gate) await gate.promise;
        return { family: a, ledger: expense(empty('legacy')) };
      },
      files: {},
      newId: () => 'preview-real-runtime',
      refreshAccount: async () => ({ ok: true }),
      retryOperation: async () => false,
    });
    controller.ownerChanged();
    assert.equal(await controller.previewCopy('local-account'), true);
    const preview = controller.getSnapshot().preview.token;
    gate = deferred();
    const pending = controller.confirmCopy(preview);
    if (transition === 'a-b-a') {
      selected = b;
      await adopt(b, storeB);
      controller.ownerChanged();
      selected = a;
      await adopt(a, storeA);
      controller.ownerChanged();
    } else {
      await finance.render().restore();
      controller.ownerChanged();
    }
    gate.resolve();
    assert.equal(await pending, false);
    assert.equal(saveCalls, 0);
    assert.equal(finance.render().ledger.transactions.length, 0);
    assert.equal(controller.getSnapshot().preview, null);
    assert.equal(controller.getSnapshot().error, '');
  }
});

test('failed photo preparation preserves cleanup recovery and a cleanup error cannot undo a confirmed copy', async () => {
  const f = fixture();
  f.sourceFamily = guest;
  const photo = {
    id: 'photo-cleanup',
    ownerIncarnationId: f.source.wallet.incarnationId,
    fileName: 'photo-cleanup.png',
    ...inspectImageHeader(f.bytes),
  };
  f.source.transactions[0] = model.patchTransactionContext(
    f.source.transactions[0],
    { photo },
    f.source,
  );
  f.faults.beforeStage = async () => {
    throw Object.assign(Error('synthetic stage failure'), { cleanupPending: true });
  };
  await f.controller.previewCopy('guest');
  assert.equal(await f.controller.confirmCopy(f.controller.getSnapshot().preview.token), false);
  assert.equal(f.controller.getSnapshot().cleanupPending, true);
  assert.equal(f.calls.save, 0);
  const g = fixture();
  g.sourceFamily = guest;
  g.source.transactions[0] = model.patchTransactionContext(
    g.source.transactions[0],
    { photo: { ...photo, ownerIncarnationId: g.source.wallet.incarnationId } },
    g.source,
  );
  g.faults.cleanupPending = true;
  await g.controller.previewCopy('guest');
  assert.equal(await g.controller.confirmCopy(g.controller.getSnapshot().preview.token), true);
  assert.equal(g.controller.getSnapshot().cleanupPending, true);
  assert.equal(g.ledger.transactions.length, 1);
});
