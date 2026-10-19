const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const { hostWithStores, loadSource } = require('./helpers/account-hook-harness.cjs');
const model = require('../src/core/model'),
  forecast = require('../src/core/forecast'),
  protocol = require('../src/forecast/protocol');
const f = require('./helpers/prophet-fixtures.cjs');
function find(node, id) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.type === 'function') return find(node.type(node.props), id);
  if (node.props?.testID === id) return node;
  for (const child of (node.props?.children ?? []).flat(Infinity)) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
function text(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  if (typeof node.type === 'function') return text(node.type(node.props));
  return (node.props?.children ?? []).flat(Infinity).map(text).join('');
}
function fixture() {
  const host = hostWithStores();
  const calls = [];
  let resolve, reject;
  const binding = {
    key: {},
    provider: f.provider,
    isCurrent: () => true,
    transport: (input, { signal }) => {
      calls.push({ input, signal });
      return new Promise((done, fail) => {
        resolve = done;
        reject = fail;
      });
    },
  };
  const hook = loadSource(
    path.join(__dirname, '../src/ui/useProphetForecast.ts'),
    { react: host.react, '../forecast/protocol': protocol },
    { AbortController },
  );
  const module = loadSource(path.join(__dirname, '../src/ui/ForecastSheet.tsx'), {
    react: host.react,
    'react-native': {
      Keyboard: { dismiss() {} },
      StyleSheet: { create: (value) => value },
      Text: 'Text',
      View: 'View',
    },
    '../core/model': model,
    '../core/forecast': forecast,
    './components': {
      Action: 'Action',
      Choice: 'Choice',
      Field: 'Field',
      FormError: 'FormError',
      Sheet: 'Sheet',
    },
    './theme': require('./helpers/theme-stub.cjs').themeStub,
    './useProphetForecast': hook,
  });
  const props = {
    ledger: f.ledger(),
    initialAsOfDate: '2026-10-18',
    ownerKey: 'confirmed-owner-A',
    transportBinding: binding,
    onClose() {},
  };
  return {
    host,
    props,
    calls,
    render: () => host.render(() => module.ForecastSheet(props)),
    fail: (error) => reject(error),
    complete: (negative = false) =>
      resolve(f.result(f.wire(), negative ? [-13, 30000, 31000, 32000, 33000, 34000] : undefined)),
  };
}
test('actual panel keeps device rows, requests only on action, labels negative Prophet output, and never saves data', async () => {
  const x = fixture();
  const before = JSON.stringify(x.props.ledger);
  let tree = x.render();
  assert.equal(x.calls.length, 0);
  assert.equal(find(tree, 'prophet-run').props.disabled, false);
  const device = text(find(tree, 'forecast-future-2026-11'));
  find(tree, 'prophet-run').props.onPress();
  assert.equal(x.calls.length, 1);
  assert.ok(find(x.render(), 'prophet-cancel'));
  x.complete(true);
  await new Promise(setImmediate);
  tree = x.render();
  assert.ok(find(tree, 'prophet-negative'));
  assert.equal(text(find(tree, 'prophet-future-2026-11')), model.formatMoney(-13, 'MYR'));
  assert.equal(text(find(tree, 'forecast-future-2026-11')), device);
  assert.equal(JSON.stringify(x.props.ledger), before);
  x.host.unmount();
});
test('date and category edits abort immediately before a rerender and late output stays hidden', async () => {
  for (const target of ['forecast-as-of-input', 'forecast-category-expense-food']) {
    const x = fixture();
    find(x.render(), 'prophet-run').props.onPress();
    const before = x.render();
    if (target === 'forecast-as-of-input') find(before, target).props.onChangeText('2026-10-19');
    else find(before, target).props.onPress();
    assert.equal(x.calls[0].signal.aborted, true);
    x.complete();
    await new Promise(setImmediate);
    assert.equal(find(x.render(), 'prophet-result'), null);
    assert.equal(find(x.render(), 'prophet-run').props.disabled, true);
    x.host.unmount();
  }
});
test('unconfigured forecast hides Prophet setup and controls while preserving every device projection', () => {
  for (const binding of [null, undefined]) {
    const x = fixture();
    x.props.transportBinding = binding;
    const before = JSON.stringify(x.props.ledger);
    const expected = forecast.forecastRecordedExpenses(x.props.ledger, {
      asOfDate: x.props.initialAsOfDate,
      horizon: 6,
    });
    const tree = x.render();
    for (const id of ['prophet-panel', 'prophet-run', 'prophet-unavailable', 'prophet-result'])
      assert.equal(find(tree, id), null);
    assert.ok(find(tree, 'forecast-future-panel'));
    assert.ok(find(tree, 'forecast-method'));
    for (const row of expected.forecast)
      assert.equal(
        text(find(tree, `forecast-future-${row.month}`)),
        model.formatMoney(row.predictedMinor, expected.currency),
      );
    assert.equal(x.calls.length, 0);
    assert.equal(JSON.stringify(x.props.ledger), before);
    x.host.unmount();
  }
});

test('configured Prophet keeps insufficient-history guidance visible without dispatching', () => {
  const x = fixture();
  x.props.ledger = model.createEmptyLedger();
  const tree = x.render();
  assert.ok(find(tree, 'prophet-panel'));
  assert.equal(find(tree, 'prophet-run').props.disabled, true);
  assert.ok(find(tree, 'prophet-unavailable'));
  assert.ok(find(tree, 'forecast-insufficient'));
  assert.equal(x.calls.length, 0);
  x.host.unmount();
});

test('configured Prophet errors stay visible with the device result and an explicit retry action', async () => {
  const x = fixture();
  const before = JSON.stringify(x.props.ledger);
  const initial = x.render();
  const device = text(find(initial, 'forecast-future-2026-11'));
  find(initial, 'prophet-run').props.onPress();
  x.fail(new protocol.ForecastError('TIMEOUT'));
  await new Promise(setImmediate);
  const tree = x.render();
  assert.ok(find(tree, 'prophet-panel'));
  assert.equal(text(find(tree, 'prophet-status')), protocol.MESSAGES.TIMEOUT);
  assert.equal(find(tree, 'prophet-run').props.disabled, false);
  assert.equal(text(find(tree, 'forecast-future-2026-11')), device);
  assert.equal(x.calls.length, 1);
  assert.equal(JSON.stringify(x.props.ledger), before);
  x.host.unmount();
});

test('disconnect hides the Prophet panel, aborts pending work and retains the device forecast', async () => {
  const x = fixture();
  const initial = x.render();
  const device = text(find(initial, 'forecast-future-2026-11'));
  find(initial, 'prophet-run').props.onPress();
  x.props.transportBinding = null;
  let tree = x.render();
  assert.equal(x.calls[0].signal.aborted, true);
  assert.equal(find(tree, 'prophet-panel'), null);
  assert.equal(text(find(tree, 'forecast-future-2026-11')), device);
  x.complete();
  await new Promise(setImmediate);
  tree = x.render();
  assert.equal(find(tree, 'prophet-result'), null);
  assert.equal(find(tree, 'prophet-panel'), null);
  assert.equal(text(find(tree, 'forecast-future-2026-11')), device);
  x.host.unmount();
});
