const { MAX_PLACE_LABEL_LENGTH } = require('../core/transactionContext');
// A current fix and its reverse geocode each have a 20-second service deadline.
const PLACE_LOOKUP_TIMEOUT_MS = 50000;

function coordinate(value) {
  if (
    !value ||
    !Number.isFinite(value.latitude) ||
    !Number.isFinite(value.longitude) ||
    Math.abs(value.latitude) > 90 ||
    Math.abs(value.longitude) > 180
  )
    throw new Error('Choose a valid point on the map.');
  return Object.freeze({ latitude: value.latitude, longitude: value.longitude });
}

function coordinateFromMap(value) {
  if (!Array.isArray(value) || value.length !== 2)
    throw new Error('Choose a valid point on the map.');
  return coordinate({ longitude: value[0], latitude: value[1] });
}

function validatePlaceCandidate(value, source, requestedCoordinate) {
  if (!value || value.source !== source || !['map', 'device'].includes(source))
    throw new Error('The location service returned an invalid result.');
  const point = coordinate(value.coordinate);
  if (
    requestedCoordinate &&
    (point.latitude !== requestedCoordinate.latitude ||
      point.longitude !== requestedCoordinate.longitude)
  )
    throw new Error('The returned place does not match the selected point.');
  if (
    !Number.isSafeInteger(value.capturedAtMs) ||
    value.capturedAtMs < 0 ||
    (value.accuracyMeters !== null &&
      (!Number.isFinite(value.accuracyMeters) || value.accuracyMeters < 0))
  )
    throw new Error('The location service returned invalid location details.');
  let label = value.label;
  if (label !== null) {
    if (typeof label !== 'string')
      throw new Error('The location service returned an invalid place name.');
    label = label.trim();
    if (label.length > MAX_PLACE_LABEL_LENGTH)
      throw new Error('The returned place name is too long. Enter a shorter name.');
    if (!label) label = null;
  }
  return Object.freeze({
    label,
    coordinate: point,
    source,
    capturedAtMs: value.capturedAtMs,
    accuracyMeters: value.accuracyMeters,
  });
}

function confirmedPlace(label, candidate) {
  if (typeof label !== 'string' || !label.trim() || label.trim().length > MAX_PLACE_LABEL_LENGTH)
    throw new Error('Enter a place name of 1 to 240 characters.');
  const clean = label.trim();
  const source =
    candidate && ['map', 'device'].includes(candidate.source) && candidate.label === clean
      ? candidate.source
      : 'manual';
  return Object.freeze({ label: clean, source });
}

function loadMapRuntime({ platform, isExpoGo, getNativeModule, loadRuntime }) {
  if (platform !== 'android' && platform !== 'ios')
    return {
      available: false,
      message: 'The map is available in the installed mobile app. You can enter a place name here.',
    };
  if (isExpoGo)
    return {
      available: false,
      message:
        'Open the installed app to use the map. You can still enter a place name or request your current place.',
    };
  try {
    if (!getNativeModule('MLRNMapViewModule')) throw new Error('Native map missing');
    const runtime = loadRuntime();
    if (!runtime?.Map || !runtime.Camera || !runtime.Marker)
      throw new Error('Map components missing');
    return { available: true, runtime };
  } catch {
    return {
      available: false,
      message:
        'This installed app cannot open the map. Install the updated build, or enter a place name.',
    };
  }
}

// Cancelling only invalidates this request's UI result; native work may continue.
function createPlaceLookup({
  timeoutMs = PLACE_LOOKUP_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let generation = 0,
    active = null;
  function cancel() {
    generation += 1;
    active?.settle({ status: 'cancelled' });
  }
  function run(work) {
    cancel();
    const requestId = generation;
    return new Promise((resolve) => {
      let timer;
      const request = {
        settle(result) {
          if (active !== request) return;
          active = null;
          clearTimer(timer);
          resolve({ ...result, requestId });
        },
      };
      active = request;
      timer = setTimer(() => request.settle({ status: 'timeout' }), timeoutMs);
      Promise.resolve()
        .then(() => (active === request ? work() : undefined))
        .then(
          (value) => request.settle({ status: 'success', value }),
          () => request.settle({ status: 'error' }),
        );
    });
  }
  return { run, cancel, isCurrent: (result) => result.requestId === generation };
}

module.exports = {
  MAX_PLACE_LABEL_LENGTH,
  PLACE_LOOKUP_TIMEOUT_MS,
  coordinateFromMap,
  validatePlaceCandidate,
  confirmedPlace,
  loadMapRuntime,
  createPlaceLookup,
};
