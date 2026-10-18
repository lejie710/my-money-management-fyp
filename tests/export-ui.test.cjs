const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHookHost, loadTsSource } = require('./helpers/hook-host.cjs');
const { deferred, flush } = require('./helpers/native-adapter-vm.cjs');
const model = require('../src/core/model');
const reports = require('../src/core/reports');
const exportsModel = require('../src/core/exports');
const artifact = {
  id: 'pdf-one',
  ownerToken: 'test-owner',
  kind: 'transaction',
  fileName: 'transaction-one.pdf',
  uri: 'file:///cache/one.pdf',
  byteSize: 1000,
  pageCount: 1,
  createdAtMs: 1,
};
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of (tree.props?.children ?? []).flat(Infinity)) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
const byId = (tree, id) => find(tree, (element) => element.props?.testID === id);
function memoHost() {
  const host = createHookHost();
  host.react.useMemo = (factory, deps) => {
    const memo = host.react.useRef(null);
    if (!memo.current || deps.some((value, i) => !Object.is(value, memo.current.deps[i])))
      memo.current = { deps, value: factory() };
    return memo.current.value;
  };
  host.react.Component = class {
    constructor(props) {
      this.props = props;
    }
  };
  return host;
}
function pdfFixture(overrides = {}) {
  const host = createHookHost(),
    calls = [];
  host.react.useLayoutEffect = host.react.useEffect;
  const services = {
    async prepare(snapshot) {
      calls.push(['prepare', snapshot]);
      return { artifact };
    },
    async share(value) {
      calls.push(['share', value]);
      return { status: 'requested' };
    },
    async preview(value) {
      calls.push(['preview', value]);
      return { status: 'requested' };
    },
    ...overrides,
  };
  const module = loadTsSource(path.join(__dirname, '../src/ui/usePdfExport.ts'), {
    react: host.react,
  });
  let snapshot = Object.freeze({ kind: 'transaction', selection: 'summary' }),
    key = 'owner-one/export-one';
  return {
    host,
    calls,
    services,
    setSnapshot(value) {
      snapshot = value;
    },
    setKey(value) {
      key = value;
    },
    render: () => host.render(() => module.usePdfExport(snapshot, key, services)),
  };
}

test('PDF preparation is explicit, duplicate guarded, and never automatically previews or shares', async () => {
  const work = deferred();
  let count = 0;
  const f = pdfFixture({
    prepare: async () => {
      count++;
      return work.promise;
    },
  });
  const view = f.render();
  const pending = view.prepare();
  await view.prepare();
  await view.share();
  assert.equal(count, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.render().stage, 'preparing');
  work.resolve({ artifact });
  await pending;
  assert.equal(f.render().artifact.id, artifact.id);
  assert.equal(f.render().busy, false);
  assert.match(f.render().message, /PDF created/);
});

test('changing context selection invalidates old PDF sharing until a new artifact is prepared', async () => {
  const f = pdfFixture();
  await f.render().prepare();
  f.setSnapshot(Object.freeze({ kind: 'transaction', selection: 'notes' }));
  const changed = f.render();
  assert.equal(changed.artifact, null);
  assert.match(changed.message, /options changed/);
  await changed.share();
  assert.equal(
    f.calls.some((x) => x[0] === 'share'),
    false,
  );
  await changed.prepare();
  await f.render().share();
  assert.equal(f.calls.at(-1)[0], 'share');
});

test('share completion, unavailability and after-effect errors retain a PDF without delivery or cancellation claims', async () => {
  for (const mode of ['requested', 'unavailable', 'error']) {
    const f = pdfFixture({
      async share() {
        if (mode === 'error') throw Error('Native outcome unknown');
        return { status: mode };
      },
    });
    await f.render().prepare();
    await f.render().share();
    const view = f.render();
    assert.equal(view.artifact.id, artifact.id);
    assert.equal(view.stage, 'idle');
    assert.doesNotMatch(view.message, /sent|delivered|cancelled/i);
    if (mode === 'error') assert.match(view.error, /could not be confirmed/);
    if (mode === 'unavailable') assert.match(view.message, /still ready/);
  }
});

test('known missing PDF clears ready actions and requires deliberate regeneration for share or preview', async () => {
  const { PdfExportError } = require('../src/exports/pdfController');
  for (const action of ['share', 'preview']) {
    const f = pdfFixture({
      [action]: async () => {
        throw new PdfExportError('ARTIFACT_UNAVAILABLE', 'Private cache details');
      },
    });
    await f.render().prepare();
    await f.render()[action]();
    assert.equal(f.render().artifact, null);
    assert.match(f.render().error, /no longer available.*Create it again/);
    assert.doesNotMatch(f.render().error, /Private cache/);
    assert.equal(f.calls.filter((call) => call[0] === 'prepare').length, 1);
    await f.render().prepare();
    assert.equal(f.render().artifact.id, artifact.id);
    assert.equal(f.calls.filter((call) => call[0] === 'prepare').length, 2);
  }
});

test('late missing-file failure cannot clear a replacement session artifact', async () => {
  const pending = deferred();
  const f = pdfFixture({ share: async () => pending.promise });
  await f.render().prepare();
  const old = f.render().share();
  f.setKey('owner-two/export-two');
  await f.render().prepare();
  pending.reject(Object.assign(new Error('Old missing file'), { code: 'ARTIFACT_UNAVAILABLE' }));
  await old;
  assert.equal(f.render().artifact.id, artifact.id);
  assert.equal(f.render().error, '');
});

test('closing or replacing an export session suppresses late generation results', async () => {
  const work = deferred();
  const f = pdfFixture({ prepare: () => work.promise });
  const pending = f.render().prepare();
  f.setKey('owner-two/export-two');
  f.render();
  work.resolve({ artifact });
  await pending;
  assert.equal(f.render().artifact, null);
  assert.equal(f.render().message, '');
  const closed = deferred();
  const other = pdfFixture({ prepare: () => closed.promise });
  const request = other.render().prepare();
  other.host.unmount();
  closed.resolve({ artifact });
  await request;
  assert.equal(
    other.calls.some((x) => x[0] === 'share'),
    false,
  );
});

test('generation errors are retryable and preview is offered only for an implemented capability', async () => {
  let attempt = 0;
  const f = pdfFixture({
    preview: undefined,
    async prepare() {
      if (++attempt === 1) throw Error('Storage unavailable');
      return { artifact, warning: 'Selected photo unavailable; omission is labelled.' };
    },
  });
  await f.render().prepare();
  assert.equal(f.render().artifact, null);
  assert.ok(f.render().error);
  assert.equal(f.render().preview, undefined);
  await f.render().prepare();
  assert.equal(f.render().artifact.id, artifact.id);
  assert.match(f.render().warning, /omission is labelled/);
});

test('old PDF callbacks cannot prepare or share after options or export session replacement', async () => {
  const f = pdfFixture();
  await f.render().prepare();
  const old = f.render();
  f.setSnapshot(Object.freeze({ kind: 'transaction', selection: 'different' }));
  f.render();
  await old.prepare();
  await old.share();
  assert.equal(f.calls.length, 1);
  const beforeSession = f.render();
  f.setKey('new-owner/new-panel');
  f.render();
  await beforeSession.prepare();
  assert.equal(f.calls.length, 1);
  await f.render().prepare();
  assert.equal(f.calls.length, 2);
});

test('report export always uses the applied range even after invalid date edits', () => {
  const host = memoHost(),
    captured = [];
  const module = loadTsSource(path.join(__dirname, '../src/ui/ReportsScreen.tsx'), {
    react: host.react,
    'react-native': {
      Keyboard: { dismiss() {} },
      Pressable: 'Pressable',
      StyleSheet: { create: (value) => value },
      Text: 'Text',
      View: 'View',
    },
    '../core/model': model,
    '../core/reports': reports,
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
  const ledger = model.createDemoLedger();
  const render = () =>
    host.render(() =>
      module.ReportsScreen({
        ledger,
        forecastOwnerKey: 'synthetic-export-owner',
        getForecastToday: () => '2026-10-18',
        onExport: (range) => captured.push(range),
      }),
    );
  let tree = render();
  byId(tree, 'export-report').props.onPress();
  const original = JSON.stringify(captured[0]);
  byId(tree, 'report-period-custom').props.onPress();
  tree = render();
  byId(tree, 'report-start-input').props.onChangeText('invalid');
  tree = render();
  byId(tree, 'apply-report-range').props.onPress();
  tree = render();
  assert.ok(byId(tree, 'report-range-error').props.message);
  byId(tree, 'export-report').props.onPress();
  assert.equal(JSON.stringify(captured.at(-1)), original);
  byId(tree, 'report-start-input').props.onChangeText('2026-10-01');
  tree = render();
  byId(tree, 'report-end-input').props.onChangeText('2026-10-31');
  tree = render();
  byId(tree, 'apply-report-range').props.onPress();
  tree = render();
  byId(tree, 'export-report').props.onPress();
  assert.equal(
    JSON.stringify(captured.at(-1)),
    JSON.stringify({ startDate: '2026-10-01', endDate: '2026-10-31' }),
  );
});

function qrFixture(notes = 'Private note') {
  const host = memoHost();
  const ledger = model.createDemoLedger();
  const row = ledger.transactions[0];
  row.context = {
    notes,
    photo: null,
    withPerson: { name: 'Selected person', source: 'manual' },
    location: null,
  };
  const source = exportsModel.captureTransactionExportSource(ledger, row.id, 1);
  const module = loadTsSource(path.join(__dirname, '../src/ui/TransactionQrPanel.tsx'), {
    react: host.react,
    'react-native': { Text: 'Text', View: 'View', useWindowDimensions: () => ({ width: 360 }) },
    '../core/model': model,
    '../core/exports': exportsModel,
    './components': { Action: 'Action', FormError: 'FormError' },
    './theme': { ui: {} },
    './ExportContextOptions': { ExportContextOptions: 'Options', SelectedExportDetails: 'Details' },
  });
  const render = () =>
    host.render(() => module.TransactionQrPanel({ source, renderQr: () => null }));
  return { render, source };
}

test('QR starts hidden with detail choices off, and changing choices hides previously displayed data', () => {
  const { render } = qrFixture();
  let tree = render();
  assert.equal(byId(tree, 'transaction-qr-panel'), null);
  let options = find(tree, (item) => item.type === 'Options');
  assert.equal(Object.values(options.props.selection).some(Boolean), false);
  byId(tree, 'toggle-transaction-qr').props.onPress();
  tree = render();
  assert.ok(byId(tree, 'transaction-qr-panel'));
  options = find(tree, (item) => item.type === 'Options');
  options.props.onChange({ ...options.props.selection, notes: true });
  tree = render();
  assert.equal(byId(tree, 'transaction-qr-panel'), null);
  byId(tree, 'toggle-transaction-qr').props.onPress();
  tree = render();
  assert.ok(byId(tree, 'transaction-qr-panel'));
});

test('oversized optional QR text offers an explicit untruncated summary and encoder failure can be retried', () => {
  const { render } = qrFixture('Long note '.repeat(190));
  let tree = render();
  const options = find(tree, (item) => item.type === 'Options');
  options.props.onChange({ ...options.props.selection, notes: true });
  tree = render();
  byId(tree, 'toggle-transaction-qr').props.onPress();
  tree = render();
  assert.ok(byId(tree, 'qr-too-large'));
  assert.equal(byId(tree, 'transaction-qr-panel'), null);
  byId(tree, 'qr-show-summary').props.onPress();
  tree = render();
  assert.ok(byId(tree, 'transaction-qr-panel'));
  assert.equal(find(tree, (item) => item.type === 'Options').props.selection.notes, false);
  const boundary = find(tree, (item) => item.type?.name === 'QrBoundary');
  boundary.props.onError();
  tree = render();
  assert.equal(byId(tree, 'transaction-qr-panel'), null);
  assert.ok(byId(tree, 'transaction-qr-error').props.message);
  byId(tree, 'toggle-transaction-qr').props.onPress();
  tree = render();
  assert.ok(byId(tree, 'transaction-qr-panel'));
});
