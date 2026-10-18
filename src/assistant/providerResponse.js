const { MODEL_ID } = require('./grounding');
const { AssistantError } = require('./protocol');
const { validateProviders } = require('../companion/providerContract');
const LEGACY_ASSISTANT_PROVIDER = Object.freeze({
  engine: 'lemonade',
  processing: 'local',
  model: MODEL_ID,
});
function assistantProvider(value = LEGACY_ASSISTANT_PROVIDER) {
  try {
    const provider = validateProviders({ ocr: null, assistant: value, forecast: null }).assistant;
    if (!provider) throw Error();
    return provider;
  } catch {
    throw new AssistantError('MODEL_UNAVAILABLE');
  }
}
function validateAssistantResponse(
  value,
  expected = LEGACY_ASSISTANT_PROVIDER,
  legacyLocal = false,
) {
  const provider = assistantProvider(expected);
  if (
    !value ||
    value.finishReason !== 'stop' ||
    typeof value.content !== 'string' ||
    !value.content.trim() ||
    value.content.length > 1800
  )
    throw new AssistantError('INVALID_MODEL_RESPONSE');
  const provenance = value.provider;
  if (provider.engine === 'lemonade') {
    if (
      value.model !== provider.model ||
      (!legacyLocal && !provenance) ||
      (provenance &&
        (provenance.engine !== 'lemonade' ||
          provenance.model !== provider.model ||
          provenance.processing !== 'local' ||
          !['vulkan', 'cpu'].includes(provenance.backend)))
    )
      throw new AssistantError('INVALID_MODEL_RESPONSE');
  } else if (
    !provenance ||
    provenance.engine !== 'openai' ||
    provenance.processing !== 'cloud' ||
    provenance.requestedModel !== provider.model ||
    provenance.model !== value.model ||
    value.requestedModel !== provider.model ||
    typeof value.model !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value.model)
  ) {
    throw new AssistantError('INVALID_MODEL_RESPONSE');
  }
  const cleanProvider = provenance
    ? provider.engine === 'lemonade'
      ? { engine: 'lemonade', processing: 'local', model: value.model, backend: provenance.backend }
      : {
          engine: 'openai',
          processing: 'cloud',
          model: value.model,
          requestedModel: provider.model,
        }
    : null;
  return Object.freeze({
    model: value.model,
    content: value.content,
    finishReason: 'stop',
    ...(provider.engine === 'openai' ? { requestedModel: provider.model } : {}),
    ...(cleanProvider ? { provider: Object.freeze(cleanProvider) } : {}),
  });
}
module.exports = { LEGACY_ASSISTANT_PROVIDER, assistantProvider, validateAssistantResponse };
