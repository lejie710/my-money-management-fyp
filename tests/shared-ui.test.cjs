const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHookHost, loadTsSource } = require('./helpers/hook-host.cjs');

function fixture() {
  const host = createHookHost();
  const components = loadTsSource(path.join(__dirname, '../src/ui/components.tsx'), {
    react: host.react,
    'react-native': {
      KeyboardAvoidingView: 'KeyboardAvoidingView',
      Modal: 'Modal',
      Platform: { OS: 'android' },
      Pressable: 'Pressable',
      ScrollView: 'ScrollView',
      StatusBar: { currentHeight: 24 },
      StyleSheet: { create: (value) => value, hairlineWidth: 1 },
      Text: 'Text',
      TextInput: 'TextInput',
      View: 'View',
      useWindowDimensions: () => ({ width: 360, height: 780 }),
    },
    './AppIcon': { AppIcon: 'AppIcon' },
    './theme': require('./helpers/theme-stub.cjs').themeStub,
  });
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    for (const child of (node.props?.children ?? []).flat(Infinity)) {
      const result = find(child, predicate);
      if (result) return result;
    }
    return null;
  };
  return { host, components, find };
}

test('shared Sheet blocks Android Back and explicit Close during a save, then permits dismissal', () => {
  const f = fixture();
  let closes = 0;
  let busy = true;
  const render = () =>
    f.host.render(() =>
      f.components.Sheet({
        title: 'Edit transaction',
        busy,
        onClose: () => {
          closes++;
        },
        children: 'Draft',
      }),
    );
  let tree = render();
  tree.props.onRequestClose();
  const close = f.find(tree, (node) => node.props?.testID === 'close-editor');
  assert.equal(close.props.disabled, true);
  assert.equal(close.props.accessibilityState.disabled, true);
  close.props.onPress();
  assert.equal(closes, 0);
  busy = false;
  tree = render();
  tree.props.onRequestClose();
  f.find(tree, (node) => node.props?.testID === 'close-editor').props.onPress();
  assert.equal(closes, 2);
  f.host.unmount();
});

test('shared Field retains caller input and focus callbacks with its explicit accessible label', () => {
  const f = fixture();
  const events = [];
  const focus = { type: 'focus' },
    blur = { type: 'blur' };
  const render = () =>
    f.host.render(() =>
      f.components.Field({
        label: 'Amount',
        accessibilityLabel: 'Transaction amount in MYR',
        testID: 'amount',
        value: '10',
        onChangeText: (value) => events.push(value),
        onFocus: (event) => events.push(event),
        onBlur: (event) => events.push(event),
      }),
    );
  let input = f.find(render(), (node) => node.type === 'TextInput');
  assert.equal(input.props.accessibilityLabel, 'Transaction amount in MYR');
  assert.equal(input.props.testID, 'amount');
  input.props.onFocus(focus);
  input = f.find(render(), (node) => node.type === 'TextInput');
  input.props.onChangeText('15');
  input.props.onBlur(blur);
  assert.deepEqual(events, [focus, '15', blur]);
  assert.equal(f.find(render(), (node) => node.type === 'TextInput').props.value, '10');
  f.host.unmount();
});

test('grouped RowAction exposes its action, detail and disabled state without replacing the callback', () => {
  const f = fixture();
  let opens = 0;
  const props = {
    label: 'Manage reminders',
    detail: 'For this wallet',
    icon: 'bell',
    onPress: () => {
      opens++;
    },
    testID: 'open-reminders',
  };
  let row = f.find(f.components.RowAction(props), (node) => node.type === 'Pressable');
  assert.equal(row.props.accessibilityRole, 'button');
  assert.equal(row.props.accessibilityLabel, 'Manage reminders. For this wallet');
  assert.equal(row.props.testID, 'open-reminders');
  row.props.onPress();
  assert.equal(opens, 1);
  row = f.find(
    f.components.RowAction({ ...props, disabled: true }),
    (node) => node.type === 'Pressable',
  );
  assert.equal(row.props.disabled, true);
  assert.equal(row.props.accessibilityState.disabled, true);
  f.host.unmount();
});
