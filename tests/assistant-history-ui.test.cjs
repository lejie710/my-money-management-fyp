const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { hostWithStores, loadSource, ledger, model } = require('./helpers/account-hook-harness.cjs');
const { deferred, flush } = require('./helpers/native-adapter-vm.cjs');
const grounding = require('../src/assistant/grounding');
const sessions = require('../src/assistant/sessionGate');
const protocol = require('../src/assistant/protocol');
const conversations = require('../src/assistant/conversations');
function memory() {
  const values = new Map();
  return {
    values,
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
    async removeItem(key) {
      values.delete(key);
    },
  };
}
const response = (
  answer = 'Review the recorded income and spending before choosing a budget.',
) => ({
  model: grounding.MODEL_ID,
  finishReason: 'stop',
  content: JSON.stringify({ answer, factIds: ['income', 'expense'] }),
});
function fixture(options = {}) {
  const host = hostWithStores();
  host.react.useLayoutEffect = host.react.useEffect;
  const storage = options.storage ?? memory();
  const store =
    options.conversationStore ??
    conversations.createConversationStore(storage, 'project/account-A');
  const requests = [];
  let props = {
    ledger: ledger('Everyday wallet', 'wallet-A'),
    actorKey: 'project/account-A/wallet-A',
    sessionKey: 'session-one',
    initialRange: { startDate: '2026-10-01', endDate: '2026-10-31' },
    conversationStore: store,
    transport: async (payload) => {
      requests.push(payload);
      return response();
    },
    ...options,
  };
  delete props.storage;
  const hook = loadSource(path.join(__dirname, '../src/ui/useAssistant.ts'), {
    react: host.react,
    '../assistant/grounding': grounding,
    '../assistant/sessionGate': sessions,
    '../assistant/protocol': protocol,
  });
  return {
    host,
    storage,
    store,
    requests,
    get props() {
      return props;
    },
    render(next = {}) {
      props = { ...props, ...next };
      return host.render(() => hook.useAssistant(props));
    },
    async ready() {
      this.render();
      await flush();
      return this.render();
    },
    async ask(question = 'How can I improve this budget?') {
      this.render().setQuestion(question);
      const done = this.render().ask();
      await flush();
      const result = await done;
      this.render();
      return result;
    },
  };
}

test('saved conversation reopens on the same account and follows up with prior messages only after explicit Continue', async () => {
  const first = fixture();
  assert.equal(first.render().canAsk, false);
  await first.ready();
  assert.equal(await first.ask('First question'), true);
  const saved = first.render().history[0];
  assert.ok(saved);
  assert.equal(saved.turns.length, 1);
  first.render().close();
  first.host.unmount();
  const second = fixture({
    storage: first.storage,
    conversationStore: first.store,
    ledger: first.props.ledger,
    sessionKey: 'session-two',
  });
  await second.ready();
  second.render().openSaved(saved.id);
  let view = second.render();
  assert.equal(view.archivedConversation.id, saved.id);
  assert.equal(view.turns.length, 0);
  assert.equal(view.canAsk, false);
  assert.equal(view.canContinueSaved, true);
  assert.equal(view.continueSaved(), true);
  assert.equal(second.render().turns.length, 1);
  assert.equal(await second.ask('Explain that suggestion'), true);
  const outgoing = JSON.parse(second.requests[0].messages[2].content);
  assert.deepEqual(outgoing.history, [
    { question: 'First question', answer: saved.turns[0].answer },
  ]);
  assert.equal(second.render().history.length, 1);
  assert.equal(second.render().history[0].id, saved.id);
  assert.equal(second.render().history[0].turns.length, 2);
  second.host.unmount();
});

test('account histories remain separate and switching accounts does not expose an old archive', async () => {
  const f = fixture();
  await f.ready();
  await f.ask('Only account A');
  const saved = f.render().history[0];
  f.render().openSaved(saved.id);
  assert.equal(f.render().archivedConversation.id, saved.id);
  const storeB = conversations.createConversationStore(f.storage, 'project/account-B');
  let view = f.render({
    actorKey: 'project/account-B/wallet-B',
    sessionKey: 'session-B',
    ledger: ledger('B', 'wallet-B'),
    conversationStore: storeB,
  });
  assert.equal(view.archivedConversation, null);
  assert.equal(view.history.length, 0);
  await flush();
  view = f.render();
  assert.equal(view.history.length, 0);
  assert.equal(view.historyLoaded, true);
  view.openSaved(saved.id);
  assert.equal(f.render().archivedConversation, null);
  await f.ask('Only account B');
  assert.equal((await f.store.load())[0].turns[0].question, 'Only account A');
  assert.equal((await storeB.load())[0].turns[0].question, 'Only account B');
  f.host.unmount();
});

test('historical facts stay readable after ledger changes but cannot be continued against different current figures', async () => {
  const f = fixture();
  await f.ready();
  await f.ask();
  const saved = f.render().history[0],
    oldExpense = saved.context.facts.find((x) => x.id === 'expense').value;
  const changed = model.saveTransaction(
    f.props.ledger,
    model.transactionFromDraft(
      {
        title: 'Lunch',
        date: '2026-10-19',
        type: 'expense',
        amount: '12.50',
        categoryId: 'expense-food',
      },
      'lunch-one',
      f.props.ledger,
    ),
  );
  f.render({ ledger: changed });
  f.render().openSaved(saved.id);
  const view = f.render();
  assert.equal(
    view.archivedConversation.context.facts.find((x) => x.id === 'expense').value,
    oldExpense,
  );
  assert.notEqual(view.context.facts.find((x) => x.id === 'expense').value, oldExpense);
  assert.equal(view.canContinueSaved, false);
  assert.equal(view.continueSaved(), false);
  assert.equal(await view.ask(), false);
  assert.equal(f.requests.length, 1);
  view.closeSaved();
  f.render();
  assert.equal(await f.ask('Question with new data'), true);
  assert.equal(f.render().history.length, 2);
  assert.equal(JSON.parse(f.requests[1].messages[2].content).history, undefined);
  f.host.unmount();
});

test('failed persistence keeps the accepted answer visible and explicit retry saves without another model call', async () => {
  const f = fixture();
  await f.ready();
  const save = f.storage.setItem;
  f.storage.setItem = async () => {
    throw Error('storage unavailable');
  };
  assert.equal(await f.ask(), true);
  assert.equal(f.render().turns.length, 1);
  assert.equal(f.render().history.length, 0);
  assert.match(f.render().historyError, /not confirmed saved/);
  f.storage.setItem = save;
  await f.render().saveConversation();
  assert.equal(f.render().history.length, 1);
  assert.equal(f.render().historyError, '');
  assert.equal(f.requests.length, 1);
  f.host.unmount();
});

test('a write that completed before an error recovers by reopening history and retries without duplicating turns', async () => {
  const f = fixture();
  await f.ready();
  const save = f.storage.setItem;
  f.storage.setItem = async (key, value) => {
    await save(key, value);
    throw Error('late write failure');
  };
  await f.ask('Retain this once');
  assert.match(f.render().historyError, /not confirmed saved/);
  f.storage.setItem = save;
  await f.render().refreshHistory();
  assert.equal(f.render().history.length, 1);
  await f.render().saveConversation();
  assert.equal(f.render().historyError, '');
  assert.equal(f.render().history.length, 1);
  assert.equal(f.render().history[0].turns.length, 1);
  assert.equal(f.requests.length, 1);
  f.host.unmount();
});

test('corrupt history blocks new saved conversations and retains its bytes until successful reload', async () => {
  const f = fixture();
  await f.ready();
  await f.ask();
  const key = [...f.storage.values.keys()][0],
    valid = f.storage.values.get(key);
  f.storage.values.set(key, '{broken');
  await f.render().refreshHistory();
  assert.equal(f.render().historyLoaded, false);
  assert.equal(f.render().canAsk, false);
  assert.equal(await f.ask('Should not reach model'), false);
  assert.equal(f.requests.length, 1);
  assert.equal(f.storage.values.get(key), '{broken');
  f.storage.values.set(key, valid);
  await f.render().refreshHistory();
  assert.equal(f.render().historyLoaded, true);
  assert.equal(f.render().history.length, 1);
  f.host.unmount();
});

test('late history loads for the old account cannot replace the newly active account history', async () => {
  const f = fixture();
  await f.ready();
  await f.ask('History A');
  const rowsA = await f.store.load(),
    pending = deferred();
  const slowA = { ...f.store, load: () => pending.promise };
  f.render({ conversationStore: slowA });
  const storeB = conversations.createConversationStore(f.storage, 'project/account-B');
  f.render({
    conversationStore: storeB,
    actorKey: 'project/account-B/wallet-B',
    sessionKey: 'session-B',
    ledger: ledger('B', 'wallet-B'),
  });
  await flush();
  assert.equal(f.render().history.length, 0);
  pending.resolve(rowsA);
  await flush();
  assert.equal(f.render().historyLoaded, true);
  assert.equal(f.render().history.length, 0);
  assert.equal(f.render().historyError, '');
  f.host.unmount();
});

test('a local save already underway stays with its original account and never publishes into a replacement account', async () => {
  const storage = memory(),
    base = conversations.createConversationStore(storage, 'project/account-A'),
    pending = deferred();
  let entered = false;
  const slow = {
    ...base,
    async save(...args) {
      entered = true;
      await pending.promise;
      return base.save(...args);
    },
  };
  const f = fixture({ storage, conversationStore: slow });
  await f.ready();
  f.render().setQuestion('Save for account A');
  const asking = f.render().ask();
  await flush();
  assert.equal(entered, true);
  const storeB = conversations.createConversationStore(storage, 'project/account-B');
  f.render({
    conversationStore: storeB,
    actorKey: 'project/account-B/wallet-B',
    sessionKey: 'session-B',
    ledger: ledger('B', 'wallet-B'),
  });
  await flush();
  pending.resolve();
  await asking;
  await flush();
  assert.equal(f.render().history.length, 0);
  assert.equal(f.render().turns.length, 0);
  assert.equal((await base.load())[0].turns[0].question, 'Save for account A');
  assert.equal((await storeB.load()).length, 0);
  f.host.unmount();
});

test('closing before a model response prevents both display and history persistence', async () => {
  const pending = deferred();
  const f = fixture({ transport: () => pending.promise });
  await f.ready();
  f.render().setQuestion('Pending answer');
  const asking = f.render().ask();
  await flush();
  f.render().close();
  pending.resolve(response());
  assert.equal(await asking, false);
  assert.equal(f.render().turns.length, 0);
  assert.equal((await f.store.load()).length, 0);
  f.host.unmount();
});

test('only the newest three exchanges are sent and changed selections start a fresh context', async () => {
  const f = fixture();
  await f.ready();
  for (let index = 1; index <= 5; index++) assert.equal(await f.ask('Question ' + index), true);
  const recent = JSON.parse(f.requests[4].messages[2].content).history;
  assert.deepEqual(
    recent.map((x) => x.question),
    ['Question 2', 'Question 3', 'Question 4'],
  );
  assert.equal(f.render().turns.length, 5);
  f.render().toggleGroup('categories');
  f.render();
  await f.ask('New selected context');
  assert.equal(JSON.parse(f.requests[5].messages[2].content).history, undefined);
  assert.equal(f.render().history.length, 2);
  f.host.unmount();
});

test('deleting the active saved conversation removes its local history and starts a new conversation on the next question', async () => {
  const f = fixture();
  await f.ready();
  await f.ask('Delete this conversation');
  const saved = f.render().history[0];
  await f.render().deleteSaved(saved.id);
  assert.equal(f.render().history.length, 0);
  assert.equal(f.render().turns.length, 0);
  assert.equal((await f.store.load()).length, 0);
  await f.ask('A fresh conversation');
  assert.notEqual(f.render().history[0].id, saved.id);
  assert.equal(f.render().history[0].turns.length, 1);
  f.host.unmount();
});

test('callbacks retained from a closed assistant cannot save or delete its history', async () => {
  let current = true;
  const f = fixture({ isCurrent: () => current });
  await f.ready();
  await f.ask('Keep history');
  const old = f.render(),
    saved = old.history[0],
    before = JSON.stringify(await f.store.load());
  current = false;
  old.close();
  await old.saveConversation();
  await old.deleteSaved(saved.id);
  assert.equal(JSON.stringify(await f.store.load()), before);
  f.host.unmount();
});

test('an old account archive callback cannot close the current account archive', async () => {
  const f = fixture();
  await f.ready();
  await f.ask('A');
  f.render().openSaved(f.render().history[0].id);
  const old = f.render();
  const storeB = conversations.createConversationStore(f.storage, 'project/account-B');
  f.render({
    conversationStore: storeB,
    actorKey: 'project/account-B/wallet-B',
    sessionKey: 'session-B',
    ledger: ledger('B', 'wallet-B'),
  });
  await flush();
  await f.ask('B');
  const idB = f.render().history[0].id;
  f.render().openSaved(idB);
  assert.equal(f.render().archivedConversation.id, idB);
  old.closeSaved();
  assert.equal(f.render().archivedConversation?.id, idB);
  f.host.unmount();
});

const nodes = (value) =>
  !value || typeof value !== 'object'
    ? []
    : Array.isArray(value)
      ? value.flatMap(nodes)
      : [value, ...nodes(value.props?.children)];
const text = (value) =>
  value == null
    ? ''
    : Array.isArray(value)
      ? value.map(text).join('')
      : typeof value === 'object'
        ? text(value.props?.children)
        : String(value);
const find = (tree, id) => nodes(tree).find((node) => node.props?.testID === id);
function panelFixture(f) {
  const host = hostWithStores();
  let assistant = f.render();
  const panel = loadSource(path.join(__dirname, '../src/ui/AssistantPanel.tsx'), {
    react: host.react,
    'react-native': {
      ActivityIndicator: 'ActivityIndicator',
      Switch: 'Switch',
      Text: 'Text',
      View: 'View',
      StyleSheet: { create: (value) => value },
    },
    './components': { Action: 'Action', Field: 'Field', FormError: 'FormError' },
    './theme': require('./helpers/theme-stub.cjs').themeStub,
    './useAssistant': { useAssistant: () => assistant },
  });
  return {
    host,
    render() {
      assistant = f.render();
      return host.render(() => panel.AssistantPanel(f.props));
    },
  };
}

test('history UI shows device/account scope and requires a second action before deleting saved conversation', async () => {
  const f = fixture();
  await f.ready();
  await f.ask('Keep until confirmed');
  const saved = f.render().history[0],
    p = panelFixture(f);
  let tree = p.render();
  assert.equal(find(tree, 'assistant-history'), undefined);
  find(tree, 'assistant-history-toggle').props.onPress();
  tree = p.render();
  assert.match(text(find(tree, 'assistant-history')), /separately for each account/);
  assert.match(text(find(tree, 'assistant-history')), /not synchronized to Firebase/);
  find(tree, 'assistant-history-delete-' + saved.id).props.onPress();
  tree = p.render();
  assert.ok(find(tree, 'assistant-history-confirm-delete-' + saved.id));
  assert.equal((await f.store.load()).length, 1);
  const keep = nodes(tree).find((node) => node.props?.label === 'Keep conversation');
  keep.props.onPress();
  assert.equal(find(p.render(), 'assistant-history-confirm-delete-' + saved.id), undefined);
  assert.equal((await f.store.load()).length, 1);
  find(p.render(), 'assistant-history-delete-' + saved.id).props.onPress();
  find(p.render(), 'assistant-history-confirm-delete-' + saved.id).props.onPress();
  await flush();
  assert.equal((await f.store.load()).length, 0);
  assert.equal(find(p.render(), 'assistant-history-open-' + saved.id), undefined);
  p.host.unmount();
  f.host.unmount();
});

test('archive UI displays captured period and cited values and hides Continue after wallet figures change', async () => {
  const f = fixture();
  await f.ready();
  await f.ask('Old income and expense');
  const saved = f.render().history[0],
    p = panelFixture(f);
  find(p.render(), 'assistant-history-toggle').props.onPress();
  find(p.render(), 'assistant-history-open-' + saved.id).props.onPress();
  let detail = find(p.render(), 'assistant-history-detail');
  assert.match(text(detail), /2026-10-01 through 2026-10-31/);
  assert.match(text(detail), /MYR 0\.00/);
  assert.ok(find(p.render(), 'assistant-history-continue'));
  const changed = model.saveTransaction(
    f.props.ledger,
    model.transactionFromDraft(
      {
        title: 'Dinner',
        type: 'expense',
        date: '2026-10-20',
        amount: '25',
        categoryId: 'expense-food',
      },
      'dinner-one',
      f.props.ledger,
    ),
  );
  f.render({ ledger: changed });
  detail = find(p.render(), 'assistant-history-detail');
  assert.match(text(detail), /MYR 0\.00/);
  assert.match(text(detail), /Historical answers are not a new assessment/);
  assert.equal(find(p.render(), 'assistant-history-continue'), undefined);
  assert.equal(find(p.render(), 'assistant-ask').props.disabled, true);
  p.host.unmount();
  f.host.unmount();
});

test('session history store is stable across wallet incarnations but isolated by Firebase project and account', async () => {
  const host = hostWithStores();
  host.react.useLayoutEffect = host.react.useEffect;
  const storage = memory();
  const hook = loadSource(
    path.join(__dirname, '../src/ui/useAssistantSession.ts'),
    {
      react: host.react,
      '../core/reports': require('../src/core/reports'),
      '../reminders/store': require('../src/reminders/store'),
      '../assistant/client': protocol,
      '../assistant/conversations': conversations,
      '../accounts/identity': require('../src/accounts/identity'),
    },
    { AbortController },
  );
  const connectionState = { phase: 'not-configured', revision: 0, binding: null };
  let data = ledger('Wallet one', 'incarnation-one');
  const props = {
    ledger: data,
    owner: {
      scope: { kind: 'test', namespace: 'history-isolation' },
      actor: { kind: 'firebase-hosted', projectId: 'demo-project-a', uid: 'same-user' },
      incarnationId: data.wallet.incarnationId,
    },
    active: true,
    connection: { ...connectionState, getCurrent: () => connectionState },
    historyStorage: storage,
  };
  const render = () => host.render(() => hook.useAssistantSession(props));
  const open = () => {
    render().open({ startDate: '2026-10-01', endDate: '2026-10-31' });
    return render().panel;
  };
  const first = open().conversationStore;
  const record = {
    id: 'stored-first',
    createdAt: 1,
    updatedAt: 1,
    walletId: 'incarnation-one',
    walletName: 'Wallet one',
    provider: { engine: 'lemonade', processing: 'local', model: grounding.MODEL_ID },
    context: grounding.buildAssistantContext(data, {
      startDate: '2026-10-01',
      endDate: '2026-10-31',
    }),
    turns: [{ question: 'A saved question', answer: 'An original response.', factIds: ['income'] }],
  };
  await first.save(record);
  data = ledger('Wallet two', 'incarnation-two');
  props.ledger = data;
  props.owner = { ...props.owner, incarnationId: data.wallet.incarnationId };
  const nextWallet = open().conversationStore;
  assert.equal(nextWallet, first);
  assert.equal((await nextWallet.load()).length, 1);
  props.owner = { ...props.owner, actor: { ...props.owner.actor, projectId: 'demo-project-b' } };
  const otherProject = open().conversationStore;
  assert.notEqual(otherProject, first);
  assert.equal((await otherProject.load()).length, 0);
  props.owner = {
    ...props.owner,
    actor: { ...props.owner.actor, projectId: 'demo-project-a', uid: 'other-user' },
  };
  assert.equal((await open().conversationStore.load()).length, 0);
  assert.equal((await first.load()).length, 1);
  host.unmount();
});
