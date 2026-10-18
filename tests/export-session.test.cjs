const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const { createHookHost, loadTsSource } = require('./helpers/hook-host.cjs');
const model = require('../src/core/model'),
  exportsModel = require('../src/core/exports'),
  ownerCore = require('../src/reminders/store');
function fixture() {
  const host = createHookHost();
  host.react.useLayoutEffect = host.react.useEffect;
  host.react.useMemo = (factory, deps) => {
    const ref = host.react.useRef(null);
    if (!ref.current || deps.some((value, index) => !Object.is(value, ref.current.deps[index])))
      ref.current = { deps, value: factory() };
    return ref.current.value;
  };
  const controllers = [];
  let props = {
    ledger: model.createDemoLedger(new Date(2026, 9, 18)),
    owner: null,
    active: true,
    photos: { familyToken: 'synthetic-family' },
  };
  props.owner = {
    scope: { kind: 'test', namespace: 'export-session' },
    actor: { kind: 'local' },
    incarnationId: props.ledger.wallet.incarnationId,
  };
  const module = loadTsSource(path.join(__dirname, '../src/ui/useExportSession.ts'), {
    react: host.react,
    '@react-native-async-storage/async-storage': {},
    '../core/exports': exportsModel,
    '../reminders/store': ownerCore,
    '../exports/expoPdfAdapter': {
      createExpoPdfServices(options) {
        const controller = {
          ownerToken: ownerCore.encodeReminderOwner(options.owner),
          options,
          closed: 0,
          close() {
            controller.closed++;
          },
        };
        controllers.push(controller);
        return controller;
      },
    },
  });
  return {
    host,
    controllers,
    get props() {
      return props;
    },
    render(next = {}) {
      props = { ...props, ...next };
      return host.render(() => module.useExportSession(props));
    },
  };
}
const range = { startDate: '2026-10-01', endDate: '2026-10-31' };
test('export opening captures one immutable report and exact owner without creating or sharing a PDF', () => {
  const f = fixture();
  assert.equal(f.render().session, null);
  assert.equal(f.controllers.length, 0);
  f.render().openReport(range);
  const opened = f.render().session;
  assert.equal(opened.kind, 'report');
  assert.equal(opened.snapshot.startDate, range.startDate);
  assert.equal(Object.isFrozen(opened.snapshot), true);
  assert.equal(opened.ownerToken, ownerCore.encodeReminderOwner(f.props.owner));
  assert.equal(opened.controller.options.isCurrent(), true);
  f.render({
    ledger: {
      ...f.props.ledger,
      wallet: { ...f.props.ledger.wallet, name: 'Changed after capture' },
    },
  });
  assert.equal(f.render().session, opened);
  assert.notEqual(opened.snapshot.walletName, 'Changed after capture');
  f.host.unmount();
});
test('replacement export closes prior controller and stale panel close cannot close its successor', () => {
  const f = fixture();
  f.render().openReport(range);
  const old = f.render();
  old.openTransaction(f.props.ledger.transactions[0].id);
  const current = f.render();
  assert.equal(current.session.kind, 'transaction');
  assert.equal(f.controllers[0].closed, 1);
  assert.equal(f.controllers[0].options.isCurrent(), false);
  old.closeCurrent();
  assert.equal(f.render().session, current.session);
  assert.equal(f.controllers[1].closed, 0);
  current.closeCurrent();
  assert.equal(f.render().session, null);
  assert.equal(f.controllers[1].closed, 1);
  f.host.unmount();
});
test('loading or error deactivation closes and hides old sessions; restored same owner rejects old callbacks', () => {
  const f = fixture();
  f.render().openReport(range);
  const old = f.render();
  f.render({ active: false });
  assert.equal(f.render().session, null);
  assert.equal(f.controllers[0].closed, 1);
  assert.equal(f.controllers[0].options.isCurrent(), false);
  old.openReport(range);
  assert.equal(f.controllers.length, 1);
  f.render({ active: true });
  old.openReport(range);
  assert.equal(f.controllers.length, 1);
  f.render().openReport(range);
  assert.equal(f.controllers.length, 2);
  f.host.unmount();
});
test('different account with the same incarnation never inherits a prior export or service', () => {
  const f = fixture();
  f.render().openReport(range);
  const old = f.render();
  f.render({
    owner: { ...f.props.owner, actor: { kind: 'firebase', uid: 'synthetic-account-B' } },
  });
  assert.equal(f.render().session, null);
  assert.equal(f.controllers[0].options.isCurrent(), false);
  assert.equal(f.controllers[0].closed, 1);
  old.openTransaction(f.props.ledger.transactions[0].id);
  assert.equal(f.controllers.length, 1);
  f.render().openTransaction(f.props.ledger.transactions[0].id);
  assert.equal(f.controllers.length, 2);
  assert.notEqual(f.controllers[0].ownerToken, f.controllers[1].ownerToken);
  f.host.unmount();
});
test('unmount and StrictMode replay close controllers; the mounted replacement remains usable', () => {
  const f = fixture();
  f.render().openReport(range);
  f.host.replayEffects();
  assert.equal(f.controllers[0].closed, 1);
  assert.equal(f.controllers[0].options.isCurrent(), false);
  assert.equal(f.render().session, null);
  f.render().openReport(range);
  assert.ok(f.render().session);
  f.host.unmount();
  assert.equal(f.controllers[1].closed, 1);
  assert.equal(f.controllers[1].options.isCurrent(), false);
});
test('photo binding replacement closes export and absent binding gives a fixed retryable opening error', () => {
  const f = fixture();
  f.render().openReport(range);
  f.render({ photos: undefined });
  assert.equal(f.render().session, null);
  assert.equal(f.controllers[0].closed, 1);
  f.render().openReport(range);
  assert.match(f.render().error, /still opening/);
  assert.equal(f.controllers.length, 1);
  f.render({ photos: { familyToken: 'synthetic-family' } });
  f.render().openReport(range);
  assert.ok(f.render().session);
  assert.equal(f.render().error, '');
  f.host.unmount();
});
test('stale record callbacks and invalid targets cannot capture a replacement saved ledger', () => {
  const f = fixture(),
    old = f.render();
  f.render({ ledger: { ...f.props.ledger, wallet: { ...f.props.ledger.wallet, name: 'Latest' } } });
  old.openReport(range);
  assert.equal(f.controllers.length, 0);
  f.render().openTransaction('missing');
  assert.equal(f.controllers.length, 0);
  assert.match(f.render().error, /current saved records/);
  f.render().openReport(range);
  assert.equal(f.render().session.snapshot.walletName, 'Latest');
  f.host.unmount();
});
