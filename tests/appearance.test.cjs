const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  KEY,
  createAppearancePreferences,
  resolveAppearance,
} = require('../src/preferences/appearance');
const { lightPalette, darkPalette } = require('../src/ui/appearancePalette');
const { createHookHost, loadTsSource } = require('./helpers/hook-host.cjs');
const { makeThemeStub } = require('./helpers/theme-stub.cjs');
function memory(raw = null) {
  const values = new Map(raw === null ? [] : [[KEY, raw]]),
    calls = [];
  return {
    values,
    calls,
    async getItem(key) {
      calls.push(['get', key]);
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      calls.push(['set', key]);
      values.set(key, value);
    },
  };
}
const settled = async (store) => {
  await store.initialize();
  return store;
};
const saveBytes = (appearance, hideHomeBalance) =>
  JSON.stringify({ version: 1, appearance, hideHomeBalance });

test('new display settings follow system without writing or reading wallet/account keys', async () => {
  const storage = memory(),
    store = await settled(createAppearancePreferences(storage));
  assert.equal(store.getSnapshot().appearance, 'system');
  assert.equal(store.getSnapshot().hideHomeBalance, false);
  assert.equal(store.getSnapshot().ready, true);
  assert.deepEqual(storage.calls, [['get', KEY]]);
  assert.equal(resolveAppearance('system', 'dark'), 'dark');
  assert.equal(resolveAppearance('system', null), 'light');
  assert.equal(resolveAppearance('light', 'dark'), 'light');
  assert.equal(resolveAppearance('dark', 'light'), 'dark');
});

test('appearance and hidden home balance survive restart without changing unrelated data', async () => {
  const storage = memory();
  storage.values.set('wallet-test', 'private synthetic wallet');
  const store = await settled(createAppearancePreferences(storage));
  assert.equal(await store.setAppearance('dark'), true);
  assert.equal(await store.setBalanceHidden(true), true);
  const reopened = await settled(createAppearancePreferences(storage));
  assert.equal(reopened.getSnapshot().appearance, 'dark');
  assert.equal(reopened.getSnapshot().hideHomeBalance, true);
  assert.equal(storage.values.get('wallet-test'), 'private synthetic wallet');
  assert.ok(storage.calls.every(([, key]) => key === KEY));
});

test('serialized display updates preserve both independently chosen preferences', async () => {
  const storage = memory(),
    store = await settled(createAppearancePreferences(storage));
  const theme = store.setAppearance('dark'),
    visibility = store.setBalanceHidden(true);
  assert.equal(store.getSnapshot().saving, true);
  assert.deepEqual(await Promise.all([theme, visibility]), [true, true]);
  assert.deepEqual(JSON.parse(storage.values.get(KEY)), {
    version: 1,
    appearance: 'dark',
    hideHomeBalance: true,
  });
  assert.equal(store.getSnapshot().saving, false);
});

test('a failed write retains and reports the actual saved preference', async () => {
  const storage = memory(saveBytes('dark', true)),
    store = await settled(createAppearancePreferences(storage));
  const original = storage.setItem;
  storage.setItem = async () => {
    throw Error('unavailable');
  };
  assert.equal(await store.setAppearance('light'), false);
  assert.equal(store.getSnapshot().appearance, 'dark');
  assert.equal(store.getSnapshot().hideHomeBalance, true);
  assert.match(store.getSnapshot().error, /not saved/);
  storage.setItem = original;
  assert.equal(await store.setAppearance('light'), true);
  assert.equal(store.getSnapshot().error, '');
});

test('a write that succeeds before rejecting is confirmed by reopening its bytes', async () => {
  const storage = memory(),
    store = await settled(createAppearancePreferences(storage));
  storage.setItem = async (key, value) => {
    storage.values.set(key, value);
    throw Error('late error');
  };
  assert.equal(await store.setBalanceHidden(true), true);
  assert.equal(store.getSnapshot().hideHomeBalance, true);
  assert.equal(store.getSnapshot().ready, true);
});

test('unreadable or invalid saved preferences are retained and block changes until a successful retry', async () => {
  const storage = memory('{invalid'),
    store = createAppearancePreferences(storage);
  assert.equal(await store.initialize(), false);
  assert.equal(store.getSnapshot().ready, false);
  assert.equal(await store.setAppearance('dark'), false);
  assert.equal(storage.values.get(KEY), '{invalid');
  storage.values.set(KEY, saveBytes('dark', true));
  assert.equal(await store.initialize(), true);
  assert.equal(store.getSnapshot().appearance, 'dark');
  assert.equal(store.getSnapshot().hideHomeBalance, true);
});

test('preference hydration never overwrites a saved choice with an early default action', async () => {
  let release;
  const storage = memory(saveBytes('dark', true));
  storage.getItem = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const store = createAppearancePreferences(storage),
    loading = store.initialize();
  assert.equal(await store.setBalanceHidden(false), false);
  release(saveBytes('dark', true));
  await loading;
  assert.equal(store.getSnapshot().hideHomeBalance, true);
  assert.equal(storage.calls.length, 0);
});

function luminance(hex) {
  const c = hex
    .slice(1)
    .match(/../g)
    .map((x) => parseInt(x, 16) / 255)
    .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}
function contrast(a, b) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
test('light and dark semantic text, links, errors and solid action labels maintain readable contrast', () => {
  for (const palette of [lightPalette, darkPalette]) {
    for (const background of ['background', 'surface', 'raised'])
      for (const foreground of ['text', 'muted', 'accent', 'red', 'green'])
        assert.ok(
          contrast(palette[foreground], palette[background]) >= 4.5,
          `${foreground}/${background} contrast`,
        );
    for (const [fg, bg] of [
      ['accent', 'accentSoft'],
      ['red', 'redSoft'],
      ['green', 'greenSoft'],
      ['onAccent', 'accentFill'],
    ])
      assert.ok(contrast(palette[fg], palette[bg]) >= 4.5, `${fg}/${bg} contrast`);
  }
});

const nodes = (node) =>
  !node || typeof node !== 'object'
    ? []
    : Array.isArray(node)
      ? node.flatMap(nodes)
      : [node, ...nodes(node.props?.children)];
const find = (tree, id) => nodes(tree).find((node) => node.props?.testID === id);
const text = (node) =>
  node == null
    ? ''
    : Array.isArray(node)
      ? node.map(text).join('')
      : typeof node === 'object'
        ? text(node.props?.children)
        : String(node);
const core = require('../src/core/model');
const native = {
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StyleSheet: { create: (value) => value, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }),
};
const components = {
  Action: 'Action',
  Choice: 'Choice',
  Field: 'Field',
  FormError: 'FormError',
  RowAction: 'RowAction',
  Screen: 'Screen',
  Sheet: 'Sheet',
};
test('changing appearance rerenders the wallet without losing an unsaved name draft', () => {
  const host = createHookHost(),
    stub = makeThemeStub();
  const screen = loadTsSource(path.join(__dirname, '../src/ui/WalletScreen.tsx'), {
    react: host.react,
    'react-native': native,
    '../core/model': core,
    './components': components,
    './theme': stub,
  });
  const ledger = core.createEmptyLedger({ name: 'Everyday wallet' });
  const original = JSON.stringify(ledger);
  const render = () =>
    host.render(() =>
      screen.WalletScreen({
        ledger,
        saving: false,
        saveError: '',
        clearSaveError() {},
        onSave: async () => {
          throw Error('Theme must not save a wallet');
        },
      }),
    );
  find(render(), 'wallet-name-input').props.onChangeText('My unfinished name');
  assert.equal(find(render(), 'wallet-name-input').props.value, 'My unfinished name');
  stub.theme.mode = 'dark';
  stub.theme.colors = darkPalette;
  stub.theme.appearance = 'dark';
  const darkTree = render();
  assert.equal(find(darkTree, 'wallet-name-input').props.value, 'My unfinished name');
  assert.equal(find(darkTree, 'appearance-dark').props.selected, true);
  assert.equal(JSON.stringify(ledger), original);
  host.unmount();
});

test('home balance hiding removes its value from rendered and accessible text while preserving transaction visibility', () => {
  const host = createHookHost(),
    stub = makeThemeStub();
  const screen = loadTsSource(path.join(__dirname, '../src/ui/TransactionsScreen.tsx'), {
    react: host.react,
    'react-native': native,
    '../core/model': core,
    './components': components,
    './theme': stub,
    './AppIcon': { AppIcon: 'AppIcon' },
    './TransactionEditor': {
      typeLabels: { income: 'Income', expense: 'Expense', debt: 'Debt payment' },
    },
  });
  const ledger = core.createEmptyLedger({ name: 'Everyday wallet' });
  const original = JSON.stringify(ledger);
  stub.theme.setBalanceHidden = async (value) => {
    stub.theme.balanceHidden = value;
    return true;
  };
  const render = () =>
    host.render(() => screen.TransactionsScreen({ ledger, onAdd() {}, onEdit() {} }));
  const visible = render();
  assert.match(text(find(visible, 'wallet-balance')), /0/);
  find(visible, 'toggle-home-balance').props.onPress();
  const hidden = render(),
    balance = find(hidden, 'wallet-balance');
  assert.equal(text(balance), '••••••');
  assert.equal(balance.props.accessibilityLabel, 'Wallet balance hidden');
  assert.equal(balance.props.selectable, false);
  assert.match(text(find(hidden, 'expense-total')), /0/);
  assert.equal(JSON.stringify(ledger), original);
  host.unmount();
});

test('provider hydration keeps the child identity and hides a saved private balance until preferences arrive', async () => {
  const { hostWithStores } = require('./helpers/account-hook-harness.cjs');
  const host = hostWithStores();
  let release,
    scheme = 'light';
  const calls = [];
  const storage = memory(saveBytes('dark', true));
  storage.getItem = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const store = createAppearancePreferences(storage);
  const ThemeContext = { Provider: 'ThemeContextProvider' };
  const provider = loadTsSource(path.join(__dirname, '../src/ui/ThemeProvider.tsx'), {
    react: host.react,
    'react-native': {
      useColorScheme: () => scheme,
      Appearance: { setColorScheme: (value) => calls.push(value) },
    },
    '@react-native-async-storage/async-storage': memory(),
    '../preferences/appearance': require('../src/preferences/appearance'),
    './theme': {
      lightPalette,
      darkPalette,
      ThemeContext,
      createUi: (colors) => ({ surface: colors.surface }),
    },
  });
  const child = { type: 'AppContent', key: null, props: { draft: 'retained' } };
  const render = () => host.render(() => provider.ThemeProvider({ store, children: child }));
  let tree = render();
  assert.equal(tree.props.value.preferencesReady, false);
  assert.equal(tree.props.value.balanceHidden, true);
  assert.equal(tree.props.children[0], child);
  release(saveBytes('dark', true));
  await store.initialize();
  tree = render();
  assert.equal(tree.props.value.mode, 'dark');
  assert.equal(tree.props.value.balanceHidden, true);
  assert.equal(tree.props.children[0], child);
  assert.deepEqual(calls, ['auto', 'dark']);
  await store.setAppearance('system');
  scheme = 'dark';
  tree = render();
  assert.equal(tree.props.value.mode, 'dark');
  assert.equal(calls.at(-1), 'auto');
  scheme = 'light';
  tree = render();
  assert.equal(tree.props.value.mode, 'light');
  assert.equal(tree.props.children[0], child);
  host.unmount();
});

test('a failed write with unreadable readback blocks further preference changes until recovery', async () => {
  const storage = memory(saveBytes('dark', true)),
    store = await settled(createAppearancePreferences(storage));
  storage.setItem = async () => {
    throw Error('unavailable');
  };
  storage.getItem = async () => {
    throw Error('read unavailable');
  };
  assert.equal(await store.setBalanceHidden(false), false);
  assert.equal(store.getSnapshot().ready, false);
  assert.equal(await store.setAppearance('light'), false);
  assert.equal(store.getSnapshot().hideHomeBalance, true);
  storage.getItem = async (key) => storage.values.get(key) ?? null;
  assert.equal(await store.initialize(), true);
  assert.equal(store.getSnapshot().appearance, 'dark');
  assert.equal(store.getSnapshot().hideHomeBalance, true);
});
