const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const { createHookHost, loadTsSource } = require('./helpers/hook-host.cjs');
const model = require('../src/core/model'),
  exportsModel = require('../src/core/exports'),
  ownerCore = require('../src/reminders/store');
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of (node.props?.children ?? []).flat(Infinity)) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
function fixture() {
  const host = createHookHost();
  host.react.useLayoutEffect = host.react.useEffect;
  host.react.useMemo = (factory, deps) => {
    const ref = host.react.useRef(null);
    if (!ref.current || deps.some((value, index) => !Object.is(value, ref.current.deps[index])))
      ref.current = { deps, value: factory() };
    return ref.current.value;
  };
  const controllers = [],
    state = {
      ledger: model.createDemoLedger(new Date(2026, 9, 18)),
      loading: false,
      loadError: false,
      saving: false,
      saveError: '',
      status: '',
      save: async () => true,
      restore: async () => {},
      clearSaveError() {},
      getClock() {},
      registerTransitionGuard() {},
      registerCommitObserver() {},
    };
  const photos = { familyToken: 'test-export-family' },
    scope = { kind: 'test', namespace: 'app-export' },
    hook = loadTsSource(path.join(__dirname, '../src/ui/useExportSession.ts'), {
      react: host.react,
      '@react-native-async-storage/async-storage': {},
      '../core/exports': exportsModel,
      '../reminders/store': ownerCore,
      '../exports/expoPdfAdapter': {
        createExpoPdfServices(options) {
          const value = {
            options,
            closed: 0,
            close() {
              value.closed++;
            },
          };
          controllers.push(value);
          return value;
        },
      },
    });
  let onNotification;
  const imports = {
    react: host.react,
    'react-native': {
      ActivityIndicator: 'ActivityIndicator',
      Image: 'Image',
      Pressable: 'Pressable',
      StatusBar: 'StatusBar',
      Text: 'Text',
      View: 'View',
      Platform: { OS: 'android' },
      StyleSheet: { create: (value) => value },
      BackHandler: { addEventListener: () => ({ remove() {} }) },
    },
    './src/ui/useLedger': { useLedger: () => state, localLedgerScope: scope },
    './src/ui/useAccountRoot': {
      useAccountRoot(options) {
        const owner = {
          scope,
          actor: { kind: 'local' },
          incarnationId: state.ledger.wallet.incarnationId,
        };
        const exports = hook.useExportSession({
          ledger: state.ledger,
          owner,
          active: !state.loading && !state.loadError,
          photos,
        });
        onNotification = (data) => {
          exports.close();
          options.closeEditor();
          options.onReminderOpen(data);
        };
        return {
          finance: { ...state, ownerToken: ownerCore.encodeReminderOwner(owner) },
          photos: { photos, familyToken: photos.familyToken },
          reminders: {},
          assistant: { panel: null, error: '', open() {}, close() {}, closeCurrent() {} },
          companion: { phase: 'disabled', binding: null, enabled: false, recheck: async () => {} },
          receipts: {
            session: null,
            error: '',
            cleanupPending: false,
            hasOpenDraft: () => false,
            close: async () => {},
            closeCurrent: async () => {},
            open() {},
            retryCleanup: async () => {},
          },
          exports,
          accountState: { busy: false, user: null },
          gateState: {},
          financialAllowed: !state.loading && !state.loadError,
          controller: { retry: state.restore },
        };
      },
    },
    './src/ui/AccountAccessGate': { AccountAccessGate: 'AccountAccessGate' },
    './src/ui/AccountScreen': {
      AccountScreen: 'AccountScreen',
      WalletAccountEntry: 'WalletAccountEntry',
    },
    './src/ui/useWalletPhotos': {
      useWalletPhotos: () => ({ photos, familyToken: photos.familyToken }),
    },
    './src/ui/useWalletReminders': {
      useWalletReminders(options) {
        onNotification = options.onOpen;
        return {};
      },
    },
    './src/ui/useExportSession': hook,
    './src/ui/components': { Action: 'Action', FormError: 'FormError', Sheet: 'Sheet' },
    './src/ui/AppIcon': { AppIcon: 'AppIcon' },
    './src/ui/useCloudBackup': { useCloudBackup: () => ({ controller: Object.freeze({}) }) },
    './src/ui/CloudWalletScreen': { CloudWalletScreen: 'CloudWalletScreen' },
    './src/drafts/transactionDrafts': require('../src/drafts/transactionDrafts'),
    './src/ui/CloudBackupScreen': { CloudBackupScreen: 'CloudBackupScreen' },
    './src/ui/theme': require('./helpers/theme-stub.cjs').themeStub,
    './src/ui/ThemeProvider': { ThemeProvider: 'ThemeProvider' },
    './src/ui/TransactionEditor': {
      TransactionEditor: 'TransactionEditor',
      newId: () => 'editor-test',
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
  return {
    host,
    state,
    controllers,
    render: () => host.render(App),
    notify: () => onNotification({ kind: 'achievement' }),
  };
}
test('actual App binds Details & share to captured transaction and clears export on recovery and notification navigation', () => {
  const f = fixture();
  let tree = f.render();
  find(tree, (node) => node.type === 'TransactionsScreen').props.onShare(
    f.state.ledger.transactions[0],
  );
  tree = f.render();
  const sheet = find(tree, (node) => node.type === 'TransactionExportSheet');
  assert.ok(sheet);
  assert.equal(sheet.props.source.title, f.state.ledger.transactions[0].title);
  assert.equal(f.controllers[0].options.isCurrent(), true);
  f.state.loadError = true;
  tree = f.render();
  assert.equal(
    find(tree, (node) => node.type === 'TransactionExportSheet'),
    null,
  );
  assert.equal(f.controllers[0].closed, 1);
  assert.equal(f.controllers[0].options.isCurrent(), false);
  f.state.loadError = false;
  tree = f.render();
  assert.equal(
    find(tree, (node) => node.type === 'TransactionExportSheet'),
    null,
  );
  find(tree, (node) => node.type === 'TransactionsScreen').props.onShare(
    f.state.ledger.transactions[0],
  );
  f.render();
  f.notify();
  tree = f.render();
  assert.equal(
    find(tree, (node) => node.type === 'TransactionExportSheet'),
    null,
  );
  assert.equal(f.controllers[1].closed, 1);
  assert.ok(find(tree, (node) => node.type === 'AchievementsScreen'));
  f.host.unmount();
});
test('actual App report export preserves applied range and explicit close releases its controller', () => {
  const f = fixture();
  let tree = f.render();
  find(tree, (node) => node.props?.testID === 'tab-reports').props.onPress();
  tree = f.render();
  find(tree, (node) => node.type === 'ReportsScreen').props.onExport({
    startDate: '2026-10-01',
    endDate: '2026-10-31',
  });
  tree = f.render();
  const sheet = find(tree, (node) => node.type === 'ReportExportSheet');
  assert.ok(sheet);
  assert.equal(sheet.props.snapshot.startDate, '2026-10-01');
  sheet.props.onClose();
  tree = f.render();
  assert.equal(
    find(tree, (node) => node.type === 'ReportExportSheet'),
    null,
  );
  assert.equal(f.controllers[0].closed, 1);
  f.host.unmount();
});
test('QR runtime import is deferred until the explicit QR component is rendered', () => {
  const host = createHookHost();
  let loads = 0;
  const imports = { react: host.react };
  Object.defineProperty(imports, 'react-native-qrcode-svg', {
    get() {
      loads++;
      return { default: 'QRCode' };
    },
  });
  const module = loadTsSource(path.join(__dirname, '../src/ui/NativeTransactionQr.tsx'), imports);
  assert.equal(loads, 0);
  const node = module.NativeTransactionQr({
    value: 'synthetic-summary',
    size: 200,
    quietZone: 40,
    ecl: 'M',
    color: '#000000',
    backgroundColor: '#FFFFFF',
    onError() {},
  });
  assert.equal(loads, 1);
  assert.equal(node.type, 'QRCode');
  assert.equal(node.props.testID, 'transaction-qr-svg');
  assert.equal(node.props.quietZone, 40);
});
