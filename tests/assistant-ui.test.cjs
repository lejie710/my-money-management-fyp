const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const {
  hostWithStores,
  loadSource,
  ledger,
  model,
} = require('./helpers/account-hook-harness.cjs');
const { deferred, flush } = require('./helpers/native-adapter-vm.cjs');
const grounding = require('../src/assistant/grounding'),
  sessions = require('../src/assistant/sessionGate'),
  protocol = require('../src/assistant/protocol');
const answer = (
  text = 'Recorded income is zero, so income-based ratios are undefined.',
  ids = ['income', 'ratios'],
) => ({
  model: grounding.MODEL_ID,
  finishReason: 'stop',
  content: JSON.stringify({ answer: text, factIds: ids }),
});

test('a settled accepted answer is discarded when root ownership closes before the UI continuation without a rerender', async () => {
  let current = true;
  const wrapped = {
    ...sessions,
    createAssistantSession(options) {
      const gate = sessions.createAssistantSession(options);
      return {
        ...gate,
        ask(question) {
          return gate.ask(question).then((result) => {
            current = false;
            return result;
          });
        },
      };
    },
  };
  const f = fixture({ isCurrent: () => current }, { sessions: wrapped });
  assert.equal(await f.ask(), false);
  assert.equal(f.render().turns.length, 0);
  const old = f.render();
  old.setQuestion('stale');
  old.toggleGroup('goal');
  old.setStartDraft('1900-01-01');
  assert.equal(old.applyRange(), false);
  assert.equal(f.render().include.goal, false);
  f.host.unmount();
});

test('model unavailable including memory-limited runtime keeps exact facts and uses a fixed error', async () => {
  const f = fixture({
    transport: async () => {
      throw new protocol.AssistantError('MODEL_UNAVAILABLE');
    },
  });
  const facts = f.render().context.facts;
  assert.equal(await f.ask(), false);
  assert.equal(f.render().message, protocol.MESSAGES.MODEL_UNAVAILABLE);
  assert.equal(f.render().context.facts, facts);
  assert.equal(f.render().turns.length, 0);
  f.host.unmount();
});
function fixture(options = {}, dependencies = {}) {
  const host = hostWithStores();
  host.react.useLayoutEffect = host.react.useEffect;
  let props = {
    ledger: ledger(),
    actorKey: 'test:account-A:wallet-A',
    sessionKey: 'chat-one',
    initialRange: { startDate: '2026-10-01', endDate: '2026-10-31' },
    transport: async () => answer(),
    ...options,
  };
  const hook = loadSource(path.join(__dirname, '../src/ui/useAssistant.ts'), {
    react: host.react,
    '../assistant/grounding': dependencies.grounding ?? grounding,
    '../assistant/sessionGate': dependencies.sessions ?? sessions,
    '../assistant/protocol': protocol,
  });
  return {
    host,
    hook,
    get props() {
      return props;
    },
    render(next = {}) {
      props = { ...props, ...next };
      return host.render(() => hook.useAssistant(props));
    },
    async ask(question = 'Explain my recorded cash flow.') {
      this.render().setQuestion(question);
      const result = this.render().ask();
      await flush();
      return result;
    },
  };
}
test('default context contains exact base facts and known zero, with optional groups and sensitive transaction context excluded', () => {
  const source = model.createDemoLedger(new Date(2026, 9, 18));
  source.transactions[0].context = {
    notes: 'private-note-canary',
    photo: null,
    withPerson: { name: 'private-person-canary', source: 'manual' },
    location: { label: 'private-place-canary', source: 'manual' },
  };
  const f = fixture({ ledger: source }),
    view = f.render();
  assert.deepEqual(Object.values(view.include), [false, false, false, false, false]);
  const serialized = JSON.stringify(view.context);
  for (const text of ['private-note-canary', 'private-person-canary', 'private-place-canary'])
    assert.ok(!serialized.includes(text));
  assert.ok(
    !view.context.facts.some(
      (fact) => fact.id === 'allDates' || fact.id === 'health' || fact.id.startsWith('category'),
    ),
  );
  assert.equal(fixture().render().context.recordedIncomeIsZero, true);
  f.host.unmount();
});
test('missing transport leaves facts readable and makes no provider call', async () => {
  const f = fixture({ transport: undefined }),
    view = f.render();
  assert.equal(view.configured, false);
  assert.equal(view.canAsk, false);
  assert.ok(view.context.facts.length > 0);
  view.setQuestion('Explain.');
  assert.equal(await f.render().ask(), false);
  assert.equal(f.render().turns.length, 0);
  f.host.unmount();
});
test('invalid date Apply preserves context and previous explanation; valid changed dates clear it', async () => {
  const f = fixture();
  assert.equal(await f.ask(), true);
  const context = f.render().context;
  f.render().setStartDraft('2026-02-31');
  assert.equal(f.render().applyRange(), false);
  assert.equal(f.render().context, context);
  assert.equal(f.render().turns.length, 1);
  assert.match(f.render().selectionError, /unchanged/);
  f.render().setStartDraft('2026-10-02');
  assert.equal(f.render().applyRange(), true);
  assert.notEqual(f.render().context, context);
  assert.equal(f.render().turns.length, 0);
  assert.equal(f.render().selectionError, '');
  f.host.unmount();
});
test('explicit optional group changes rebuild context and close old requests without sending another request', async () => {
  const pending = deferred();
  let calls = 0,
    signal;
  const f = fixture({
    transport: (payload, options) => {
      calls++;
      signal = options.signal;
      return pending.promise;
    },
  });
  f.render().setQuestion('Explain.');
  const work = f.render().ask();
  await flush();
  f.render().toggleGroup('allDatesBalance');
  const view = f.render();
  assert.equal(signal.aborted, true);
  assert.equal(view.busy, false);
  assert.ok(view.context.facts.some((fact) => fact.id === 'allDates'));
  assert.equal(calls, 1);
  pending.resolve(answer());
  assert.equal(await work, false);
  assert.equal(f.render().turns.length, 0);
  f.host.unmount();
});
test('old actor callbacks and late replies cannot enter a replacement wallet with the same ledger incarnation', async () => {
  const pending = deferred();
  let calls = 0;
  const f = fixture({
    transport: () => {
      calls++;
      return pending.promise;
    },
  });
  f.render().setQuestion('Old question');
  const old = f.render(),
    work = old.ask();
  await flush();
  f.render({ actorKey: 'test:account-B:wallet-A' });
  old.setQuestion('Stale edit');
  old.toggleGroup('goal');
  old.setStartDraft('1900-01-01');
  assert.equal(await old.ask(), false);
  pending.resolve(answer());
  assert.equal(await work, false);
  const view = f.render();
  assert.equal(view.question, '');
  assert.equal(view.include.goal, false);
  assert.equal(view.startDraft, '2026-10-01');
  assert.equal(view.turns.length, 0);
  assert.equal(calls, 1);
  f.host.unmount();
});
test('saved ledger and transport changes invalidate an already open conversation', async () => {
  const f = fixture();
  assert.equal(await f.ask(), true);
  const source = f.props.ledger;
  f.render({ ledger: { ...source, wallet: { ...source.wallet, name: 'Renamed' } } });
  assert.equal(f.render().turns.length, 0);
  assert.equal(await f.ask(), true);
  f.render({ transport: async () => answer() });
  assert.equal(f.render().turns.length, 0);
  f.host.unmount();
});
test('cancel suppresses a late accepted answer; only explicit retry issues a second request', async () => {
  const pending = deferred();
  let calls = 0;
  const f = fixture({
    transport: () => (++calls === 1 ? pending.promise : Promise.resolve(answer())),
  });
  f.render().setQuestion('Explain zero.');
  const work = f.render().ask();
  await flush();
  f.render().cancel();
  assert.equal(f.render().busy, false);
  assert.match(f.render().message, /may still be finishing/);
  pending.resolve(answer());
  assert.equal(await work, false);
  assert.equal(f.render().turns.length, 0);
  assert.equal(calls, 1);
  assert.equal(await f.render().retry(), true);
  assert.equal(calls, 2);
  assert.equal(f.render().turns.length, 1);
  f.host.unmount();
});
test('safe provider codes replace private exceptions; known-zero defect answers are rejected', async () => {
  const f = fixture({
    transport: async () => {
      throw new protocol.AssistantError('BUSY');
    },
  });
  assert.equal(await f.ask(), false);
  assert.equal(f.render().message, protocol.MESSAGES.BUSY);
  f.render({
    transport: async () => {
      throw Error('private-secret-canary');
    },
  });
  assert.equal(await f.ask(), false);
  assert.equal(f.render().message, protocol.MESSAGES.NETWORK);
  assert.ok(!f.render().message.includes('canary'));
  f.render({ transport: async () => answer('No income data was provided.') });
  assert.equal(await f.ask(), false);
  assert.equal(f.render().turns.length, 0);
  assert.equal(f.render().message, protocol.MESSAGES.INVALID_MODEL_RESPONSE);
  f.host.unmount();
});
test('StrictMode effect replay closes the old gate, creates a usable gate and never publishes its old result', async () => {
  const pending = deferred();
  let calls = 0;
  const f = fixture({
    transport: () => (++calls === 1 ? pending.promise : Promise.resolve(answer())),
  });
  f.render().setQuestion('First');
  const work = f.render().ask();
  await flush();
  f.host.replayEffects();
  f.render();
  pending.resolve(answer());
  assert.equal(await work, false);
  assert.equal(f.render().busy, false);
  assert.equal(await f.ask('Second'), true);
  assert.equal(f.render().turns.length, 1);
  assert.equal(f.render().turns[0].question, 'Second');
  f.host.unmount();
});
test('only three ephemeral turns remain and previous explanations are never injected into later requests', async () => {
  const payloads = [];
  const f = fixture({
    transport: async (payload) => {
      payloads.push(payload);
      return answer('Unique generated explanation canary.', ['income']);
    },
  });
  for (let i = 1; i <= 4; i++) assert.equal(await f.ask(`Question ${i}`), true);
  assert.deepEqual(
    Array.from(f.render().turns, (turn) => turn.question),
    ['Question 2', 'Question 3', 'Question 4'],
  );
  for (const payload of payloads)
    assert.ok(!JSON.stringify(payload).includes('Unique generated explanation canary'));
  f.render().clear();
  assert.equal(f.render().turns.length, 0);
  assert.equal(f.render().question, '');
  f.host.unmount();
});
test('unmount invalidates pending results even if the transport ignores abort', async () => {
  const pending = deferred();
  const f = fixture({ transport: () => pending.promise });
  f.render().setQuestion('Explain.');
  const work = f.render().ask();
  await flush();
  f.host.unmount();
  pending.resolve(answer());
  assert.equal(await work, false);
});

test('a result settled before the UI continuation is still discarded after session replacement', async () => {
  let f;
  const wrapped = {
    createAssistantSession(options) {
      const gate = sessions.createAssistantSession(options);
      return {
        ...gate,
        ask(question) {
          return gate.ask(question).then((result) => {
            f.render({ sessionKey: 'replacement-session' });
            return result;
          });
        },
      };
    },
  };
  f = fixture({}, { sessions: wrapped });
  assert.equal(await f.ask('Old session question'), false);
  assert.equal(f.render().turns.length, 0);
  assert.equal(f.render().question, '');
  f.host.unmount();
});

test('an oversized prepared context remains readable and never throws from session creation', () => {
  let created = 0;
  const f = fixture(
    {},
    {
      grounding: {
        ...grounding,
        buildAssistantRequest() {
          throw Error('synthetic bound exceeded');
        },
      },
      sessions: {
        createAssistantSession() {
          created++;
          throw Error('Must not construct');
        },
      },
    },
  );
  const view = f.render();
  assert.ok(view.context.facts.length > 0);
  assert.equal(view.canAsk, false);
  assert.equal(view.contextError, protocol.MESSAGES.TOO_LARGE);
  assert.equal(created, 0);
  f.host.unmount();
});

test('panel visibly distinguishes configured connection, known-zero facts, explicit opt-ins and generated explanations', async () => {
  const f = fixture();
  const panel = loadSource(path.join(__dirname, '../src/ui/AssistantPanel.tsx'), {
    react: f.host.react,
    'react-native': {
      ActivityIndicator: 'ActivityIndicator',
      Switch: 'Switch',
      Text: 'Text',
      View: 'View',
      StyleSheet: { create: (value) => value },
    },
    './components': { Action: 'Action', Field: 'Field', FormError: 'FormError' },
    './theme': { colors: {}, ui: {} },
    './useAssistant': f.hook,
  });
  const render = () => f.host.render(() => panel.AssistantPanel(f.props));
  const nodes = (value) =>
    !value || typeof value !== 'object'
      ? []
      : Array.isArray(value)
        ? value.flatMap(nodes)
        : [value, ...nodes(value.props?.children)];
  const find = (tree, id) => nodes(tree).find((node) => node.props?.testID === id);
  let tree = render();
  assert.match(
    find(tree, 'assistant-connection-status').props.children.join(''),
    /configured.*checked when you ask/,
  );
  assert.match(find(tree, 'assistant-zero-income').props.children.join(''), /known to be zero/);
  assert.equal(
    nodes(tree).filter((node) => node.type === 'Switch' && node.props.value === false).length,
    5,
  );
  assert.ok(find(tree, 'assistant-facts'));
  assert.equal(find(tree, 'assistant-ask').props.disabled, true);
  assert.equal(await f.ask(), true);
  tree = render();
  assert.match(
    find(tree, 'assistant-connection-status').props.children.join(''),
    /model responded.*can still be wrong/,
  );
  assert.ok(find(tree, 'assistant-answer-0'));
  f.host.unmount();
});
