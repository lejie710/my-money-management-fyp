const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const { hostWithStores, loadSource, ledger, owner } = require('./helpers/account-hook-harness.cjs');
const { deferred, flush } = require('./helpers/native-adapter-vm.cjs');
const protocol = require('../src/assistant/protocol');
function fixture({ configured = true, work } = {}) {
  const host = hostWithStores();
  host.react.useLayoutEffect = host.react.useEffect;
  const calls = [];
  let connection = {
    phase: configured ? 'configured' : 'not-configured',
    revision: 1,
    binding: configured
      ? {
          assistant: async (payload, options) => {
            calls.push({ payload, ...options });
            return work ? work() : { model: 'synthetic', content: 'opaque', finishReason: 'stop' };
          },
        }
      : null,
  };
  const data = ledger('A', 'shared-incarnation');
  const props = {
    ledger: data,
    owner: {
      scope: { kind: 'test', namespace: 'assistant-binding' },
      actor: { kind: 'firebase', uid: 'A' },
      incarnationId: data.wallet.incarnationId,
    },
    active: true,
    connection: { ...connection, getCurrent: () => connection },
  };
  const hook = loadSource(
    path.join(__dirname, '../src/ui/useAssistantSession.ts'),
    {
      react: host.react,
      '../core/reports': require('../src/core/reports'),
      '../reminders/store': owner,
      '../assistant/client': protocol,
    },
    { AbortController },
  );
  const render = () => host.render(() => hook.useAssistantSession(props));
  return {
    host,
    calls,
    props,
    render,
    open() {
      render().open({ startDate: '2026-10-01', endDate: '2026-10-31' });
      return render();
    },
    recheck() {
      connection = {
        ...connection,
        phase: 'checking',
        revision: connection.revision + 1,
        binding: null,
      };
    },
    syncConnection() {
      props.connection = { ...props.connection, ...connection };
    },
  };
}
test('facts-only panel can open without transport and contains no financial write callbacks', () => {
  const f = fixture({ configured: false }),
    view = f.open();
  assert.ok(view.panel);
  assert.equal(view.panel.transport, undefined);
  assert.equal(view.panel.ledger, f.props.ledger);
  assert.equal(view.panel.actorKey, owner.encodeReminderOwner(f.props.owner));
  assert.equal(view.hasOpenDraft, undefined);
  assert.equal(view.panel.onSave, undefined);
  assert.equal(f.calls.length, 0);
  f.host.unmount();
});
test('root close synchronously aborts request and rejects ignored-abort response before publication', async () => {
  const pending = deferred(),
    f = fixture({ work: () => pending.promise }),
    view = f.open();
  const work = view.panel.transport({}, { signal: new AbortController().signal });
  assert.equal(f.calls.length, 1);
  view.close();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(view.panel.isCurrent(), false);
  pending.resolve({ content: 'old', finishReason: 'stop' });
  await assert.rejects(work, (error) => error.code === 'CANCELLED');
  assert.equal(f.render().panel, null);
  f.host.unmount();
});
test('child Cancel propagates to the exact transport request', async () => {
  const pending = deferred(),
    f = fixture({ work: () => pending.promise }),
    view = f.open(),
    abort = new AbortController();
  const work = view.panel.transport({}, { signal: abort.signal });
  abort.abort();
  assert.equal(f.calls[0].signal.aborted, true);
  pending.resolve({});
  await assert.rejects(work, (error) => error.code === 'CANCELLED');
  assert.ok(f.render().panel);
  f.host.unmount();
});
test('account replacement with same incarnation rejects stale callbacks and cannot close new chat', async () => {
  const f = fixture(),
    old = f.open();
  f.props.owner = { ...f.props.owner, actor: { kind: 'firebase', uid: 'B' } };
  assert.equal(f.render().panel, null);
  assert.equal(old.panel.isCurrent(), false);
  const next = f.open();
  assert.notEqual(next.panel.sessionKey, old.panel.sessionKey);
  old.closeCurrent();
  assert.ok(f.render().panel);
  await assert.rejects(
    old.panel.transport({}, { signal: new AbortController().signal }),
    (error) => error.code === 'CANCELLED',
  );
  assert.equal(f.calls.length, 0);
  f.host.unmount();
});
test('new saved ledger keeps panel available while invalidating old facts and in-flight response', async () => {
  const pending = deferred(),
    f = fixture({ work: () => pending.promise }),
    old = f.open();
  const work = old.panel.transport({}, { signal: new AbortController().signal });
  f.props.ledger = { ...f.props.ledger, wallet: { ...f.props.ledger.wallet, name: 'Updated' } };
  const next = f.render();
  assert.equal(next.panel.sessionKey, old.panel.sessionKey);
  assert.equal(old.panel.isCurrent(), false);
  assert.equal(next.panel.isCurrent(), true);
  pending.resolve({});
  await assert.rejects(work, (error) => error.code === 'CANCELLED');
  f.host.unmount();
});
test('connection recheck blocks a reply immediately before rerender then cancels and clears old chat', async () => {
  const pending = deferred(),
    f = fixture({ work: () => pending.promise }),
    old = f.open();
  const work = old.panel.transport({}, { signal: new AbortController().signal });
  f.recheck();
  assert.equal(old.panel.isCurrent(), false);
  f.syncConnection();
  assert.equal(f.render().panel, null);
  assert.equal(f.calls[0].signal.aborted, true);
  pending.resolve({});
  await assert.rejects(work, (error) => error.code === 'CANCELLED');
  f.host.unmount();
});
test('invalid report range preserves the current chat and StrictMode replay permits a fresh session', () => {
  const f = fixture(),
    old = f.open();
  old.open({ startDate: '2026-02-31', endDate: '2026-10-31' });
  assert.equal(f.render().panel.sessionKey, old.panel.sessionKey);
  assert.match(f.render().error, /valid applied/);
  f.host.replayEffects();
  assert.equal(f.render().panel, null);
  assert.equal(old.panel.isCurrent(), false);
  assert.ok(f.open().panel);
  f.host.unmount();
});
test('shared connection constructs OCR and assistant clients from the same private config without a request', async () => {
  const host = hostWithStores();
  host.react.useLayoutEffect = host.react.useEffect;
  const configs = [];
  let requestOptions;
  const config = {
    version: 1,
    runId: 'synthetic-run',
    url: 'http://127.0.0.1:8787/v1/recognize',
    token: 'x'.repeat(43),
  };
  const module = loadSource(
    path.join(__dirname, '../src/ui/useCompanionConnection.ts'),
    {
      react: host.react,
      '../forecast/client': {
        createForecastClient() {
          throw Error('Legacy pairing must not construct a forecast client.');
        },
      },
      '../companion/providerContract': require('../src/companion/providerContract'),
      '../companion/expoConnection': { readPrivateCompanionConnection: async () => config },
      '../receipts/client': {
        createReceiptClient(value) {
          configs.push(value);
          return {
            recognize: async () => {
              throw Error('Must not request');
            },
          };
        },
      },
      '../assistant/client': {
        createAssistantClient(value, options) {
          configs.push(value);
          requestOptions = options;
          return {
            complete: async () => {
              throw Error('Must not request');
            },
          };
        },
      },
    },
    { __DEV__: true, process: { env: { EXPO_PUBLIC_LOCAL_COMPANION: '1' } } },
  );
  const render = () => host.render(() => module.useCompanionConnection());
  render();
  await flush();
  const view = render();
  assert.equal(view.phase, 'configured');
  assert.equal(configs.length, 2);
  assert.equal(configs[0], config);
  assert.equal(configs[1], config);
  assert.equal(typeof view.binding.assistant, 'function');
  assert.equal(protocol.requestId(requestOptions.createRequestId()), true);
  assert.equal(JSON.stringify(view).includes(config.token), false);
  host.unmount();
});
test('Reports assistant action uses the applied range through un-applied and invalid date edits', () => {
  const host = hostWithStores();
  host.react.useLayoutEffect = host.react.useEffect;
  const ranges = [];
  const module = loadSource(path.join(__dirname, '../src/ui/ReportsScreen.tsx'), {
    react: host.react,
    'react-native': {
      Keyboard: { dismiss() {} },
      Pressable: 'Pressable',
      StyleSheet: { create: (value) => value },
      Text: 'Text',
      View: 'View',
    },
    '../core/model': require('../src/core/model'),
    '../core/reports': require('../src/core/reports'),
    './components': {
      Action: 'Action',
      RowAction: 'RowAction',
      Choice: 'Choice',
      Field: 'Field',
      FormError: 'FormError',
      Screen: 'Screen',
    },
    './TransactionsScreen': { displayDate: (value) => value },
    './theme': { colors: {}, ui: {} },
    './HealthPanel': { HealthPanel: 'HealthPanel' },
    './ForecastEntry': { ForecastEntry: 'ForecastEntry' },
  });
  const render = () =>
    host.render(() =>
      module.ReportsScreen({
        ledger: ledger(),
        forecastOwnerKey: 'synthetic-assistant-owner',
        getForecastToday: () => '2026-10-18',
        onAssistant: (range) => ranges.push(range),
      }),
    );
  const find = (node, id) => {
    if (!node || typeof node !== 'object') return null;
    if (node.props?.testID === id) return node;
    for (const child of (node.props?.children ?? []).flat(Infinity)) {
      const found = find(child, id);
      if (found) return found;
    }
    return null;
  };
  let tree = render();
  find(tree, 'open-report-assistant').props.onPress();
  const initial = ranges[0];
  find(tree, 'report-period-custom').props.onPress();
  tree = render();
  find(tree, 'report-start-input').props.onChangeText('2026-02-31');
  tree = render();
  find(tree, 'open-report-assistant').props.onPress();
  assert.deepEqual(ranges.at(-1), initial);
  find(tree, 'apply-report-range').props.onPress();
  tree = render();
  find(tree, 'open-report-assistant').props.onPress();
  assert.deepEqual(ranges.at(-1), initial);
  find(tree, 'report-start-input').props.onChangeText('2026-10-01');
  tree = render();
  find(tree, 'report-end-input').props.onChangeText('2026-10-18');
  tree = render();
  find(tree, 'apply-report-range').props.onPress();
  tree = render();
  find(tree, 'open-report-assistant').props.onPress();
  assert.deepEqual({ ...ranges.at(-1) }, { startDate: '2026-10-01', endDate: '2026-10-18' });
  host.unmount();
});
