const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const { hostWithStores, loadSource, ledger, model } = require('./helpers/account-hook-harness.cjs');
const { deferred } = require('./helpers/native-adapter-vm.cjs');
const drafts = require('../src/drafts/transactionDrafts');
const details = require('../src/core/transactionContext');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const family = {
  scope: { kind: 'test', namespace: 'entry-drafts' },
  actor: { kind: 'firebase-hosted', projectId: 'demo-drafts', uid: 'A' },
};
function memory() {
  const data = new Map();
  return {
    data,
    async getItem(k) {
      return data.get(k) ?? null;
    },
    async setItem(k, v) {
      data.set(k, v);
    },
  };
}
function store(
  storage = memory(),
  scope = family,
  incarnationId = 'wallet-A',
  transactionId = null,
) {
  return drafts.createTransactionDraftStore(storage, {
    family: scope,
    incarnationId,
    transactionId,
  });
}
function record(data = ledger('A', 'wallet-A'), overrides = {}) {
  return {
    baseFingerprint: drafts.ledgerFingerprint(data),
    transactionId: 'entry-resumed',
    fields: {
      type: 'expense',
      title: 'Lunch',
      categoryId: 'expense-food',
      amount: '12.',
      date: '2026-10-19',
    },
    details: {
      notes: 'Line one\nLine two',
      person: { name: 'Friend', source: 'manual' },
      place: { label: 'Cafe', source: 'manual' },
    },
    photoIntent: 'keep',
    ...overrides,
  };
}

test('draft storage retains incomplete entry text and isolates account, project, wallet and edit target', async () => {
  const storage = memory(),
    a = store(storage);
  await a.save(record(), 0);
  assert.equal((await store(storage).load()).record.fields.amount, '12.');
  const variants = [
    store(storage, { ...family, actor: { ...family.actor, uid: 'B' } }),
    store(storage, { ...family, actor: { ...family.actor, projectId: 'demo-other' } }),
    store(storage, family, 'wallet-B'),
    store(storage, family, 'wallet-A', 'existing-entry'),
  ];
  for (const other of variants) assert.equal((await other.load()).record, null);
});

test('draft schema rejects picker URIs, unapproved extra fields, and a record for another edit target', async () => {
  const a = store();
  assert.throws(() => a.save({ ...record(), uri: 'content://picker/private' }, 0));
  assert.throws(() =>
    a.save({ ...record(), details: { ...record().details, photo: 'file://temporary' } }, 0),
  );
  assert.throws(() => store(memory(), family, 'wallet-A', 'one').save(record(), 0));
  assert.equal((await a.load()).record, null);
});

test('discarded generations cannot be recreated by a stale save or erased by late cleanup', async () => {
  const storage = memory(),
    a = store(storage),
    b = store(storage);
  const first = await a.save(record(), 0);
  await a.discard(first.revision);
  await assert.rejects(b.save(record(), 0), /changed/);
  const empty = await b.load(),
    newer = await b.save(
      record(undefined, { fields: { ...record().fields, title: 'Newer draft' } }),
      empty.revision,
    );
  await assert.rejects(a.discard(first.revision), /changed/);
  assert.equal((await b.load()).record.fields.title, 'Newer draft');
  assert.equal((await b.load()).revision, newer.revision);
});

test('draft snapshots are captured before queuing and returned data cannot mutate saved bytes', async () => {
  const a = store(),
    value = record(),
    saving = a.save(value, 0);
  value.fields.title = 'Mutated later';
  const saved = await saving;
  assert.equal(saved.record.fields.title, 'Lunch');
  saved.record.fields.title = 'Mutated returned copy';
  assert.equal((await a.load()).record.fields.title, 'Lunch');
});

test('malformed saved draft bytes are retained and block replacement', async () => {
  const storage = memory(),
    a = store(storage);
  storage.data.set(a.key, '{broken');
  await assert.rejects(a.load());
  await assert.rejects(a.save(record(), 0));
  assert.equal(storage.data.get(a.key), '{broken');
});

test('typing writer retains the newest fields through write failure and explicit retry', async () => {
  const storage = memory(),
    a = store(storage),
    writer = drafts.createDraftWriter(a, await a.load());
  storage.data.set('finance', 'unchanged');
  const write = storage.setItem;
  storage.setItem = async () => {
    throw Error('storage unavailable');
  };
  writer.enqueue(record());
  assert.equal(await writer.flush(), false);
  assert.match(writer.getSnapshot().error, /not been confirmed/);
  writer.enqueue(record(undefined, { fields: { ...record().fields, title: 'Latest text' } }));
  storage.setItem = write;
  assert.equal(await writer.flush(), true);
  assert.equal((await a.load()).record.fields.title, 'Latest text');
  assert.equal(storage.data.get('finance'), 'unchanged');
});

test('writer readback recovers a completed write without losing its generation', async () => {
  const storage = memory(),
    a = store(storage),
    writer = drafts.createDraftWriter(a, await a.load());
  const write = storage.setItem;
  storage.setItem = async (k, v) => {
    await write(k, v);
    throw Error('late failure');
  };
  writer.enqueue(record());
  assert.equal(await writer.flush(), true);
  assert.equal(writer.getSnapshot().revision, 1);
  assert.equal((await a.load()).record.fields.title, 'Lunch');
});

test('coalesced typing and cleanup cannot erase another editor newer saved draft', async () => {
  const storage = memory(),
    a = store(storage),
    pending = deferred();
  let calls = 0;
  const write = storage.setItem;
  storage.setItem = async (k, v) => {
    if (++calls === 1) await pending.promise;
    await write(k, v);
  };
  const writer = drafts.createDraftWriter(a, await a.load());
  writer.enqueue(record());
  await tick();
  writer.enqueue(record(undefined, { fields: { ...record().fields, title: 'Second' } }));
  writer.enqueue(record(undefined, { fields: { ...record().fields, title: 'Newest' } }));
  pending.resolve();
  assert.equal(await writer.flush(), true);
  assert.equal((await a.load()).record.fields.title, 'Newest');
  const before = await a.load();
  await store(storage).save(
    record(undefined, { fields: { ...record().fields, title: 'Other editor' } }),
    before.revision,
  );
  assert.equal(await writer.discard(), false);
  assert.equal((await a.load()).record.fields.title, 'Other editor');
});

const nodes = (v) =>
  !v || typeof v !== 'object'
    ? []
    : Array.isArray(v)
      ? v.flatMap(nodes)
      : [v, ...nodes(v.props?.children)];
const find = (tree, id) => nodes(tree).find((n) => n.props?.testID === id);
const components = {
  Action: 'Action',
  Choice: 'Choice',
  Field: 'Field',
  FormError: 'FormError',
  Sheet: 'Sheet',
};
const native = { Text: 'Text', View: 'View' };
function gateFixture(props) {
  const host = hostWithStores();
  let current = props,
    open = [];
  const gate = loadSource(path.join(__dirname, '../src/drafts/TransactionDraftGate.tsx'), {
    react: host.react,
    'react-native': native,
    '../ui/components': components,
    '../ui/theme': require('./helpers/theme-stub.cjs').themeStub,
    './transactionDrafts': drafts,
  });
  return {
    host,
    open,
    render(next = {}) {
      current = { ...current, ...next };
      return host.render(() =>
        gate.TransactionDraftGate({
          ...current,
          children: (snapshot) => {
            open.push(snapshot);
            return 'EDITOR';
          },
        }),
      );
    },
  };
}
test('cold reopen offers Resume or Discard and never opens or submits a saved draft automatically', async () => {
  const a = store(),
    data = ledger('A', 'wallet-A');
  await a.save(record(data), 0);
  const g = gateFixture({ store: a, ledger: data, onClose() {} });
  g.render();
  await tick();
  let tree = g.render();
  assert.equal(g.open.length, 0);
  assert.ok(find(tree, 'transaction-saved-draft-preview'));
  assert.equal(find(tree, 'transaction-draft-resume').props.disabled, false);
  find(tree, 'transaction-draft-resume').props.onPress();
  g.render();
  assert.equal(g.open.at(-1).record.transactionId, 'entry-resumed');
  assert.equal((await a.load()).record.fields.title, 'Lunch');
  g.host.unmount();
});

test('a changed financial base blocks Resume while explicit Discard clears only that exact draft', async () => {
  const storage = memory(),
    a = store(storage),
    data = ledger('A', 'wallet-A');
  storage.data.set('finance', 'newer cloud data');
  await a.save(record(data), 0);
  const changed = model.saveTransaction(
    data,
    model.transactionFromDraft(
      {
        title: 'Other expense',
        type: 'expense',
        amount: '1',
        date: '2026-10-19',
        categoryId: 'expense-food',
      },
      'other',
      data,
    ),
  );
  const g = gateFixture({ store: a, ledger: changed, onClose() {} });
  g.render();
  await tick();
  let tree = g.render();
  assert.ok(find(tree, 'transaction-draft-stale'));
  assert.equal(find(tree, 'transaction-draft-resume').props.disabled, true);
  find(tree, 'transaction-draft-resume').props.onPress();
  g.render();
  assert.equal(g.open.length, 0);
  find(tree, 'transaction-draft-discard').props.onPress();
  await tick();
  g.render();
  assert.equal(g.open.at(-1).record, null);
  assert.equal(storage.data.get('finance'), 'newer cloud data');
  g.host.unmount();
});

function editorFixture({
  data = ledger('A', 'wallet-A'),
  draftStore = store(),
  initialDraft = { revision: 0, record: null },
  transaction,
  context,
  saveResult = true,
} = {}) {
  const host = hostWithStores();
  const calls = { finance: [], closed: 0 };
  let active = true;
  const contextHook = loadSource(path.join(__dirname, '../src/ui/useTransactionContext.ts'), {
    react: host.react,
    '../core/transactionContext': details,
  });
  const persistentHook = loadSource(path.join(__dirname, '../src/drafts/useTransactionDraft.ts'), {
    react: host.react,
    './transactionDrafts': drafts,
  });
  const editor = loadSource(path.join(__dirname, '../src/ui/TransactionEditor.tsx'), {
    react: host.react,
    'react-native': native,
    '../core/model': model,
    './components': components,
    './theme': require('./helpers/theme-stub.cjs').themeStub,
    './TransactionContextFields': { TransactionContextFields: 'TransactionContextFields' },
    './useTransactionContext': contextHook,
    '../drafts/TransactionDraftGate': { TransactionDraftGate: 'TransactionDraftGate' },
    '../drafts/useTransactionDraft': persistentHook,
    '../drafts/transactionDrafts': drafts,
    '../core/transactionContext': details,
  });
  let props = {
    ledger: data,
    transaction,
    draftStore,
    context,
    saving: false,
    saveError: '',
    clearSaveError() {},
    isCurrent: () => active,
    onClose() {
      calls.closed++;
    },
    async onSave(next) {
      calls.finance.push(next);
      return typeof saveResult === 'function' ? saveResult(next) : saveResult;
    },
  };
  return {
    host,
    calls,
    draftStore,
    get props() {
      return props;
    },
    revoke() {
      active = false;
    },
    render(next = {}) {
      props = { ...props, ...next };
      return host.render(() => {
        const outer = editor.TransactionEditor(props),
          form = outer.props.children[0](initialDraft);
        return form.type(form.props);
      });
    },
  };
}

test('typing saves fields and optional text without financial writes; close preserves the draft for a new process', async () => {
  const f = editorFixture();
  let tree = f.render();
  find(tree, 'transaction-title-input').props.onChangeText('An unfinished lunch');
  tree = f.render();
  find(tree, 'transaction-amount-input').props.onChangeText('12.');
  tree = f.render();
  const context = nodes(tree).find((n) => n.type === 'TransactionContextFields').props.draft;
  context.setNotes('Keep this note');
  context.setPersonName('Friend');
  context.setPlaceLabel('Cafe');
  f.render();
  await tick();
  assert.equal(f.calls.finance.length, 0);
  assert.equal((await f.draftStore.load()).record.fields.title, 'An unfinished lunch');
  f.render().props.onClose();
  await tick();
  assert.equal(f.calls.closed, 1);
  const saved = await f.draftStore.load();
  assert.equal(saved.record.fields.amount, '12.');
  assert.equal(saved.record.details.notes, 'Keep this note');
  f.host.unmount();
  const reopened = editorFixture({
    draftStore: f.draftStore,
    initialDraft: saved,
    data: f.props.ledger,
  });
  tree = reopened.render();
  assert.equal(find(tree, 'transaction-title-input').props.value, 'An unfinished lunch');
  assert.equal(
    nodes(tree).find((n) => n.type === 'TransactionContextFields').props.draft.person.name,
    'Friend',
  );
  assert.equal(reopened.calls.finance.length, 0);
  reopened.host.unmount();
});

test('only confirmed finance save clears the exact saved generation and retains the resumed transaction ID', async () => {
  const a = store(),
    data = ledger('A', 'wallet-A');
  const initial = await a.save(
    record(data, { fields: { ...record().fields, amount: '12.50' } }),
    0,
  );
  const f = editorFixture({ data, draftStore: a, initialDraft: initial });
  find(f.render(), 'save-transaction').props.onPress();
  await tick();
  assert.equal(f.calls.finance.length, 1);
  assert.equal(f.calls.finance[0].transactions[0].id, 'entry-resumed');
  assert.equal(f.calls.closed, 1);
  assert.equal((await a.load()).record, null);
  assert.ok((await a.load()).revision > initial.revision);
  f.host.unmount();
});

test('failed finance save leaves the current draft available and does not close the editor', async () => {
  const a = store(),
    data = ledger('A', 'wallet-A'),
    initial = await a.save(record(data, { fields: { ...record().fields, amount: '12.50' } }), 0);
  const f = editorFixture({ data, draftStore: a, initialDraft: initial, saveResult: false });
  find(f.render(), 'save-transaction').props.onPress();
  await tick();
  assert.equal(f.calls.finance.length, 1);
  assert.equal(f.calls.closed, 0);
  assert.equal((await a.load()).record.transactionId, 'entry-resumed');
  f.host.unmount();
});

test('same-owner financial changes after opening the form block stale submit and preserve its draft', async () => {
  const a = store(),
    data = ledger('A', 'wallet-A'),
    initial = await a.save(record(data, { fields: { ...record().fields, amount: '12.50' } }), 0);
  const f = editorFixture({ data, draftStore: a, initialDraft: initial });
  f.render();
  const changed = model.saveTransaction(
    data,
    model.transactionFromDraft(
      {
        title: 'Other',
        type: 'expense',
        date: '2026-10-19',
        amount: '1',
        categoryId: 'expense-food',
      },
      'other',
      data,
    ),
  );
  find(f.render({ ledger: changed }), 'save-transaction').props.onPress();
  await tick();
  assert.equal(f.calls.finance.length, 0);
  assert.match(find(f.render(), 'transaction-error').props.message, /wallet changed/);
  assert.equal((await a.load()).record.transactionId, 'entry-resumed');
  f.host.unmount();
});

test('Strict Mode effect replay keeps autosaving usable and retired owner callbacks do not submit', async () => {
  const f = editorFixture();
  f.render();
  f.host.replayEffects();
  find(f.render(), 'transaction-title-input').props.onChangeText('After replay');
  f.render();
  await tick();
  assert.equal((await f.draftStore.load()).record.fields.title, 'After replay');
  const old = f.render();
  f.revoke();
  find(old, 'save-transaction').props.onPress();
  await tick();
  assert.equal(f.calls.finance.length, 0);
  f.host.unmount();
});

const photo = {
  id: 'photo-kept',
  ownerIncarnationId: 'wallet-A',
  fileName: 'photo-kept.png',
  mimeType: 'image/png',
  width: 20,
  height: 20,
  byteSize: 100,
};
const photoResult = { deleted: 0, retained: 0, pending: false, message: '' };
function photoContext(stage = async () => photo) {
  const calls = { stage: 0, close: 0, cleanup: [] };
  return {
    calls,
    binding: {
      sessionKey: 'full-account/wallet-A/editor-one',
      services: {
        pickPhoto: async () => ({ uri: 'content://ephemeral/private-image' }),
        pickContactName: async () => null,
        currentPlace: async () => {
          throw Error('unused');
        },
        placeAt: async () => {
          throw Error('unused');
        },
      },
      photos: {
        beginDraft: () => ({ id: 'staged-draft', ownerIncarnationId: 'wallet-A' }),
        stage: async (...args) => {
          calls.stage++;
          return stage(...args);
        },
        closeDraft: async () => {
          calls.close++;
          return photoResult;
        },
        queueCleanup: async (refs) => {
          calls.cleanup.push(...refs);
          return photoResult;
        },
        familyToken: 'family',
        journalKey: 'journal',
      },
    },
  };
}

test('a selected photo is represented only as repick intent and recovery never attaches its old temporary URI', async () => {
  const a = store(),
    data = ledger('A', 'wallet-A'),
    initial = await a.save(record(data, { fields: { ...record().fields, amount: '12.50' } }), 0),
    photos = photoContext();
  const f = editorFixture({ data, draftStore: a, initialDraft: initial, context: photos.binding });
  let tree = f.render();
  await nodes(tree)
    .find((n) => n.type === 'TransactionContextFields')
    .props.draft.pickPhoto();
  f.render();
  await tick();
  const saved = await a.load();
  assert.equal(saved.record.photoIntent, 'repick');
  assert.equal(JSON.stringify(saved).includes('content://'), false);
  assert.equal(photos.calls.stage, 0);
  f.host.unmount();
  const reopened = editorFixture({
    data,
    draftStore: a,
    initialDraft: saved,
    context: photos.binding,
  });
  tree = reopened.render();
  assert.ok(find(tree, 'transaction-draft-photo-repick'));
  const recovered = nodes(tree).find((n) => n.type === 'TransactionContextFields').props.draft;
  assert.equal(recovered.photoEdit.kind, 'keep');
  assert.equal(recovered.originalPhoto, null);
  assert.equal(photos.calls.stage, 0);
  reopened.host.unmount();
});

test('resuming photo removal preserves that intent through further typing and queues only the old managed photo after confirmed save', async () => {
  let data = ledger('A', 'wallet-A');
  let tx = model.transactionFromDraft(
    {
      title: 'Lunch',
      type: 'expense',
      date: '2026-10-19',
      amount: '12.50',
      categoryId: 'expense-food',
    },
    'existing-entry',
    data,
  );
  tx = model.patchTransactionContext(tx, { photo }, data);
  data = model.saveTransaction(data, tx);
  const a = store(memory(), family, 'wallet-A', tx.id),
    initial = await a.save(
      record(data, {
        transactionId: tx.id,
        fields: { ...record().fields, amount: '12.50' },
        photoIntent: 'remove',
      }),
      0,
    ),
    photos = photoContext();
  const f = editorFixture({
    data,
    draftStore: a,
    initialDraft: initial,
    transaction: tx,
    context: photos.binding,
  });
  let tree = f.render(),
    context = nodes(tree).find((n) => n.type === 'TransactionContextFields').props.draft;
  assert.equal(context.photoEdit.kind, 'remove');
  assert.equal(context.originalPhoto.id, photo.id);
  find(tree, 'transaction-title-input').props.onChangeText('Updated lunch');
  f.render();
  await tick();
  assert.equal((await a.load()).record.photoIntent, 'remove');
  find(f.render(), 'save-transaction').props.onPress();
  await tick();
  assert.equal(f.calls.finance.length, 1);
  assert.equal(f.calls.finance[0].transactions[0].context.photo, null);
  assert.deepEqual(
    photos.calls.cleanup.map((x) => x.id),
    [photo.id],
  );
  assert.equal((await a.load()).record, null);
  f.host.unmount();
});

test('financial changes arriving during photo preparation block stale submit and retain the text draft', async () => {
  const pending = deferred(),
    photos = photoContext(() => pending.promise),
    a = store(),
    data = ledger('A', 'wallet-A'),
    initial = await a.save(record(data, { fields: { ...record().fields, amount: '12.50' } }), 0);
  const f = editorFixture({ data, draftStore: a, initialDraft: initial, context: photos.binding });
  await nodes(f.render())
    .find((n) => n.type === 'TransactionContextFields')
    .props.draft.pickPhoto();
  f.render();
  await tick();
  find(f.render(), 'save-transaction').props.onPress();
  await tick();
  assert.equal(photos.calls.stage, 1);
  const changed = model.saveTransaction(
    data,
    model.transactionFromDraft(
      {
        title: 'New cloud record',
        type: 'expense',
        date: '2026-10-20',
        amount: '2',
        categoryId: 'expense-food',
      },
      'new-cloud',
      data,
    ),
  );
  f.render({ ledger: changed });
  pending.resolve(photo);
  await tick();
  assert.equal(f.calls.finance.length, 0);
  assert.equal(f.calls.closed, 0);
  assert.match(
    find(f.render(), 'transaction-error').props.message,
    /wallet changed while the photo/,
  );
  assert.equal((await a.load()).record.photoIntent, 'repick');
  f.host.unmount();
});

test('late confirmed-save cleanup cannot erase a newer draft generation from another editor', async () => {
  const pending = deferred(),
    a = store(),
    data = ledger('A', 'wallet-A'),
    initial = await a.save(record(data, { fields: { ...record().fields, amount: '12.50' } }), 0);
  const f = editorFixture({
    data,
    draftStore: a,
    initialDraft: initial,
    saveResult: () => pending.promise,
  });
  find(f.render(), 'save-transaction').props.onPress();
  await tick();
  assert.equal(f.calls.finance.length, 1);
  const before = await a.load();
  await a.save(
    record(data, { fields: { ...record().fields, title: 'Newer editor work' } }),
    before.revision,
  );
  pending.resolve(true);
  await tick();
  assert.equal((await a.load()).record.fields.title, 'Newer editor work');
  f.host.unmount();
});

test('closing on an unconfirmed draft write keeps the form open with its typed input for retry', async () => {
  const storage = memory(),
    a = store(storage),
    f = editorFixture({ draftStore: a });
  storage.setItem = async () => {
    throw Error('storage unavailable');
  };
  find(f.render(), 'transaction-title-input').props.onChangeText('Keep visible');
  f.render();
  await tick();
  f.render().props.onClose();
  await tick();
  assert.equal(f.calls.closed, 0);
  assert.equal(find(f.render(), 'transaction-title-input').props.value, 'Keep visible');
  assert.match(
    find(f.render(), 'transaction-draft-save-error').props.message,
    /not been confirmed/,
  );
  f.host.unmount();
});

for (const cloudAccount of [false, true]) {
  test(`${cloudAccount ? 'cloud' : 'guest'} editor discloses its storage destination without committing typed details or a selected photo`, async () => {
    const photos = photoContext(),
      f = editorFixture({ context: photos.binding });
    const text = (value) =>
      value == null
        ? ''
        : Array.isArray(value)
          ? value.map(text).join('')
          : typeof value === 'object'
            ? text(value.props?.children)
            : String(value);
    let tree = f.render({ cloudAccount }),
      all = nodes(tree);
    const notice = find(tree, 'transaction-cloud-disclosure');
    if (cloudAccount) {
      assert.ok(notice);
      assert.match(text(notice), /When you save.*Firebase account/s);
      assert.match(text(notice), /Unsaved drafts stay on this device/);
      assert.ok(all.indexOf(notice) < all.indexOf(find(tree, 'save-transaction')));
      assert.doesNotMatch(text(tree), /Saved only on this device/);
    } else {
      assert.equal(notice, undefined);
      assert.match(text(tree), /Saved only on this device/);
      assert.doesNotMatch(text(tree), /stored in your Firebase account/);
    }
    assert.equal(f.calls.finance.length, 0);
    assert.equal(photos.calls.stage, 0);
    find(tree, 'transaction-title-input').props.onChangeText('Reviewed lunch');
    tree = f.render();
    find(tree, 'transaction-amount-input').props.onChangeText('12.50');
    tree = f.render();
    find(tree, 'transaction-date-input').props.onChangeText('2026-10-19');
    tree = f.render();
    const details = nodes(tree).find((node) => node.type === 'TransactionContextFields').props
      .draft;
    details.setNotes('Optional note');
    await details.pickPhoto();
    tree = f.render();
    await tick();
    assert.equal(f.calls.finance.length, 0);
    assert.equal(photos.calls.stage, 0);
    assert.equal(f.props.ledger.transactions.length, 0);
    assert.equal((await f.draftStore.load()).record.photoIntent, 'repick');
    find(tree, 'save-transaction').props.onPress();
    await tick();
    assert.equal(photos.calls.stage, 1);
    assert.equal(f.calls.finance.length, 1);
    assert.equal(f.calls.finance[0].transactions[0].amountMinor, 1250);
    assert.equal(f.calls.finance[0].transactions[0].context.notes, 'Optional note');
    assert.equal(f.calls.finance[0].transactions[0].context.photo.id, photo.id);
    f.host.unmount();
  });
}
