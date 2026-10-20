const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { hostWithStores, loadSource } = require('./helpers/account-hook-harness.cjs');
const model = require('../src/core/model');

const nodes = (value) =>
  !value || typeof value !== 'object'
    ? []
    : Array.isArray(value)
      ? value.flatMap(nodes)
      : [value, ...nodes(value.props?.children)];
const byId = (tree, id) => nodes(tree).find((node) => node.props?.testID === id);
const text = (value) =>
  value == null
    ? ''
    : Array.isArray(value)
      ? value.map(text).join('')
      : typeof value === 'object'
        ? text(value.props?.children)
        : String(value);
function setup(name, imports = {}) {
  const host = hostWithStores();
  const component = loadSource(path.join(__dirname, '../src/ui', name + '.tsx'), {
    react: host.react,
    'react-native': {
      View: 'View',
      Text: 'Text',
      Pressable: 'Pressable',
      StyleSheet: { create: (value) => value },
      useWindowDimensions: () => ({ width: 360, fontScale: 1 }),
      Keyboard: { dismiss() {} },
    },
    '../core/model': model,
    './components': Object.fromEntries(
      ['Action', 'RowAction', 'Screen', 'Field', 'Choice', 'FormError', 'Sheet'].map((name) => [
        name,
        name,
      ]),
    ),
    './theme': require('./helpers/theme-stub.cjs').themeStub,
    './AppIcon': { AppIcon: 'AppIcon' },
    ...imports,
  })[name];
  return { host, render: (props) => host.render(() => component(props)) };
}

test('Connections exposes account, receipt, manual and report routes without starting any provider', () => {
  const f = setup('ConnectionsScreen', { './ReceiptEntry': { ReceiptEntry: 'ReceiptEntry' } });
  const calls = [];
  const props = {
    accountState: { provider: 'unconfigured', user: null },
    connection: { phase: 'disabled' },
    busy: false,
    onBack: () => calls.push('back'),
    onAccount: () => calls.push('account'),
    onReceipt: () => calls.push('receipt'),
    onManualEntry: () => calls.push('manual'),
    onReports: () => calls.push('reports'),
  };
  let tree = f.render(props);
  assert.deepEqual(calls, []);
  assert.match(text(tree), /Guest tracking works without a connection/);
  assert.match(text(tree), /choosing a photo alone sends nothing/i);
  assert.equal(byId(tree, 'connections-assistant-status'), undefined);
  byId(tree, 'connections-account').props.onPress();
  nodes(tree)
    .find((node) => node.type === 'ReceiptEntry')
    .props.onOpen();
  byId(tree, 'connections-manual-entry').props.onPress();
  byId(tree, 'connections-assistant').props.onPress();
  assert.deepEqual(calls, ['account', 'receipt', 'manual', 'reports']);
  tree = f.render({
    ...props,
    busy: true,
    connection: {
      phase: 'configured',
      binding: {
        assistant: async () => {
          throw Error('Navigation must not request an explanation.');
        },
        providers: require('../src/companion/providerContract').LEGACY_PROVIDERS,
      },
    },
  });
  for (const id of ['connections-account', 'connections-manual-entry', 'connections-assistant'])
    assert.equal(byId(tree, id).props.disabled, true);
  assert.equal(nodes(tree).find((node) => node.type === 'ReceiptEntry').props.busy, true);
  assert.match(
    text(byId(tree, 'connections-assistant-status')),
    /availability is checked when you ask/,
  );
  f.host.unmount();
});

test('Wallet keeps Connections under Tools while hiding only the unconfigured account shortcut', () => {
  const f = setup('WalletScreen');
  const props = {
    ledger: model.createEmptyLedger(),
    saving: false,
    saveError: '',
    onSave() {},
    clearSaveError() {},
    onManageCategories() {},
    onOpenLoanCalculator() {},
    onOpenAchievements() {},
    onOpenReminders() {},
    onOpenConnections() {},
    accountEntry: { type: 'AccountEntry', props: { testID: 'account-shortcut' } },
    showAccountShortcut: false,
  };
  let tree = f.render(props);
  assert.equal(byId(tree, 'account-shortcut'), undefined);
  assert.equal(byId(tree, 'open-connections').props.onPress, props.onOpenConnections);
  assert.ok(byId(tree, 'open-loan-calculator'));
  tree = f.render({ ...props, showAccountShortcut: true });
  assert.ok(byId(tree, 'account-shortcut'));
  f.host.unmount();
});

test('empty Activity offers its first transaction without teaching edits to nonexistent entries', () => {
  const f = setup('TransactionsScreen', {
    './TransactionEditor': {
      typeLabels: { income: 'Income', expense: 'Expense', debt: 'Debt payment' },
    },
  });
  const ledger = model.createEmptyLedger();
  const before = JSON.stringify(ledger);
  let adds = 0;
  const tree = f.render({ ledger, onEdit() {}, onAdd: () => adds++ });
  assert.match(text(tree), /Ready for your first entry/);
  assert.equal(text(tree).includes('Tap an entry to edit or delete.'), false);
  assert.match(text(byId(tree, 'wallet-balance')), /0\.00/);
  byId(tree, 'add-transaction').props.onPress();
  assert.equal(adds, 1);
  assert.equal(JSON.stringify(ledger), before);
  f.host.unmount();
});

test('Reports hides the optional assistant shortcut until requested and still preserves its applied range', () => {
  const f = setup('ReportsScreen', {
    '../core/reports': require('../src/core/reports'),
    './TransactionsScreen': { displayDate: (date) => date },
    './HealthPanel': { HealthPanel: 'HealthPanel' },
    './ForecastEntry': { ForecastEntry: 'ForecastEntry' },
  });
  const ranges = [];
  const props = {
    ledger: model.createEmptyLedger(),
    forecastOwnerKey: 'synthetic-owner',
    getForecastToday: () => '2026-10-18',
    onExport() {},
    onAssistant: (range) => ranges.push(range),
    showAssistantShortcut: false,
  };
  let tree = f.render(props);
  assert.equal(byId(tree, 'open-report-assistant'), undefined);
  assert.ok(byId(tree, 'export-report'));
  props.showAssistantShortcut = true;
  props.assistantRequested = true;
  tree = f.render(props);
  assert.ok(byId(tree, 'report-assistant-guidance'));
  byId(tree, 'open-report-assistant').props.onPress();
  const applied = ranges[0];
  byId(tree, 'report-period-custom').props.onPress();
  tree = f.render(props);
  byId(tree, 'report-start-input').props.onChangeText('invalid');
  tree = f.render(props);
  byId(tree, 'apply-report-range').props.onPress();
  tree = f.render(props);
  assert.ok(byId(tree, 'report-range-error').props.message);
  byId(tree, 'open-report-assistant').props.onPress();
  assert.deepEqual(ranges.at(-1), applied);
  f.host.unmount();
});

test('forecast-only Connections distinguishes unselected receipt and assistant while preserving navigation', () => {
  const f = setup('ConnectionsScreen', { './ReceiptEntry': { ReceiptEntry: 'ReceiptEntry' } });
  const calls = [];
  const connection = {
    phase: 'configured',
    binding: {
      receipt: null,
      assistant: null,
      forecast() {
        throw Error('Navigation must not start Prophet.');
      },
      providers: require('../src/companion/providerContract').validateProviders({
        ocr: null,
        assistant: null,
        forecast: {
          engine: 'prophet',
          processing: 'local',
          version: 'recorded-expense-prophet-v1',
          maxHistoryMonths: 120,
        },
      }),
    },
  };
  const tree = f.render({
    accountState: { provider: 'unconfigured', user: null },
    connection,
    busy: false,
    onBack() {},
    onAccount() {},
    onReceipt: () => calls.push('receipt'),
    onManualEntry: () => calls.push('manual'),
    onReports: () => calls.push('reports'),
    onForecast: () => calls.push('forecast'),
  });
  assert.match(text(byId(tree, 'connections-receipt-hint')), /Receipt recognition is not selected/);
  assert.match(text(byId(tree, 'connections-receipt-hint')), /Manual entry is available/);
  assert.doesNotMatch(
    text(byId(tree, 'connections-receipt-hint')),
    /Windows OCR runs|Google Cloud Vision receives/,
  );
  assert.match(text(byId(tree, 'connections-assistant-hint')), /No assistant provider is selected/);
  assert.doesNotMatch(
    text(byId(tree, 'connections-assistant-hint')),
    /selected local model|selected OpenAI model/,
  );
  assert.equal(byId(tree, 'connections-assistant-status'), undefined);
  assert.deepEqual(calls, []);
  nodes(tree)
    .find((node) => node.type === 'ReceiptEntry')
    .props.onOpen();
  byId(tree, 'connections-manual-entry').props.onPress();
  byId(tree, 'connections-assistant').props.onPress();
  byId(tree, 'connections-forecast').props.onPress();
  assert.deepEqual(calls, ['receipt', 'manual', 'reports', 'forecast']);
  f.host.unmount();
});

test('Connections describes only the selected local or cloud receipt and assistant providers', () => {
  const f = setup('ConnectionsScreen', { './ReceiptEntry': { ReceiptEntry: 'ReceiptEntry' } });
  const contract = require('../src/companion/providerContract');
  const options = [
    {
      providers: contract.LEGACY_PROVIDERS,
      receipt: /Windows OCR runs on the connected computer/,
      assistant: /selected local model/,
      absent: /Google Cloud Vision receives|selected OpenAI model/,
    },
    {
      providers: contract.validateProviders({
        ocr: { engine: 'google-cloud-vision', processing: 'cloud', maxImageBytes: 6291456 },
        assistant: { engine: 'openai', processing: 'cloud', model: 'synthetic-model' },
        forecast: null,
      }),
      receipt: /Google Cloud Vision receives the selected image/,
      assistant: /selected OpenAI model/,
      absent: /Windows OCR runs|selected local model/,
    },
  ];
  for (const option of options) {
    const tree = f.render({
      accountState: { provider: 'unconfigured', user: null },
      busy: false,
      connection: {
        phase: 'configured',
        binding: {
          providers: option.providers,
          receipt: {
            recognize() {
              throw Error('Do not recognize on render.');
            },
          },
          assistant() {
            throw Error('Do not ask on render.');
          },
        },
      },
      onBack() {},
      onAccount() {},
      onReceipt() {},
      onManualEntry() {},
      onReports() {},
    });
    const receipt = text(byId(tree, 'connections-receipt-hint'));
    const assistant = text(byId(tree, 'connections-assistant-hint'));
    assert.match(receipt, option.receipt);
    assert.match(receipt, /only when you request recognition/);
    assert.match(receipt, /Choosing a photo alone sends nothing/);
    assert.match(assistant, option.assistant);
    assert.match(assistant, /only when you choose Ask/);
    assert.doesNotMatch(receipt + assistant, option.absent);
    assert.match(
      text(byId(tree, 'connections-assistant-status')),
      /availability is checked when you ask/,
    );
  }
  f.host.unmount();
});

test('configured cloud wallet navigation explains confirmed writes and does not start a request', () => {
  const f = setup('ConnectionsScreen', { './ReceiptEntry': { ReceiptEntry: 'ReceiptEntry' } });
  const calls = [];
  const tree = f.render({
    accountState: { provider: 'configured', user: { displayName: 'Person' } },
    connection: { phase: 'not-configured', binding: null },
    busy: false,
    cloudWalletConfigured: true,
    onBack() {},
    onAccount() {},
    onReceipt() {},
    onManualEntry() {},
    onReports() {},
    onCloudWallet: () => calls.push('cloud'),
    onCloudBackup: () => calls.push('backup'),
  });
  assert.deepEqual(calls, []);
  assert.match(text(tree), /Signed-in changes save to Firebase when connected/);
  assert.match(text(tree), /unsaved edits stay as drafts/);
  byId(tree, 'connections-cloud-wallet').props.onPress();
  assert.deepEqual(calls, ['cloud']);
  assert.ok(byId(tree, 'connections-cloud-backup'));
  f.host.unmount();
});
