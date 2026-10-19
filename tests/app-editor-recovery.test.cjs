const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHookHost, loadTsSource } = require('./helpers/hook-host.cjs');

function find(element, type) {
  if (!element || typeof element !== 'object') return null;
  if (element.type === type) return element;
  for (const child of (element.props?.children ?? []).flat(Infinity)) {
    const found = find(child, type);
    if (found) return found;
  }
  return null;
}

test('an uncertain save and same-incarnation restore cannot reopen a stale captured transaction editor', () => {
  const host = createHookHost();
  const initial = { id: 'transaction-one', title: 'Before save' };
  const state = {
    ledger: { mode: 'local', wallet: { incarnationId: 'wallet-one' }, transactions: [initial] },
    loading: false,
    loadError: false,
    saving: false,
    saveError: '',
    status: '',
    save: async () => false,
    restore: async () => {},
    clearSaveError() {},
    getClock() {},
    registerTransitionGuard() {},
    registerCommitObserver() {},
  };
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
    './src/ui/useLedger': { useLedger: () => state },
    './src/ui/useAccountRoot': {
      useAccountRoot: () => ({
        finance: { ...state, ownerToken: 'test-owner' },
        photos: { familyToken: 'test-local', photos: null, services: null, onCleanupMessage() {} },
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
        exports: { session: null, error: '', close() {}, openReport() {}, openTransaction() {} },
        accountState: { busy: false, user: null },
        gateState: {},
        financialAllowed: !state.loading && !state.loadError,
        controller: { retry: state.restore },
      }),
    },
    './src/ui/AccountAccessGate': { AccountAccessGate: 'AccountAccessGate' },
    './src/ui/AccountScreen': {
      AccountScreen: 'AccountScreen',
      WalletAccountEntry: 'WalletAccountEntry',
    },
    './src/ui/useWalletPhotos': {
      useWalletPhotos: () => ({
        familyToken: 'test-local',
        photos: null,
        services: null,
        onCleanupMessage() {},
      }),
    },
    './src/ui/useWalletReminders': { useWalletReminders: () => ({}) },
    './src/ui/theme': require('./helpers/theme-stub.cjs').themeStub,
    './src/ui/ThemeProvider': { ThemeProvider: 'ThemeProvider' },
    './src/ui/components': { Action: 'Action', FormError: 'FormError', Sheet: 'Sheet' },
    './src/ui/AppIcon': { AppIcon: 'AppIcon' },
    './src/ui/useCloudBackup': { useCloudBackup: () => ({ controller: Object.freeze({}) }) },
    './src/ui/CloudWalletScreen': { CloudWalletScreen: 'CloudWalletScreen' },
    './src/drafts/transactionDrafts': require('../src/drafts/transactionDrafts'),
    './src/ui/CloudBackupScreen': { CloudBackupScreen: 'CloudBackupScreen' },
    './src/ui/useExportSession': {
      useExportSession: () => ({
        session: null,
        error: '',
        close() {},
        openReport() {},
        openTransaction() {},
      }),
    },
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
  const render = () => host.render(App);
  let tree = render();
  const activity = find(tree, 'TransactionsScreen');
  assert.ok(activity);
  activity.props.onEdit(initial);
  tree = render();
  assert.equal(find(tree, 'TransactionEditor').props.transaction.title, 'Before save');
  state.loadError = true;
  tree = render();
  assert.equal(find(tree, 'TransactionEditor'), null);
  const recovered = { ...initial, title: 'Actual stored row after recovery' };
  state.ledger = { ...state.ledger, transactions: [recovered] };
  state.loading = true;
  state.loadError = false;
  render();
  state.loading = false;
  tree = render();
  assert.equal(find(tree, 'TransactionEditor'), null);
  find(tree, 'TransactionsScreen').props.onEdit(recovered);
  tree = render();
  assert.equal(find(tree, 'TransactionEditor').props.transaction.title, recovered.title);
});
