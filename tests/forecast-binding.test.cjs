const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHookHost, loadTsSource } = require('./helpers/hook-host.cjs');
const model = require('../src/core/model');
const reports = require('../src/core/reports');

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  if (typeof tree.type === 'function') return find(tree.type(tree.props), predicate);
  for (const child of (tree.props?.children ?? []).flat(Infinity)) {
    const value = find(child, predicate);
    if (value) return value;
  }
  return null;
}
const byId = (tree, id) => find(tree, (node) => node.props?.testID === id);
const native = {
  ActivityIndicator: 'ActivityIndicator',
  Image: 'Image',
  Pressable: 'Pressable',
  StatusBar: 'StatusBar',
  Text: 'Text',
  View: 'View',
  Platform: { OS: 'android' },
  StyleSheet: { create: (value) => value },
  Keyboard: { dismiss() {} },
  BackHandler: { addEventListener: () => ({ remove() {} }) },
};

test('actual App binds forecast Reports to the full confirmed owner and injected clock, preserving assistant/export actions', () => {
  const host = createHookHost();
  const ledger = model.createDemoLedger(new Date(2026, 9, 18));
  const events = [];
  const account = {
    finance: {
      ledger,
      ownerToken: 'test/scope/firebase/A/incarnation',
      loading: false,
      loadError: false,
      saving: false,
      saveError: '',
      status: '',
      clearSaveError() {},
      getClock: () => ({ today: '2026-10-18', nowMs: 1792296000000 }),
    },
    photos: {},
    reminders: {},
    companion: {},
    exports: {
      close: () => events.push('export-close'),
      openReport: (range) => events.push(['export', range]),
    },
    assistant: {
      close: () => events.push('assistant-close'),
      open: (range) => events.push(['assistant', range]),
    },
    receipts: { hasOpenDraft: () => false, close: async () => {} },
    financialAllowed: true,
    accountState: { busy: false, user: null },
    gateState: {},
    controller: {},
  };
  const imports = {
    react: host.react,
    'react-native': native,
    './src/ui/useAccountRoot': { useAccountRoot: () => account },
    './src/ui/components': { Action: 'Action', FormError: 'FormError', Sheet: 'Sheet' },
    './src/ui/theme': require('./helpers/theme-stub.cjs').themeStub,
    './src/ui/ThemeProvider': { ThemeProvider: 'ThemeProvider' },
    './src/ui/AppIcon': { AppIcon: 'AppIcon' },
    './src/ui/useCloudBackup': { useCloudBackup: () => ({ controller: Object.freeze({}) }) },
    './src/ui/CloudWalletScreen': { CloudWalletScreen: 'CloudWalletScreen' },
    './src/drafts/transactionDrafts': require('../src/drafts/transactionDrafts'),
    './src/ui/CloudBackupScreen': { CloudBackupScreen: 'CloudBackupScreen' },
    './src/ui/TransactionEditor': {
      TransactionEditor: 'TransactionEditor',
      newId: () => 'synthetic-editor',
    },
    './src/ui/AccountScreen': {
      AccountScreen: 'AccountScreen',
      WalletAccountEntry: 'WalletAccountEntry',
    },
    './src/ui/AccountAccessGate': {
      AccountAccessGate: 'AccountAccessGate',
      canShowAccountWallet: loadTsSource(path.join(__dirname, '../src/ui/AccountAccessGate.tsx'), {
        react: host.react,
        'react-native': native,
        './components': { Action: 'Action' },
        './theme': require('./helpers/theme-stub.cjs').themeStub,
      }).canShowAccountWallet,
    },
    './legacy/assets/images/money.png': 0,
  };
  for (const name of [
    'CategoriesScreen',
    'TransactionsScreen',
    'WalletScreen',
    'PlanScreen',
    'ReportsScreen',
    'LoanCalculatorScreen',
    'AchievementsScreen',
    'RemindersScreen',
    'MapPlacePicker',
    'ReportExportSheet',
    'TransactionExportSheet',
    'NativeTransactionQr',
    'ReceiptEntry',
    'ReceiptCaptureSheet',
    'AssistantPanel',
    'ConnectionsScreen',
  ])
    imports[`./src/ui/${name}`] = { [name]: name };
  const App = loadTsSource(path.join(__dirname, '../App.tsx'), imports).AppContent;
  const render = () => host.render(App);
  byId(render(), 'tab-reports').props.onPress();
  let screen = find(render(), (node) => node.type === 'ReportsScreen');
  assert.equal(screen.props.forecastOwnerKey, account.finance.ownerToken);
  assert.equal(screen.props.key, account.finance.ownerToken);
  assert.equal(screen.props.getForecastToday(), '2026-10-18');
  events.length = 0; // Tab navigation legitimately closes earlier export/chat views.
  const range = { startDate: '2026-10-01', endDate: '2026-10-31' };
  screen.props.onExport(range);
  screen.props.onAssistant(range);
  assert.deepEqual(events, [
    'assistant-close',
    ['export', range],
    'export-close',
    ['assistant', range],
  ]);
  account.financialAllowed = false;
  assert.equal(
    find(render(), (node) => node.type === 'ReportsScreen'),
    null,
  );
  account.financialAllowed = true;
  account.finance.ownerToken = null;
  assert.equal(
    find(render(), (node) => node.type === 'ReportsScreen'),
    null,
  );
  account.finance.ownerToken = 'test/scope/firebase/B/incarnation';
  screen = find(render(), (node) => node.type === 'ReportsScreen');
  assert.equal(screen.props.key, account.finance.ownerToken);
  assert.equal(screen.props.forecastOwnerKey, account.finance.ownerToken);
  // Resolve current identity directly, without rendering again between a change
  // and the transport continuation. A stale React projection is insufficient.
  const identity = {
    ownerToken: account.finance.ownerToken,
    ledger,
    bindingToken: {},
    identityPending: false,
    writeInFlight: false,
    uncertain: false,
  };
  let liveView = {
    phase: 'ready',
    persistence: 'confirmed',
    activeOwnerToken: identity.ownerToken,
  };
  account.finance.getIdentityState = () => identity;
  account.controller.getSnapshot = () => liveView;
  const providers = require('../src/companion/providerContract').validateProviders({
    ocr: null,
    assistant: null,
    forecast: {
      engine: 'prophet',
      processing: 'local',
      version: 'recorded-expense-prophet-v1',
      maxHistoryMonths: 120,
    },
  });
  const binding = {
    key: {},
    providers,
    forecast: async () => {
      throw Error('No request is expected in this binding test.');
    },
  };
  account.companion = { phase: 'configured', binding, getCurrent: () => account.companion };
  screen = find(render(), (node) => node.type === 'ReportsScreen');
  const current = screen.props.forecastTransportBinding.isCurrent;
  assert.equal(current(), true);
  for (const field of ['identityPending', 'writeInFlight', 'uncertain']) {
    identity[field] = true;
    assert.equal(current(), false);
    identity[field] = false;
  }
  const savedBinding = identity.bindingToken;
  identity.bindingToken = {};
  assert.equal(current(), false);
  identity.bindingToken = savedBinding;
  identity.ledger = { ...ledger };
  assert.equal(current(), false);
  identity.ledger = ledger;
  const savedOwner = identity.ownerToken;
  identity.ownerToken = 'different-owner';
  assert.equal(current(), false);
  identity.ownerToken = savedOwner;
  liveView = { ...liveView, phase: 'switching' };
  assert.equal(current(), false);
  liveView = { ...liveView, phase: 'ready' };
  assert.equal(current(), true);
  account.companion.binding = { ...binding };
  assert.equal(current(), false);
  host.unmount();
});

test('actual Reports preserves applied export/assistant range while forecast receives its independent explicit date and owner', () => {
  const host = createHookHost();
  host.react.useMemo = (factory) => factory();
  const events = [];
  const getToday = () => '2026-10-18';
  const props = {
    ledger: model.createDemoLedger(new Date(2026, 9, 18)),
    forecastOwnerKey: 'full-owner-A',
    getForecastToday: getToday,
    onExport: (range) => events.push(['export', range]),
    onAssistant: (range) => events.push(['assistant', range]),
  };
  const ReportsScreen = loadTsSource(path.join(__dirname, '../src/ui/ReportsScreen.tsx'), {
    react: host.react,
    'react-native': native,
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
    './theme': require('./helpers/theme-stub.cjs').themeStub,
    './HealthPanel': { HealthPanel: 'HealthPanel' },
    './ForecastEntry': { ForecastEntry: 'ForecastEntry' },
  }).ReportsScreen;
  const render = () => host.render(() => ReportsScreen(props));
  byId(render(), 'report-period-custom').props.onPress();
  byId(render(), 'report-start-input').props.onChangeText('2026-10-01');
  byId(render(), 'report-end-input').props.onChangeText('2026-10-31');
  byId(render(), 'apply-report-range').props.onPress();
  byId(render(), 'report-start-input').props.onChangeText('invalid');
  byId(render(), 'export-report').props.onPress();
  byId(render(), 'open-report-assistant').props.onPress();
  const expected = { startDate: '2026-10-01', endDate: '2026-10-31' };
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    ['export', expected],
    ['assistant', expected],
  ]);
  const entry = find(render(), (node) => node.type === 'ForecastEntry');
  assert.equal(entry.props.ownerKey, 'full-owner-A');
  assert.equal(entry.props.getToday, getToday);
  assert.equal(entry.props.getToday(), '2026-10-18');
  assert.equal(entry.props.ledger, props.ledger);
  assert.equal(Object.hasOwn(entry.props, 'onSave'), false);
  host.unmount();
});
