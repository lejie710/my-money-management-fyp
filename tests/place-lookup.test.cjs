const test = require('node:test');
const assert = require('node:assert/strict');
const {
  coordinateFromMap,
  validatePlaceCandidate,
  confirmedPlace,
  loadMapRuntime,
  createPlaceLookup,
  PLACE_LOOKUP_TIMEOUT_MS,
} = require('../src/ui/placeLookup');

const point = { latitude: 5.4, longitude: 100.3 };
const candidate = (overrides = {}) => ({
  label: 'Synthetic public place',
  coordinate: point,
  source: 'map',
  capturedAtMs: 1000,
  accuracyMeters: null,
  ...overrides,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function clock() {
  const timers = new Map();
  let now = 0;
  return {
    setTimer(callback, milliseconds) {
      timers.set(callback, now + milliseconds);
      return callback;
    },
    clearTimer(callback) {
      timers.delete(callback);
    },
    expire() {
      for (const callback of [...timers.keys()]) callback();
    },
    advance(milliseconds) {
      now += milliseconds;
      for (const [callback, deadline] of [...timers]) {
        if (deadline <= now) callback();
      }
    },
    count: () => timers.size,
  };
}

test('map tuple order and finite geographic bounds are enforced without mutating the event', () => {
  const event = Object.freeze([100.3, 5.4]);
  assert.deepEqual(coordinateFromMap(event), point);
  assert.deepEqual(coordinateFromMap([-180, 90]), { longitude: -180, latitude: 90 });
  for (const input of [
    null,
    {},
    [],
    [1],
    [1, 2, 3],
    ['100', 5],
    [NaN, 2],
    [1, Infinity],
    [181, 0],
    [0, -91],
  ])
    assert.throws(() => coordinateFromMap(input));
});

test('overall lookup allows both 20-second native stages to complete', async () => {
  const timers = clock(),
    lookup = createPlaceLookup(timers);
  const fix = deferred(),
    geocode = deferred();
  let stage = 'starting',
    settled = false;
  const pending = lookup.run(async () => {
    stage = 'fix';
    await fix.promise;
    stage = 'geocode';
    await geocode.promise;
    return candidate({ source: 'device' });
  });
  pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  timers.advance(20000);
  assert.equal(settled, false);
  fix.resolve();
  await Promise.resolve();
  assert.equal(stage, 'geocode');
  timers.advance(20000);
  await Promise.resolve();
  assert.equal(settled, false);
  geocode.resolve();
  assert.equal((await pending).status, 'success');
  assert.equal(timers.count(), 0);
});

test('hung lookup has a 50-second backstop and explicit cancellation remains immediate', async () => {
  assert.equal(PLACE_LOOKUP_TIMEOUT_MS, 50000);
  const timers = clock(),
    lookup = createPlaceLookup(timers),
    native = deferred();
  let settled = false;
  const pending = lookup.run(() => native.promise);
  pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  timers.advance(49999);
  await Promise.resolve();
  assert.equal(settled, false);
  timers.advance(1);
  assert.equal((await pending).status, 'timeout');
  const retry = lookup.run(() => native.promise);
  await Promise.resolve();
  lookup.cancel();
  assert.equal((await retry).status, 'cancelled');
  assert.equal(timers.count(), 0);
});

test('provider result must match request identity and bounded place details', () => {
  const original = candidate(),
    result = validatePlaceCandidate(original, 'map', point);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.coordinate));
  assert.notEqual(result.coordinate, original.coordinate);
  assert.equal(validatePlaceCandidate(candidate({ label: '   ' }), 'map', point).label, null);
  for (const changed of [
    { source: 'device' },
    { coordinate: { ...point, latitude: 6 } },
    { capturedAtMs: NaN },
    { capturedAtMs: -1 },
    { accuracyMeters: -2 },
    { accuracyMeters: Infinity },
    { label: 'a'.repeat(241) },
    { label: 12 },
  ])
    assert.throws(() => validatePlaceCandidate(candidate(changed), 'map', point));
});

test('confirmation contains only a label and honest source; edited/manual labels do not inherit native provenance', () => {
  const provider = validatePlaceCandidate(candidate(), 'map', point);
  assert.deepEqual(confirmedPlace(' Synthetic public place ', provider), {
    label: 'Synthetic public place',
    source: 'map',
  });
  assert.deepEqual(confirmedPlace('My chosen name', provider), {
    label: 'My chosen name',
    source: 'manual',
  });
  assert.deepEqual(confirmedPlace('Synthetic public place', null), {
    label: 'Synthetic public place',
    source: 'manual',
  });
  assert.deepEqual(Object.keys(confirmedPlace('Name', null)).sort(), ['label', 'source']);
  for (const label of ['', '  ', 'a'.repeat(241), null])
    assert.throws(() => confirmedPlace(label, null));
});

test('Expo Go, unsupported platform and missing native module never evaluate MapLibre runtime', () => {
  for (const options of [
    { platform: 'android', isExpoGo: true },
    { platform: 'web', isExpoGo: false },
  ]) {
    const result = loadMapRuntime({
      ...options,
      getNativeModule() {
        throw Error('must not probe');
      },
      loadRuntime() {
        throw Error('must not import');
      },
    });
    assert.equal(result.available, false);
  }
  let imports = 0;
  const result = loadMapRuntime({
    platform: 'android',
    isExpoGo: false,
    getNativeModule(name) {
      assert.equal(name, 'MLRNMapViewModule');
      return null;
    },
    loadRuntime() {
      imports++;
    },
  });
  assert.equal(result.available, false);
  assert.equal(imports, 0);
});

test('installed module reaches runtime, while stale binary/import failure stays recoverable', () => {
  const runtime = { Map: {}, Camera: {}, Marker: {} };
  const options = {
    platform: 'android',
    isExpoGo: false,
    getNativeModule: () => ({}),
    loadRuntime: () => runtime,
  };
  assert.deepEqual(loadMapRuntime(options), { available: true, runtime });
  assert.equal(
    loadMapRuntime({
      ...options,
      loadRuntime() {
        throw Error('native unavailable');
      },
    }).available,
    false,
  );
  assert.equal(loadMapRuntime({ ...options, loadRuntime: () => ({}) }).available, false);
});

test('new selection cancels prior lookup and a late provider result cannot be current', async () => {
  const timers = clock(),
    lookup = createPlaceLookup(timers),
    a = deferred(),
    b = deferred();
  const first = lookup.run(() => a.promise);
  await Promise.resolve();
  const second = lookup.run(() => b.promise);
  await Promise.resolve();
  const cancelled = await first;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(lookup.isCurrent(cancelled), false);
  a.resolve(candidate({ label: 'Old place' }));
  b.resolve(candidate({ label: 'New place' }));
  const result = await second;
  assert.equal(result.status, 'success');
  assert.equal(result.value.label, 'New place');
  assert.equal(lookup.isCurrent(result), true);
  assert.equal(timers.count(), 0);
});

test('manual edit/cancel invalidates even a result settled just before its UI continuation', async () => {
  const lookup = createPlaceLookup(clock());
  const result = await lookup.run(async () => candidate());
  lookup.cancel();
  assert.equal(lookup.isCurrent(result), false);
  assert.deepEqual(confirmedPlace('Typed name', null), { label: 'Typed name', source: 'manual' });
});

test('timeout releases pending UI work, ignores late completion, and allows a successful retry', async () => {
  const timers = clock(),
    lookup = createPlaceLookup(timers),
    native = deferred();
  const pending = lookup.run(() => native.promise);
  await Promise.resolve();
  timers.expire();
  assert.equal((await pending).status, 'timeout');
  assert.equal(timers.count(), 0);
  native.resolve(candidate({ label: 'Late place' }));
  const retried = await lookup.run(async () => candidate({ label: 'Retry place' }));
  assert.equal(retried.status, 'success');
  assert.equal(retried.value.label, 'Retry place');
});

test('closing before work starts prevents unnecessary provider call; errors and effect replay do not poison later requests', async () => {
  const timers = clock(),
    lookup = createPlaceLookup(timers);
  let calls = 0;
  const closing = lookup.run(async () => {
    calls++;
    return candidate();
  });
  lookup.cancel();
  assert.equal((await closing).status, 'cancelled');
  assert.equal(calls, 0);
  assert.equal(
    (
      await lookup.run(async () => {
        throw Error('Provider failure');
      })
    ).status,
    'error',
  );
  lookup.cancel();
  assert.equal((await lookup.run(async () => candidate())).status, 'success');
  assert.equal(timers.count(), 0);
});
