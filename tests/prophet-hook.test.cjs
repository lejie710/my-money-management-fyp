const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const { createHookHost } = require('./helpers/hook-host.cjs');
const { loadSource } = require('./helpers/account-hook-harness.cjs');
const protocol = require('../src/forecast/protocol'),
  f = require('./helpers/prophet-fixtures.cjs');
function fixture() {
  const host = createHookHost();
  host.react.useMemo = (factory, deps) => {
    const ref = host.react.useRef(null);
    if (!ref.current || deps.some((value, index) => value !== ref.current.deps[index]))
      ref.current = { deps, value: factory() };
    return ref.current.value;
  };
  const hook = loadSource(
    path.join(__dirname, '../src/ui/useProphetForecast.ts'),
    { react: host.react, '../forecast/protocol': protocol },
    { AbortController },
  ).useProphetForecast;
  let resolve, reject;
  const calls = [];
  const props = {
    result: f.localForecast(),
    ownerKey: 'full-owner-A',
    changed: false,
    binding: {
      key: {},
      provider: f.provider,
      isCurrent: () => true,
      transport: (input, { signal }) => {
        calls.push({ input, signal });
        return new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        });
      },
    },
  };
  return {
    host,
    props,
    calls,
    render: () => host.render(() => hook(props)),
    resolve: () => resolve(f.result(f.wire())),
    reject: () => reject(new protocol.ForecastError('NETWORK')),
  };
}
test('hook never fits on open, blocks duplicate submission and exposes validated result without changing input', async () => {
  const x = fixture();
  const before = JSON.stringify(x.props.result);
  let view = x.render();
  assert.equal(x.calls.length, 0);
  assert.equal(view.canRun, true);
  const pending = view.run();
  assert.equal(x.render().busy, true);
  assert.equal(await x.render().run(), false);
  assert.equal(x.calls.length, 1);
  x.resolve();
  assert.equal(await pending, true);
  view = x.render();
  assert.equal(view.response.forecast.length, 6);
  assert.equal(view.busy, false);
  assert.equal(JSON.stringify(x.props.result), before);
  x.host.unmount();
});
test('draft/source, owner and provider changes abort pending fit and reject late responses', async () => {
  for (const change of [
    (x) => {
      x.props.changed = true;
    },
    (x) => {
      x.props.ownerKey = 'full-owner-B';
    },
    (x) => {
      x.props.binding = { ...x.props.binding, key: {} };
    },
    (x) => {
      x.props.result = { ...x.props.result, asOfDate: '2026-10-19' };
    },
  ]) {
    const x = fixture();
    const pending = x.render().run();
    change(x);
    assert.equal(x.render().response, null);
    assert.equal(x.calls[0].signal.aborted, true);
    x.resolve();
    assert.equal(await pending, false);
    assert.equal(x.render().response, null);
    x.host.unmount();
  }
});
test('cancel and unmount prevent a pending model result from becoming visible', async () => {
  for (const unmount of [false, true]) {
    const x = fixture();
    const pending = x.render().run();
    if (unmount) x.host.unmount();
    else x.render().cancel();
    assert.equal(x.calls[0].signal.aborted, true);
    x.resolve();
    assert.equal(await pending, false);
    if (!unmount) {
      assert.equal(x.render().response, null);
      assert.match(x.render().message, /cancelled/);
      x.host.unmount();
    }
  }
});
test('connection invalidation blocks requests and errors retain the same-context earlier result', async () => {
  const x = fixture();
  let pending = x.render().run();
  x.resolve();
  await pending;
  assert.ok(x.render().response);
  pending = x.render().run();
  x.reject();
  await pending;
  assert.ok(x.render().response);
  assert.match(x.render().message, /could not be reached/);
  x.props.binding.isCurrent = () => false;
  assert.equal(x.render().canRun, false);
  assert.equal(x.render().response, null);
  x.host.unmount();
});

test('live owner invalidation rejects a settled response before any child rerender', async () => {
  const x = fixture();
  let ownerCurrent = true;
  x.props.binding.isCurrent = () => ownerCurrent;
  const old = x.render();
  const pending = old.run();
  ownerCurrent = false;
  x.resolve();
  assert.equal(await pending, false);
  assert.equal(await old.run(), false);
  assert.equal(x.calls.length, 1);
  assert.equal(x.render().response, null);
  x.host.unmount();
});
