const PROVIDER_HEADER = 'x-mymoney-provider';
const LOCAL_MODEL_ID = 'Qwen3-4B-Instruct-2507-GGUF';
const FORECAST_VERSION = 'recorded-expense-prophet-v1';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) =>
  object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const fail = () => {
  throw new Error('The companion provider configuration is invalid.');
};
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const LEGACY_PROVIDERS = freeze({
  ocr: { engine: 'windows-media-ocr', processing: 'local', maxImageBytes: 10485760 },
  assistant: { engine: 'lemonade', processing: 'local', model: LOCAL_MODEL_ID },
  forecast: null,
});
function validateProviders(value) {
  if (!keys(value, ['ocr', 'assistant', 'forecast'])) fail();
  let ocr = null,
    assistant = null,
    forecast = null;
  if (value.ocr !== null) {
    const item = value.ocr;
    if (!keys(item, ['engine', 'processing', 'maxImageBytes'])) fail();
    if (item.engine === 'windows-media-ocr') {
      if (item.processing !== 'local' || item.maxImageBytes !== 10485760) fail();
    } else if (item.engine === 'google-cloud-vision') {
      if (item.processing !== 'cloud' || item.maxImageBytes !== 6291456) fail();
    } else fail();
    ocr = { engine: item.engine, processing: item.processing, maxImageBytes: item.maxImageBytes };
  }
  if (value.assistant !== null) {
    const item = value.assistant;
    if (!keys(item, ['engine', 'processing', 'model'])) fail();
    if (item.engine === 'lemonade') {
      if (item.processing !== 'local' || item.model !== LOCAL_MODEL_ID) fail();
    } else if (item.engine === 'openai') {
      if (
        item.processing !== 'cloud' ||
        typeof item.model !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(item.model)
      )
        fail();
    } else fail();
    assistant = { engine: item.engine, processing: item.processing, model: item.model };
  }
  if (value.forecast !== null) {
    const item = value.forecast;
    if (
      !keys(item, ['engine', 'processing', 'version', 'maxHistoryMonths']) ||
      item.engine !== 'prophet' ||
      item.processing !== 'local' ||
      item.version !== FORECAST_VERSION ||
      item.maxHistoryMonths !== 120
    )
      fail();
    forecast = {
      engine: 'prophet',
      processing: 'local',
      version: FORECAST_VERSION,
      maxHistoryMonths: 120,
    };
  }
  if (ocr === null && assistant === null && forecast === null) fail();
  return freeze({ ocr, assistant, forecast });
}
function providersForConnection(configuration) {
  if (!object(configuration)) fail();
  if (configuration.version === undefined || configuration.version === 1) {
    if (Object.hasOwn(configuration, 'providers')) fail();
    return LEGACY_PROVIDERS;
  }
  if (configuration.version !== 2) fail();
  return validateProviders(configuration.providers);
}
function getProvider(configuration, capability) {
  if (!['ocr', 'assistant', 'forecast'].includes(capability)) fail();
  return providersForConnection(configuration)[capability];
}
function providerRequestBinding(configuration, capability) {
  const descriptor = getProvider(configuration, capability);
  if (configuration.version === undefined || configuration.version === 1) return null;
  if (
    descriptor === null ||
    typeof configuration.runId !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(configuration.runId)
  )
    fail();
  return JSON.stringify([2, configuration.runId, capability, descriptor]);
}
module.exports = {
  PROVIDER_HEADER,
  LOCAL_MODEL_ID,
  FORECAST_VERSION,
  LEGACY_PROVIDERS,
  validateProviders,
  providersForConnection,
  getProvider,
  providerRequestBinding,
};
