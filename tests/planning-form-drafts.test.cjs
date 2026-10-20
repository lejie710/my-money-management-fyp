const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const { hostWithStores, loadSource, ledger, model } = require('./helpers/account-hook-harness.cjs');
const { deferred } = require('./helpers/native-adapter-vm.cjs');
const forms = require('../src/drafts/formDrafts'),
  transactions = require('../src/drafts/transactionDrafts');
const family = {
  scope: { kind: 'test', namespace: 'plan-drafts' },
  actor: { kind: 'firebase-hosted', projectId: 'demo-plan', uid: 'A' },
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
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
function store(kind, storage = memory(), overrides = {}) {
  return forms.createFinancialFormDraftStore(storage, {
    family,
    incarnationId: 'wallet-A',
    kind,
    ...overrides,
  });
}
function record(kind, data = ledger('A', 'wallet-A')) {
  return {
    kind,
    entityId: kind + '-retained',
    baseFingerprint: transactions.ledgerFingerprint(data),
    fields:
      kind === 'budget'
        ? { categoryId: 'expense-food', amount: '150.', period: 'month', anchorDate: '2026-10-' }
        : { kind: 'emergencyFund', amount: '3000.' },
  };
}
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
  Screen: 'Screen',
};
const native = {
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (v) => v },
  useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }),
};
const theme = require('./helpers/theme-stub.cjs').themeStub;

for (const kind of ['budget', 'goal']) {
  test(
    kind + ' drafts preserve incomplete fields and isolate kind, account, wallet and target',
    async () => {
      const storage = memory(),
        a = store(kind, storage),
        saved = await a.save(record(kind), 0);
      assert.equal(
        (await store(kind, storage).load()).record.fields.amount,
        record(kind).fields.amount,
      );
      for (const other of [
        store(kind === 'budget' ? 'goal' : 'budget', storage),
        store(kind, storage, { family: { ...family, actor: { ...family.actor, uid: 'B' } } }),
        store(kind, storage, { incarnationId: 'wallet-B' }),
        store(kind, storage, { targetId: 'existing-other' }),
      ])
        assert.equal((await other.load()).record, null);
      assert.equal(saved.revision, 1);
    },
  );
  test(
    kind +
      ' draft tombstones and CAS prevent stale resurrection and late deletion of newer changes',
    async () => {
      const a = store(kind);
      const old = await a.save(record(kind), 0);
      await a.discard(old.revision);
      await assert.rejects(a.save(record(kind), 0), /changed/);
      const empty = await a.load(),
        later = { ...record(kind), fields: { ...record(kind).fields, amount: '999.' } };
      await a.save(later, empty.revision);
      await assert.rejects(a.discard(old.revision), /changed/);
      assert.equal((await a.load()).record.fields.amount, '999.');
    },
  );
  test(
    kind +
      ' writer keeps latest text through write failure and recovers after retry without financial mutations',
    async () => {
      const storage = memory(),
        a = store(kind, storage),
        writer = forms.createFormDraftWriter(a, await a.load()),
        write = storage.setItem;
      storage.data.set('financial-records', 'untouched');
      storage.setItem = async () => {
        throw Error('unavailable');
      };
      writer.enqueue(record(kind));
      assert.equal(await writer.flush(), false);
      writer.enqueue({ ...record(kind), fields: { ...record(kind).fields, amount: '200.' } });
      storage.setItem = write;
      assert.equal(await writer.flush(), true);
      assert.equal((await a.load()).record.fields.amount, '200.');
      assert.equal(storage.data.get('financial-records'), 'untouched');
    },
  );
}

test('malformed, cross-kind and cross-target draft records are rejected without replacing saved bytes', async () => {
  const storage = memory(),
    a = store('budget', storage);
  storage.data.set(a.key, '{broken');
  await assert.rejects(a.load());
  await assert.rejects(a.save(record('budget'), 0));
  assert.equal(storage.data.get(a.key), '{broken');
  assert.throws(() => store('budget').save(record('goal'), 0));
  assert.throws(() => store('goal', memory(), { targetId: 'one' }).save(record('goal'), 0));
  assert.throws(() =>
    store('goal').save({ ...record('goal'), fields: { kind: 'not-a-goal', amount: '1' } }, 0),
  );
});

test('financial-form writer confirms a completed write after a transport-style late error', async () => {
  const storage = memory(),
    a = store('budget', storage),
    writer = forms.createFormDraftWriter(a, await a.load());
  const write = storage.setItem;
  storage.setItem = async (k, v) => {
    await write(k, v);
    throw Error('late');
  };
  writer.enqueue(record('budget'));
  assert.equal(await writer.flush(), true);
  assert.equal(writer.getSnapshot().revision, 1);
});

function gateFixture(kind, props) {
  const host = hostWithStores();
  let options = props;
  const opened = [];
  const gate = loadSource(path.join(__dirname, '../src/drafts/FinancialFormDraftGate.tsx'), {
    react: host.react,
    'react-native': native,
    '../core/model': model,
    '../ui/components': components,
    '../ui/theme': theme,
    './transactionDrafts': transactions,
  });
  return {
    host,
    opened,
    render(next = {}) {
      options = { ...options, ...next };
      return host.render(() =>
        gate.FinancialFormDraftGate({
          kind,
          ...options,
          children: (snapshot) => {
            opened.push(snapshot);
            return 'FORM';
          },
        }),
      );
    },
  };
}
for (const kind of ['budget', 'goal'])
  test(
    kind + ' recovery requires explicit Resume and refuses a changed wallet before opening',
    async () => {
      const data = ledger('A', 'wallet-A'),
        a = store(kind);
      await a.save(record(kind, data), 0);
      const g = gateFixture(kind, { store: a, ledger: data, onClose() {} });
      g.render();
      await tick();
      let tree = g.render();
      assert.equal(g.opened.length, 0);
      assert.ok(find(tree, kind + '-saved-draft-preview'));
      const changed = model.saveTransaction(
        data,
        model.transactionFromDraft(
          {
            title: 'New cloud entry',
            type: 'expense',
            amount: '1',
            date: '2026-10-19',
            categoryId: 'expense-food',
          },
          'changed',
          data,
        ),
      );
      tree = g.render({ ledger: changed });
      assert.equal(find(tree, kind + '-draft-resume').props.disabled, true);
      find(tree, kind + '-draft-resume').props.onPress();
      g.render();
      assert.equal(g.opened.length, 0);
      find(tree, kind + '-draft-discard').props.onPress();
      await tick();
      g.render();
      assert.equal(g.opened.at(-1).record, null);
      g.host.unmount();
    },
  );

function editorFixture(
  kind,
  {
    data = ledger('A', 'wallet-A'),
    draftStore = store(kind),
    initialDraft = { revision: 0, record: null },
    budget,
    saveResult = true,
  } = {},
) {
  const host = hostWithStores();
  let active = true;
  const calls = { finance: [], closed: 0 };
  const hook = loadSource(path.join(__dirname, '../src/drafts/useFormDraft.ts'), {
    react: host.react,
    './formDrafts': forms,
  });
  const name = kind === 'budget' ? 'BudgetEditor' : 'GoalEditor';
  const module = loadSource(path.join(__dirname, '../src/ui/' + name + '.tsx'), {
    react: host.react,
    'react-native': native,
    '../core/model': model,
    './components': components,
    './TransactionEditor': { newId: (prefix) => prefix + '-generated' },
    './TransactionsScreen': { displayDate: (value) => value },
    './theme': theme,
    '../drafts/FinancialFormDraftGate': { FinancialFormDraftGate: 'FinancialFormDraftGate' },
    '../drafts/useFormDraft': hook,
    '../drafts/transactionDrafts': transactions,
  });
  let props = {
    ledger: data,
    budget,
    draftStore,
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
        const outer = module[name](props),
          form = outer.props.children[0](initialDraft);
        return form.type(form.props);
      });
    },
  };
}

for (const kind of ['budget', 'goal']) {
  test(
    kind + ' text survives close and a new form instance without an automatic finance save',
    async () => {
      const f = editorFixture(kind);
      let tree = f.render();
      find(tree, kind + '-amount-input').props.onChangeText('250.');
      tree = f.render();
      if (kind === 'budget') find(tree, 'budget-date-input').props.onChangeText('2026-10-');
      else find(tree, 'goal-kind-education').props.onPress();
      f.render();
      await tick();
      f.render().props.onClose();
      await tick();
      assert.equal(f.calls.closed, 1);
      assert.equal(f.calls.finance.length, 0);
      const saved = await f.draftStore.load();
      f.host.unmount();
      assert.equal(saved.record.fields.amount, '250.');
      const restored = editorFixture(kind, {
        data: f.props.ledger,
        draftStore: f.draftStore,
        initialDraft: saved,
      });
      tree = restored.render();
      assert.equal(find(tree, kind + '-amount-input').props.value, '250.');
      if (kind === 'budget') assert.equal(find(tree, 'budget-date-input').props.value, '2026-10-');
      else assert.equal(find(tree, 'goal-kind-education').props.selected, true);
      assert.equal(restored.calls.finance.length, 0);
      restored.host.unmount();
    },
  );
  test(
    kind + ' confirmed save retains its generated identity and clears the exact draft generation',
    async () => {
      const data = ledger('A', 'wallet-A'),
        a = store(kind),
        value = record(kind, data);
      value.fields.amount = '250';
      if (kind === 'budget') value.fields.anchorDate = '2026-10-19';
      const initial = await a.save(value, 0),
        f = editorFixture(kind, { data, draftStore: a, initialDraft: initial });
      find(f.render(), 'save-' + kind).props.onPress();
      await tick();
      assert.equal(f.calls.finance.length, 1);
      assert.equal(
        kind === 'budget' ? f.calls.finance[0].budgets[0].id : f.calls.finance[0].goal.id,
        value.entityId,
      );
      assert.equal((await a.load()).record, null);
      assert.equal(f.calls.closed, 1);
      f.host.unmount();
    },
  );
  test(
    kind + ' failed finance save and stale same-owner base retain the draft without a second write',
    async () => {
      const data = ledger('A', 'wallet-A'),
        a = store(kind),
        value = record(kind, data);
      value.fields.amount = '250';
      if (kind === 'budget') value.fields.anchorDate = '2026-10-19';
      const initial = await a.save(value, 0),
        f = editorFixture(kind, { data, draftStore: a, initialDraft: initial, saveResult: false });
      find(f.render(), 'save-' + kind).props.onPress();
      await tick();
      assert.equal(f.calls.finance.length, 1);
      assert.ok((await a.load()).record);
      assert.equal(f.calls.closed, 0);
      const changed = model.saveTransaction(
        data,
        model.transactionFromDraft(
          {
            title: 'Fresh data',
            type: 'expense',
            amount: '1',
            date: '2026-10-19',
            categoryId: 'expense-food',
          },
          'new',
          data,
        ),
      );
      find(f.render({ ledger: changed }), 'save-' + kind).props.onPress();
      await tick();
      assert.equal(f.calls.finance.length, 1);
      assert.match(find(f.render(), kind + '-error').props.message, /wallet changed/);
      f.host.unmount();
    },
  );
  test(
    kind +
      ' duplicate submissions are guarded and late success cannot erase another editor newer draft',
    async () => {
      const data = ledger('A', 'wallet-A'),
        a = store(kind),
        value = record(kind, data),
        pending = deferred();
      value.fields.amount = '250';
      if (kind === 'budget') value.fields.anchorDate = '2026-10-19';
      const initial = await a.save(value, 0),
        f = editorFixture(kind, {
          data,
          draftStore: a,
          initialDraft: initial,
          saveResult: () => pending.promise,
        }),
        button = find(f.render(), 'save-' + kind);
      button.props.onPress();
      button.props.onPress();
      await tick();
      assert.equal(f.calls.finance.length, 1);
      const old = await a.load();
      await a.save({ ...value, fields: { ...value.fields, amount: '888' } }, old.revision);
      pending.resolve(true);
      await tick();
      assert.equal((await a.load()).record.fields.amount, '888');
      assert.equal(find(f.render(), 'save-' + kind).props.disabled, true);
      assert.match(find(f.render(), kind + '-error').props.message, /change was saved/);
      f.render().props.onClose();
      assert.equal(f.calls.closed, 1);
      f.host.unmount();
    },
  );
  test(
    kind + ' owner revocation blocks retained form callbacks and Strict Mode preserves autosave',
    async () => {
      const f = editorFixture(kind);
      f.render();
      f.host.replayEffects();
      find(f.render(), kind + '-amount-input').props.onChangeText('123.');
      f.render();
      await tick();
      assert.equal((await f.draftStore.load()).record.fields.amount, '123.');
      const old = f.render();
      f.revoke();
      find(old, 'save-' + kind).props.onPress();
      find(old, kind + '-amount-input').props.onChangeText('999');
      f.render();
      await tick();
      assert.equal(f.calls.finance.length, 0);
      assert.equal((await f.draftStore.load()).record.fields.amount, '123.');
      f.host.unmount();
    },
  );
}

test('PlanScreen binds both draft stores to account/wallet and old modal callbacks cannot dismiss replacement forms', async () => {
  const host = hostWithStores(),
    storage = memory();
  const module = loadSource(path.join(__dirname, '../src/ui/PlanScreen.tsx'), {
    react: host.react,
    'react-native': native,
    '../core/model': model,
    './components': components,
    './BudgetEditor': { BudgetEditor: 'BudgetEditor' },
    './GoalEditor': { GoalEditor: 'GoalEditor' },
    './TransactionsScreen': { displayDate: (v) => v },
    './theme': theme,
    '../accounts/identity': require('../src/accounts/identity'),
    '../drafts/formDrafts': forms,
  });
  let props = {
    ledger: ledger('A', 'wallet-A'),
    saving: false,
    saveError: '',
    onSave: async () => true,
    clearSaveError() {},
    draftContext: { deviceStorage: storage, family, incarnationId: 'wallet-A' },
  };
  const render = () => host.render(() => module.PlanScreen(props));
  find(render(), 'add-budget').props.onPress();
  let tree = render();
  const old = nodes(tree).find((n) => n.type === 'BudgetEditor').props;
  assert.equal(old.draftStore.owner.kind, 'budget');
  assert.equal(old.isCurrent(), true);
  props = {
    ...props,
    draftContext: {
      ...props.draftContext,
      family: { ...family, actor: { ...family.actor, uid: 'B' } },
    },
  };
  tree = render();
  assert.equal(
    nodes(tree).some((n) => n.type === 'BudgetEditor'),
    false,
  );
  assert.equal(old.isCurrent(), false);
  find(tree, 'add-budget').props.onPress();
  tree = render();
  const current = nodes(tree).find((n) => n.type === 'BudgetEditor').props;
  assert.notEqual(current.draftStore.key, old.draftStore.key);
  old.onClose();
  assert.ok(nodes(render()).find((n) => n.type === 'BudgetEditor'));
  current.onClose();
  render();
  find(render(), 'add-goal').props.onPress();
  assert.equal(
    nodes(render()).find((n) => n.type === 'GoalEditor').props.draftStore.owner.kind,
    'goal',
  );
  host.unmount();
});
