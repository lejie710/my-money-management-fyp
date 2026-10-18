const { validDate, CURRENCIES, MAX_AMOUNT_MINOR, MAX_TRANSACTIONS } = require('../core/model');
const VERSION = 'recorded-expense-prophet-v1';
const MAX_MONEY = MAX_AMOUNT_MINOR * MAX_TRANSACTIONS;
const MESSAGES = Object.freeze({
  BAD_REQUEST: 'The selected monthly history could not be sent.',
  INSUFFICIENT_OR_EXCESS_HISTORY:
    'Prophet needs 8 to 120 complete months. The device forecast remains available.',
  INSUFFICIENT_ACTIVE_HISTORY: 'Prophet needs expenses in at least three completed months.',
  UNAVAILABLE: 'Prophet is not available from the current companion connection.',
  UNAUTHORIZED: 'The companion connection changed. Recheck it before requesting Prophet.',
  PROVIDER_CHANGED: 'The forecast provider changed. Recheck the connection and request it again.',
  BUSY: 'Prophet is still finishing another request. Wait, then try again.',
  TIMEOUT: 'Prophet exceeded its computation deadline. The device forecast is unchanged.',
  CANCELLED: 'The Prophet request was cancelled.',
  CLEANUP_UNCONFIRMED:
    'The previous Prophet worker has not confirmed shutdown. Restart the owned companion before retrying.',
  MODEL_FAILED: 'Prophet could not fit this history. The device forecast remains available.',
  INVALID_MODEL_RESPONSE: 'The Prophet response could not be verified.',
  TOO_LARGE: 'The forecast request or response exceeds the supported size.',
  NETWORK: 'The local Prophet service could not be reached.',
});
class ForecastError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.MODEL_FAILED);
    this.name = 'ForecastError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'MODEL_FAILED';
  }
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) =>
  object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{16,96}$/.test(value);
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function ordinal(month) {
  if (typeof month !== 'string' || !/^[0-9]{4}-[0-9]{2}$/.test(month) || !validDate(month + '-01'))
    throw new ForecastError('BAD_REQUEST');
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1;
}
function label(number) {
  const year = Math.floor(number / 12),
    month = (number % 12) + 1;
  if (year < 1900 || year > 2100) throw new ForecastError('BAD_REQUEST');
  return `${year}-${String(month).padStart(2, '0')}`;
}
function validateInput(value) {
  if (
    !keys(value, ['version', 'currency', 'asOfDate', 'history', 'targetMonths']) ||
    value.version !== VERSION ||
    !CURRENCIES.some((row) => row.code === value.currency) ||
    !validDate(value.asOfDate)
  )
    throw new ForecastError('BAD_REQUEST');
  if (!Array.isArray(value.history) || value.history.length < 8 || value.history.length > 120)
    throw new ForecastError('INSUFFICIENT_OR_EXCESS_HISTORY');
  const through = ordinal(value.asOfDate.slice(0, 7)) - 1;
  let previous = null,
    active = 0;
  for (const row of value.history) {
    if (
      !keys(row, ['month', 'expenseMinor']) ||
      !Number.isSafeInteger(row.expenseMinor) ||
      row.expenseMinor < 0 ||
      row.expenseMinor > MAX_MONEY
    )
      throw new ForecastError('BAD_REQUEST');
    const current = ordinal(row.month);
    if (previous !== null && current !== previous + 1) throw new ForecastError('BAD_REQUEST');
    previous = current;
    active += Number(row.expenseMinor > 0);
  }
  if (previous !== through || value.history[0].expenseMinor === 0)
    throw new ForecastError('BAD_REQUEST');
  if (active < 3) throw new ForecastError('INSUFFICIENT_ACTIVE_HISTORY');
  const targetMonths = Array.from({ length: 6 }, (_, index) => label(through + index + 2));
  if (
    !Array.isArray(value.targetMonths) ||
    value.targetMonths.length !== 6 ||
    value.targetMonths.some((month, index) => month !== targetMonths[index])
  )
    throw new ForecastError('BAD_REQUEST');
  return freeze({
    version: VERSION,
    currency: value.currency,
    asOfDate: value.asOfDate,
    history: value.history.map((row) => ({ month: row.month, expenseMinor: row.expenseMinor })),
    targetMonths,
  });
}
function validateWire(value) {
  if (
    !keys(value, ['version', 'requestId', 'currency', 'asOfDate', 'history', 'targetMonths']) ||
    !id(value.requestId)
  )
    throw new ForecastError('BAD_REQUEST');
  const { requestId, ...input } = value;
  return freeze({ ...validateInput(input), requestId });
}
function inputFromForecast(result) {
  if (!result || result.status !== 'available' || result.horizon !== 6)
    throw new ForecastError('INSUFFICIENT_OR_EXCESS_HISTORY');
  return validateInput({
    version: VERSION,
    currency: result.currency,
    asOfDate: result.asOfDate,
    history: result.history.map(({ month, expenseMinor }) => ({ month, expenseMinor })),
    targetMonths: result.forecast.map((row) => row.month),
  });
}
const SETTINGS = Object.freeze({
  growth: 'linear',
  yearly_seasonality: false,
  weekly_seasonality: false,
  daily_seasonality: false,
  uncertainty_samples: 0,
  mcmc_samples: 0,
  n_changepoints: 25,
  changepoint_prior_scale: 0.05,
});
function validateResult(value, request) {
  const wire = validateWire(request);
  if (
    !keys(value, [
      'version',
      'requestId',
      'provider',
      'currency',
      'asOfDate',
      'trainingThroughMonth',
      'trainingMonths',
      'predictionUnit',
      'rounding',
      'negativePredictionPolicy',
      'hasNegativePredictions',
      'intervals',
      'settings',
      'forecast',
    ]) ||
    value.version !== VERSION ||
    value.requestId !== wire.requestId ||
    value.provider !== 'prophet' ||
    value.currency !== wire.currency ||
    value.asOfDate !== wire.asOfDate ||
    value.trainingThroughMonth !== wire.history.at(-1).month ||
    value.trainingMonths !== wire.history.length ||
    value.predictionUnit !== 'currency-minor-unit' ||
    value.rounding !== 'half-away-from-zero' ||
    value.negativePredictionPolicy !== 'preserve-and-label' ||
    value.intervals !== null ||
    !keys(value.settings, Object.keys(SETTINGS)) ||
    Object.entries(SETTINGS).some(([key, expected]) => value.settings[key] !== expected) ||
    !Array.isArray(value.forecast) ||
    value.forecast.length !== 6
  )
    throw new ForecastError('INVALID_MODEL_RESPONSE');
  if (
    value.forecast.some(
      (row, index) =>
        !keys(row, ['month', 'lead', 'predictedMinor']) ||
        row.month !== wire.targetMonths[index] ||
        row.lead !== index + 2 ||
        !Number.isSafeInteger(row.predictedMinor) ||
        Math.abs(row.predictedMinor) > MAX_MONEY,
    ) ||
    value.hasNegativePredictions !== value.forecast.some((row) => row.predictedMinor < 0)
  )
    throw new ForecastError('INVALID_MODEL_RESPONSE');
  return freeze(JSON.parse(JSON.stringify(value)));
}
module.exports = {
  VERSION,
  MAX_MONEY,
  MESSAGES,
  SETTINGS,
  ForecastError,
  requestId: id,
  validateInput,
  validateWire,
  inputFromForecast,
  validateResult,
};
