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
    './theme': { colors: {}, ui: {} },
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
  assert.match(text(tree), /Everyday tracking works without a connection/);
  assert.match(text(tree), /choosing a photo alone sends nothing/);
  assert.equal(byId(tree, 'connections-assistant-status'), undefined);
  byId(tree, 'connections-account').props.onPress();
  nodes(tree)
    .find((node) => node.type === 'ReceiptEntry')
    .props.onOpen();
  byId(tree, 'connections-manual-entry').props.onPress();
  byId(tree, 'connections-assistant').props.onPress();
  assert.deepEqual(calls, ['account', 'receipt', 'manual', 'reports']);
  tree = f.render({ ...props, busy: true, connection: { phase: 'configured' } });
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
