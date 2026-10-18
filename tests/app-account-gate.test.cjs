const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const { fixture } = require('./helpers/account-bridge-harness.cjs');
const { hostWithStores, loadSource } = require('./helpers/account-hook-harness.cjs');
async function appFixture() {
  const f = fixture();
  await f.runtime.initializeView();
  const host = hostWithStores();
  const native = {
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
    Pressable: 'Pressable',
    StatusBar: 'StatusBar',
    Text: 'Text',
    View: 'View',
    Platform: { OS: 'android' },
    StyleSheet: { create: (value) => value },
    BackHandler: { addEventListener: () => ({ remove() {} }) },
  };
  const gate = loadSource(path.join(__dirname, '../src/ui/AccountAccessGate.tsx'), {
    react: host.react,
    'react-native': native,
    './components': { Action: 'Action', FormError: 'FormError', Sheet: 'Sheet' },
    './theme': { colors: {}, ui: {} },
  });
  const state = f.runtime.presentation.getSnapshot(),
    account = {
      finance: f.binding.ledger,
      photos: { ...f.binding.photos, services: null },
      reminders: {},
      exports: { session: null, error: '', close() {}, openReport() {}, openTransaction() {} },
      accountState: state,
      gateState: state,
      financialAllowed: true,
      controller: f.runtime.presentation,
    };
  let rootOptions;
  let assistantSessionSequence = 0;
  account.assistant = {
    panel: null,
    error: '',
    open(range) {
      this.panel = {
        ledger: account.finance.ledger,
        actorKey: 'synthetic-full-owner',
        sessionKey: `chat-${++assistantSessionSequence}`,
        initialRange: range,
      };
    },
    close() {
      this.panel = null;
    },
    closeCurrent() {
      this.close();
    },
  };
  account.companion = {
    phase: 'configured',
    revision: 0,
    binding: {
      key: Object.freeze({}),
      receipt: {
        recognize: async () => {
          throw Error('Unexpected OCR call in App navigation test.');
        },
      },
      assistant: async () => {
        throw Error('Unexpected assistant request in App navigation test.');
      },
      forecast: null,
      providers: require('../src/companion/providerContract').LEGACY_PROVIDERS,
    },
    message: 'Not configured',
    enabled: true,
    recheck: async () => {},
  };
  let receiptOpen = false;
  account.receipts = {
    session: null,
    error: '',
    cleanupPending: false,
    cleanupMessage: '',
    hasOpenDraft: () => receiptOpen,
    open() {
      receiptOpen = true;
      this.session = { binding: { sessionKey: 'synthetic-full-owner' } };
    },
    close() {
      receiptOpen = false;
      this.session = null;
      return Promise.resolve();
    },
    closeCurrent() {
      return this.close();
    },
    retryCleanup: async () => {},
  };
  const imports = {
    react: host.react,
    'react-native': native,
    './src/ui/useAccountRoot': {
      useAccountRoot: (options) => {
        rootOptions = options;
        return account;
      },
    },
    './src/ui/AccountAccessGate': gate,
    './src/ui/AccountScreen': {
      AccountScreen: 'AccountScreen',
      WalletAccountEntry: 'WalletAccountEntry',
    },
    './src/ui/components': { Action: 'Action', FormError: 'FormError', Sheet: 'Sheet' },
    './src/ui/theme': { colors: {}, ui: {} },
    './src/ui/AppIcon': { AppIcon: 'AppIcon' },
    './src/ui/useCloudBackup': { useCloudBackup: () => ({ controller: Object.freeze({}) }) },
    './src/ui/CloudBackupScreen': { CloudBackupScreen: 'CloudBackupScreen' },
    './src/ui/TransactionEditor': { TransactionEditor: 'TransactionEditor', newId: () => 'editor' },
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
  const App = loadSource(path.join(__dirname, '../App.tsx'), imports).default;
  function find(node, predicate) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === gate.AccountAccessGate)
      return find(gate.AccountAccessGate(node.props), predicate);
    if (predicate(node)) return node;
    for (const child of (node.props?.children ?? []).flat(Infinity)) {
      const found = find(child, predicate);
      if (found) return found;
    }
    return null;
  }
  return {
    account,
    render: () => host.render(App),
    find,
    host,
    get rootOptions() {
      return rootOptions;
    },
  };
}
test('actual staged App excludes old financial children while leaving Account recovery reachable outside the gate', async () => {
  const f = await appFixture();
  assert.ok(f.find(f.render(), (node) => node.type === 'TransactionsScreen'));
  f.account.financialAllowed = false;
  f.account.gateState = {
    ...f.account.accountState,
    phase: 'wallet-unavailable',
    activeOwnerToken: null,
    message: 'Synthetic target unavailable',
  };
  let tree = f.render();
  assert.equal(
    f.find(tree, (node) => node.type === 'TransactionsScreen'),
    null,
  );
  assert.equal(
    f.find(tree, (node) => node.type === 'WalletScreen'),
    null,
  );
  assert.ok(f.find(tree, (node) => node.props?.testID === 'account-access-gate'));
  f.find(tree, (node) => node.props?.testID === 'open-account-recovery').props.onPress();
  tree = f.render();
  assert.ok(f.find(tree, (node) => node.type === 'AccountScreen'));
  assert.equal(
    f.find(tree, (node) => node.type === 'TransactionsScreen'),
    null,
  );
  f.host.unmount();
});

test('ordinary wallet hides unconfigured shortcuts but keeps every optional tool reachable through Connections', async () => {
  const f = await appFixture();
  f.account.accountState = { ...f.account.accountState, provider: 'unconfigured', user: null };
  f.account.companion = { ...f.account.companion, phase: 'disabled', enabled: false };
  let tree = f.render();
  assert.ok(f.find(tree, (node) => node.props?.testID === 'open-header-wallet'));
  assert.equal(
    f.find(tree, (node) => node.props?.testID === 'open-header-account'),
    null,
  );
  assert.equal(
    f.find(tree, (node) => node.type === 'TransactionsScreen').props.receiptTools,
    undefined,
  );
  f.find(tree, (node) => node.props?.testID === 'tab-reports').props.onPress();
  tree = f.render();
  assert.equal(
    f.find(tree, (node) => node.type === 'ReportsScreen').props.showAssistantShortcut,
    false,
  );
  f.find(tree, (node) => node.props?.testID === 'tab-wallet').props.onPress();
  tree = f.render();
  const wallet = f.find(tree, (node) => node.type === 'WalletScreen');
  assert.equal(wallet.props.showAccountShortcut, false);
  wallet.props.onOpenConnections();
  tree = f.render();
  const connections = f.find(tree, (node) => node.type === 'ConnectionsScreen');
  assert.equal(connections.props.accountState, f.account.accountState);
  assert.equal(connections.props.connection, f.account.companion);
  connections.props.onReceipt();
  tree = f.render();
  assert.ok(f.find(tree, (node) => node.type === 'ReceiptCaptureSheet'));
  f.account.receipts.close();
  connections.props.onReports();
  tree = f.render();
  const report = f.find(tree, (node) => node.type === 'ReportsScreen');
  assert.equal(report.props.showAssistantShortcut, true);
  assert.equal(f.account.assistant.panel, null);
  const range = { startDate: '2026-10-02', endDate: '2026-10-20' };
  report.props.onAssistant(range);
  assert.deepEqual(f.account.assistant.panel.initialRange, range);
  assert.equal(f.account.assistant.panel.onSave, undefined);
  f.host.unmount();
});

test('configured services add core shortcuts while unconfigured Connections retains manual entry', async () => {
  const f = await appFixture();
  f.account.accountState = { ...f.account.accountState, provider: 'configured' };
  let tree = f.render();
  assert.ok(f.find(tree, (node) => node.props?.testID === 'open-header-account'));
  assert.equal(
    f.find(tree, (node) => node.type === 'TransactionsScreen').props.receiptTools.props.compact,
    true,
  );
  f.find(tree, (node) => node.props?.testID === 'tab-wallet').props.onPress();
  tree = f.render();
  f.find(tree, (node) => node.type === 'WalletScreen').props.onOpenConnections();
  tree = f.render();
  f.find(tree, (node) => node.type === 'ConnectionsScreen').props.onManualEntry();
  tree = f.render();
  assert.ok(f.find(tree, (node) => node.type === 'TransactionsScreen'));
  assert.equal(
    f.find(tree, (node) => node.type === 'TransactionEditor').props.transaction,
    undefined,
  );
  f.host.unmount();
});

test('header suppresses exact idle messages while retaining action and recovery feedback', async () => {
  const f = await appFixture();
  for (const status of [
    'Saved records are ready.',
    'Your wallet is ready.',
    'Sample transactions loaded. Try adding or editing an entry.',
  ]) {
    f.account.finance = { ...f.account.finance, status };
    assert.equal(
      f.find(f.render(), (node) => node.props?.testID === 'save-status'),
      null,
    );
  }
  for (const status of [
    'Expense saved on this device.',
    'Saved data was migrated.',
    'The save was confirmed by reopening the stored records.',
  ]) {
    f.account.finance = { ...f.account.finance, status };
    const message = f.find(f.render(), (node) => node.props?.testID === 'save-status');
    assert.ok(message);
    assert.ok(message.props.children.includes(status));
  }
  f.host.unmount();
});
test('Wallet Account entry uses the projected controller context and keeps the existing four-tab navigation', async () => {
  const f = await appFixture();
  let tree = f.render();
  f.find(tree, (node) => node.props?.testID === 'tab-wallet').props.onPress();
  tree = f.render();
  const wallet = f.find(tree, (node) => node.type === 'WalletScreen');
  assert.ok(wallet);
  assert.equal(wallet.props.accountEntry.type, 'WalletAccountEntry');
  assert.equal(wallet.props.accountEntry.props.state, f.account.accountState);
  wallet.props.accountEntry.props.onOpen();
  tree = f.render();
  assert.equal(
    f.find(tree, (node) => node.type === 'AccountScreen').props.controller,
    f.account.controller,
  );
  f.host.unmount();
});

test('hidden open transaction has an explicit recovery action that clears its ref before rechecking', async () => {
  const f = await appFixture();
  let tree = f.render();
  f.find(tree, (node) => node.type === 'TransactionsScreen').props.onAdd();
  f.render();
  assert.equal(f.rootOptions.hasOpenEditor(), true);
  f.account.financialAllowed = false;
  f.account.gateState = {
    ...f.account.accountState,
    phase: 'session-unavailable',
    activeOwnerToken: null,
  };
  tree = f.render();
  assert.equal(
    f.find(tree, (node) => node.type === 'TransactionEditor'),
    null,
  );
  f.find(tree, (node) => node.props?.testID === 'open-account-recovery').props.onPress();
  tree = f.render();
  assert.ok(f.find(tree, (node) => node.type === 'AccountScreen'));
  let retries = 0;
  f.account.controller = {
    ...f.account.controller,
    async retry() {
      retries++;
      assert.equal(f.rootOptions.hasOpenEditor(), false);
      return { ok: false, pending: true, message: 'Recheck pending' };
    },
  };
  tree = f.render();
  f.find(tree, (node) => node.props?.testID === 'account-discard-draft-recheck').props.onPress();
  tree = f.render();
  assert.equal(retries, 1);
  assert.equal(f.rootOptions.hasOpenEditor(), false);
  assert.equal(
    f.find(tree, (node) => node.props?.testID === 'account-discard-draft-recheck'),
    null,
  );
  assert.equal(
    f.find(tree, (node) => node.type === 'TransactionEditor'),
    null,
  );
  f.host.unmount();
});

test('receipt entry passes normal SaveLedger and no provenance helper; manual fallback opens empty ordinary editor', async () => {
  const f = await appFixture();
  let tree = f.render();
  const activity = f.find(tree, (node) => node.type === 'TransactionsScreen');
  assert.equal(activity.props.receiptTools.type, 'ReceiptEntry');
  activity.props.receiptTools.props.onOpen();
  tree = f.render();
  const sheet = f.find(tree, (node) => node.type === 'ReceiptCaptureSheet');
  assert.ok(sheet);
  assert.equal(sheet.props.onSave, f.account.finance.save);
  assert.equal(sheet.props.prepareReceiptOrigin, undefined);
  sheet.props.onManualEntry();
  tree = f.render();
  assert.equal(f.account.receipts.hasOpenDraft(), false);
  const editor = f.find(tree, (node) => node.type === 'TransactionEditor');
  assert.ok(editor);
  assert.equal(editor.props.transaction, undefined);
  f.host.unmount();
});
test('hidden receipt recovery stays reachable on Account page and clears the blocker synchronously before retry', async () => {
  const f = await appFixture();
  f.account.receipts.open();
  f.account.financialAllowed = false;
  f.account.gateState = {
    ...f.account.accountState,
    phase: 'session-unavailable',
    activeOwnerToken: null,
  };
  let tree = f.render();
  assert.equal(
    f.find(tree, (node) => node.type === 'ReceiptCaptureSheet'),
    null,
  );
  f.find(tree, (node) => node.props?.testID === 'open-account-recovery').props.onPress();
  let retries = 0;
  f.account.controller = {
    ...f.account.controller,
    async retry() {
      assert.equal(f.account.receipts.hasOpenDraft(), false);
      retries++;
      return { ok: false, pending: true };
    },
  };
  tree = f.render();
  assert.ok(f.find(tree, (node) => node.type === 'AccountScreen'));
  f.find(tree, (node) => node.props?.testID === 'account-discard-receipt-recheck').props.onPress();
  assert.equal(retries, 1);
  assert.equal(
    f.find(f.render(), (node) => node.props?.testID === 'account-discard-receipt-recheck'),
    null,
  );
  f.host.unmount();
});
test('receipt cleanup retry is reachable without opening another image and navigation closes capture', async () => {
  const f = await appFixture();
  let retries = 0;
  f.account.receipts.cleanupPending = true;
  f.account.receipts.retryCleanup = async () => {
    retries++;
  };
  let tree = f.render();
  f.find(tree, (node) => node.props?.testID === 'receipt-cleanup-retry').props.onPress();
  assert.equal(retries, 1);
  assert.equal(f.account.receipts.hasOpenDraft(), false);
  f.account.receipts.open();
  tree = f.render();
  f.find(tree, (node) => node.props?.testID === 'tab-wallet').props.onPress();
  assert.equal(f.account.receipts.hasOpenDraft(), false);
  f.host.unmount();
});

test('Reports entry opens a read-only assistant with selected range and no save callback', async () => {
  const f = await appFixture();
  let tree = f.render();
  f.find(tree, (node) => node.props?.testID === 'tab-reports').props.onPress();
  tree = f.render();
  const range = { startDate: '2026-10-01', endDate: '2026-10-18' };
  f.find(tree, (node) => node.type === 'ReportsScreen').props.onAssistant(range);
  tree = f.render();
  const panel = f.find(tree, (node) => node.type === 'AssistantPanel');
  assert.ok(panel);
  assert.deepEqual(panel.props.initialRange, range);
  assert.equal(panel.props.ledger, f.account.finance.ledger);
  assert.equal(panel.props.onSave, undefined);
  assert.equal(f.rootOptions.hasOpenEditor(), false);
  assert.equal(f.account.receipts.hasOpenDraft(), false);
  f.host.unmount();
});
test('reopening the assistant replaces its Sheet identity even without an intermediate closed render', async () => {
  const f = await appFixture();
  let tree = f.render();
  f.find(tree, (node) => node.props?.testID === 'tab-reports').props.onPress();
  tree = f.render();
  const range = { startDate: '2026-10-01', endDate: '2026-10-18' };
  const open = () => f.find(tree, (node) => node.type === 'ReportsScreen').props.onAssistant(range);
  const sheet = (value) =>
    f.find(value, (node) => node.type === 'Sheet' && node.props.title === 'Financial assistant');
  open();
  tree = f.render();
  const first = sheet(tree);
  assert.equal(first.props.key, f.account.assistant.panel.sessionKey);
  assert.equal(sheet(f.render()).props.key, first.props.key);
  // A dismissed Android dialog can leave the live JS session present. A fresh
  // explicit Open must replace the native subtree, without requiring a null frame.
  open();
  tree = f.render();
  const next = sheet(tree);
  assert.equal(next.props.key, f.account.assistant.panel.sessionKey);
  assert.notEqual(next.props.key, first.props.key);
  assert.equal(f.find(next, (node) => node.type === 'AssistantPanel').props.onSave, undefined);
  f.host.unmount();
});

test('opening editor, receipt, export or another tab closes the read-only chat', async () => {
  const f = await appFixture();
  const range = { startDate: '2026-10-01', endDate: '2026-10-18' };
  f.account.assistant.open(range);
  let tree = f.render();
  f.find(tree, (node) => node.type === 'TransactionsScreen').props.onAdd();
  assert.equal(f.account.assistant.panel, null);
  f.rootOptions.closeEditor();
  f.render();
  f.account.assistant.open(range);
  tree = f.render();
  f.find(tree, (node) => node.type === 'TransactionsScreen').props.receiptTools.props.onOpen();
  assert.equal(f.account.assistant.panel, null);
  f.account.receipts.close();
  f.account.assistant.open(range);
  tree = f.render();
  f.find(tree, (node) => node.props?.testID === 'tab-reports').props.onPress();
  assert.equal(f.account.assistant.panel, null);
  f.account.assistant.open(range);
  tree = f.render();
  f.find(tree, (node) => node.type === 'ReportsScreen').props.onExport(range);
  assert.equal(f.account.assistant.panel, null);
  f.host.unmount();
});
test('account data gate hides an assistant from a previous wallet even before its close effect runs', async () => {
  const f = await appFixture();
  f.account.assistant.open({ startDate: '2026-10-01', endDate: '2026-10-18' });
  assert.ok(f.find(f.render(), (node) => node.type === 'AssistantPanel'));
  f.account.financialAllowed = false;
  f.account.gateState = { ...f.account.accountState, phase: 'switching', activeOwnerToken: null };
  assert.equal(
    f.find(f.render(), (node) => node.type === 'AssistantPanel'),
    null,
  );
  assert.equal(
    f.find(f.render(), (node) => node.props?.testID === 'account-discard-receipt-recheck'),
    null,
  );
  f.host.unmount();
});
