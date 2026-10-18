const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmptyLedger } = require('../src/core/model');
const { buildAssistantContext, MODEL_ID } = require('../src/assistant/grounding');
const { createAssistantSession, ASSISTANT_WAIT_MS } = require('../src/assistant/sessionGate');
const defer = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const context = () =>
  buildAssistantContext(createEmptyLedger(), { startDate: '2026-10-01', endDate: '2026-10-31' });
const answer = () => ({
  model: MODEL_ID,
  finishReason: 'stop',
  content: JSON.stringify({
    answer: 'Recorded income is MYR 0.00. Ratios cannot divide by zero.',
    factIds: ['income', 'ratios'],
  }),
});
function setup(transport) {
  let actorKey = 'actor-a',
    sessionKey = 'session-a',
    selected = context(),
    callback,
    delay;
  const original = { actorKey, sessionKey, context: selected };
  const gate = createAssistantSession({
    ...original,
    transport,
    isCurrent: (value) =>
      value.actorKey === actorKey && value.sessionKey === sessionKey && value.context === selected,
    setTimer(fn, ms) {
      callback = fn;
      delay = ms;
      return fn;
    },
    clearTimer() {
      callback = null;
    },
  });
  return {
    gate,
    expire() {
      callback();
    },
    delay: () => delay,
    actor(value) {
      actorKey = value;
    },
    session(value) {
      sessionKey = value;
    },
    context(value) {
      selected = value;
    },
  };
}
test('duplicate ask is busy, no actor/session identity enters the transport payload', async () => {
  const native = defer();
  let calls = 0;
  const { gate } = setup((payload) => {
    calls++;
    assert.doesNotMatch(JSON.stringify(payload), /actor-a|session-a/);
    return native.promise;
  });
  const pending = gate.ask('Explain income.');
  await Promise.resolve();
  assert.equal((await gate.ask('Again')).status, 'busy');
  assert.equal(calls, 1);
  native.resolve(answer());
  assert.equal((await pending).status, 'success');
  assert.equal(gate.isBusy(), false);
});
test('actor, session and context changes each make late completion stale', async () => {
  for (const change of ['actor', 'session', 'context']) {
    const native = defer();
    const state = setup(() => native.promise);
    const pending = state.gate.ask('Explain.');
    await Promise.resolve();
    state[change](change === 'context' ? context() : 'replacement');
    native.resolve(answer());
    const result = await pending;
    assert.equal(result.status, 'stale');
    assert.equal(state.gate.isResultCurrent(result), false);
    assert.equal((await state.gate.ask('More')).status, 'stale');
  }
});
test('cancel releases UI immediately, aborts HTTP and prevents old result replacing retry', async () => {
  const first = defer();
  let signal,
    calls = 0;
  const { gate } = setup((payload, options) => {
    signal = options.signal;
    return ++calls === 1 ? first.promise : Promise.resolve(answer());
  });
  const pending = gate.ask('Explain.');
  await Promise.resolve();
  gate.cancel();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(signal.aborted, true);
  assert.equal((await gate.ask('Retry')).status, 'success');
  first.resolve(answer());
  await Promise.resolve();
  assert.equal(gate.isBusy(), false);
});
test('close before work starts avoids native transport and remains permanently closed', async () => {
  let calls = 0;
  const { gate } = setup(async () => {
    calls++;
    return answer();
  });
  const pending = gate.ask('Explain.');
  gate.close();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(calls, 0);
  assert.equal((await gate.ask('Retry')).status, 'stale');
});
test('timeout leaves 5-second margin beyond model HTTP timeout, aborts and allows retry', async () => {
  const native = defer();
  let signal;
  const state = setup((payload, options) => {
    signal = options.signal;
    return native.promise;
  });
  const pending = state.gate.ask('Explain.');
  await Promise.resolve();
  assert.equal(state.delay(), 125000);
  assert.equal(ASSISTANT_WAIT_MS, 125000);
  state.expire();
  assert.equal((await pending).status, 'timeout');
  assert.equal(signal.aborted, true);
  assert.equal(state.gate.isBusy(), false);
});
test('service errors, blank 200, wrong model and truncated output are explicit failures', async () => {
  const bad = [
    { ...answer(), content: '' },
    { ...answer(), model: 'another-model' },
    { ...answer(), finishReason: 'length' },
  ];
  for (const response of bad) {
    const { gate } = setup(async () => response);
    assert.notEqual((await gate.ask('Explain.')).status, 'success');
  }
  const { gate } = setup(async () => {
    throw Error('private native details');
  });
  assert.equal((await gate.ask('Explain.')).status, 'unavailable');
});
test('caller can suppress a success already resolved before the owner switches', async () => {
  const state = setup(async () => answer());
  const result = await state.gate.ask('Explain.');
  assert.equal(result.status, 'success');
  state.actor('another-actor');
  assert.equal(state.gate.isResultCurrent(result), false);
});
test('cancel or a later question also invalidates a success settled before UI continuation', async () => {
  const { gate } = setup(async () => answer());
  const first = await gate.ask('Explain.');
  assert.equal(gate.isResultCurrent(first), true);
  gate.cancel();
  assert.equal(gate.isResultCurrent(first), false);
  const second = await gate.ask('Explain again.');
  const third = await gate.ask('One more.');
  assert.equal(gate.isResultCurrent(second), false);
  assert.equal(gate.isResultCurrent(third), true);
});
