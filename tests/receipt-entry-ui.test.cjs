const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { hostWithStores, loadSource } = require('./helpers/account-hook-harness.cjs');

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

function fixture(phase = 'configured', busy = false) {
  const host = hostWithStores();
  const calls = { open: 0, recheck: 0 };
  const props = {
    busy,
    onOpen: () => calls.open++,
    connection: {
      phase,
      enabled: phase !== 'disabled',
      binding:
        phase === 'configured'
          ? {
              receipt: require('../src/receipts/client').createReceiptClient(
                {
                  version: 2,
                  runId: 'receipt-entry-fixture',
                  url: 'http://127.0.0.1:8787/v1/recognize',
                  token: 'r'.repeat(43),
                  providers: {
                    ocr: {
                      engine: 'windows-media-ocr',
                      processing: 'local',
                      maxImageBytes: 10485760,
                    },
                    assistant: null,
                    forecast: null,
                  },
                },
                {
                  fetch() {
                    throw Error('Rendering or navigation must not request recognition.');
                  },
                },
              ),
              assistant: null,
              forecast: null,
            }
          : null,
      message: 'Configured locally. Availability is checked only when recognition is requested.',
      recheck: async () => {
        calls.recheck++;
      },
    },
  };
  const module = loadSource(path.join(__dirname, '../src/ui/ReceiptEntry.tsx'), {
    react: host.react,
    'react-native': {
      Pressable: 'Pressable',
      Text: 'Text',
      View: 'View',
      StyleSheet: { create: (value) => value, hairlineWidth: 0.5 },
    },
    './AppIcon': { AppIcon: 'AppIcon' },
    './theme': require('./helpers/theme-stub.cjs').themeStub,
  });
  return { host, calls, props, render: () => host.render(() => module.ReceiptEntry(props)) };
}

test('compact receipt entry keeps truthful phase visible and Setup independently reveals full explanation and Recheck', () => {
  const f = fixture();
  let tree = f.render();
  assert.equal(text(byId(tree, 'companion-connection-status')), 'Connection configured');
  assert.equal(byId(tree, 'recheck-companion-connection'), undefined);
  assert.equal(text(tree).includes(f.props.connection.message), false);
  const open = byId(tree, 'open-receipt-capture');
  const setup = byId(tree, 'receipt-connection-details');
  assert.equal(nodes(open).includes(setup), false);
  assert.equal(nodes(setup).includes(open), false);
  for (const target of [open, setup]) {
    assert.equal(target.props.accessibilityRole, 'button');
    assert.ok(target.props.style({ pressed: false }).some((style) => style?.minHeight >= 48));
  }
  assert.equal(setup.props.accessibilityState.expanded, false);
  setup.props.onPress();
  tree = f.render();
  assert.equal(byId(tree, 'receipt-connection-details').props.accessibilityState.expanded, true);
  assert.ok(text(tree).includes(f.props.connection.message));
  assert.equal(f.calls.open, 0);
  assert.equal(f.calls.recheck, 0);
  byId(tree, 'recheck-companion-connection').props.onPress();
  assert.equal(f.calls.recheck, 1);
  byId(tree, 'open-receipt-capture').props.onPress();
  assert.equal(f.calls.open, 1);
  byId(tree, 'receipt-connection-details').props.onPress();
  tree = f.render();
  assert.equal(byId(tree, 'recheck-companion-connection'), undefined);
  assert.equal(text(byId(tree, 'companion-connection-status')), 'Connection configured');
  assert.deepEqual(f.calls, { open: 1, recheck: 1 });
  f.host.unmount();
});

test('receipt open and expanded Recheck retain the busy, checking and disabled-build guards in every phase', () => {
  const expected = {
    disabled: 'Recognition not enabled',
    'not-configured': 'Connection not set up',
    checking: 'Checking connection…',
    configured: 'Connection configured',
    unavailable: 'Connection needs attention',
  };
  for (const phase of Object.keys(expected)) {
    for (const busy of [false, true]) {
      const f = fixture(phase, busy);
      let tree = f.render();
      assert.equal(text(byId(tree, 'companion-connection-status')), expected[phase]);
      const openDisabled = busy || phase === 'checking';
      assert.equal(byId(tree, 'open-receipt-capture').props.disabled, openDisabled);
      assert.equal(
        byId(tree, 'open-receipt-capture').props.accessibilityState.disabled,
        openDisabled,
      );
      byId(tree, 'receipt-connection-details').props.onPress();
      tree = f.render();
      const recheck = byId(tree, 'recheck-companion-connection');
      const recheckDisabled = busy || phase === 'checking' || phase === 'disabled';
      assert.equal(recheck.props.disabled, recheckDisabled);
      assert.equal(recheck.props.accessibilityState.disabled, recheckDisabled);
      assert.equal(
        recheck.props.accessibilityLabel,
        phase === 'checking' ? 'Checking connection…' : 'Recheck connection',
      );
      assert.deepEqual(f.calls, { open: 0, recheck: 0 });
      f.host.unmount();
    }
  }
});

test('configured Activity shortcut stays concise without claiming the companion has answered', () => {
  const f = fixture();
  f.props.compact = true;
  const tree = f.render();
  assert.equal(byId(tree, 'receipt-connection-details'), undefined);
  assert.equal(byId(tree, 'companion-connection-status'), undefined);
  assert.match(text(byId(tree, 'receipt-shortcut-detail')), /before saving an expense/);
  assert.match(
    byId(tree, 'open-receipt-capture').props.accessibilityLabel,
    /Connection configured/,
  );
  assert.deepEqual(f.calls, { open: 0, recheck: 0 });
  byId(tree, 'open-receipt-capture').props.onPress();
  assert.equal(f.calls.open, 1);
  f.host.unmount();
});

test('forecast-only connection does not advertise recognition and still opens review and connection setup', () => {
  const f = fixture();
  f.props.connection.binding = {
    receipt: null,
    assistant: null,
    forecast() {
      throw Error('Receipt navigation must not request a forecast.');
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
  };
  let tree = f.render();
  assert.equal(text(byId(tree, 'companion-connection-status')), 'Recognition not selected');
  assert.match(
    byId(tree, 'open-receipt-capture').props.accessibilityLabel,
    /Recognition not selected/,
  );
  assert.equal(byId(tree, 'open-receipt-capture').props.disabled, false);
  assert.deepEqual(f.calls, { open: 0, recheck: 0 });
  byId(tree, 'open-receipt-capture').props.onPress();
  byId(tree, 'receipt-connection-details').props.onPress();
  tree = f.render();
  assert.equal(byId(tree, 'recheck-companion-connection').props.disabled, false);
  byId(tree, 'recheck-companion-connection').props.onPress();
  assert.deepEqual(f.calls, { open: 1, recheck: 1 });
  assert.equal(text(byId(tree, 'companion-connection-status')), 'Recognition not selected');
  f.host.unmount();
});
