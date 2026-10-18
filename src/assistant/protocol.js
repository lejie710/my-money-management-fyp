const { validDate, CURRENCIES } = require('../core/model');
const {
  MODEL_ID,
  SYSTEM_PROMPT,
  encodeData,
  MAX_QUESTION_LENGTH,
  MAX_PROMPT_CHARACTERS,
} = require('./grounding');
const BASE_IDS = [
  'selection',
  'data',
  'activity',
  'opening',
  'income',
  'expense',
  'debt',
  'outflow',
  'net',
  'closing',
  'ratios',
];
const OPTIONAL_IDS = [
  'outflowRatio',
  'retainedRatio',
  'allDates',
  'categoryScope',
  'category1',
  'category2',
  'category3',
  'goalScope',
  'goal',
  'goalTarget',
  'goalRemaining',
  'goalExcess',
  'goalStatus',
  'budgetScope',
  'budget1',
  'budget2',
  'budget3',
  'healthScope',
  'health',
];
const MESSAGES = Object.freeze({
  UNAUTHORIZED: 'The local assistant connection expired. Reopen the companion connection.',
  BAD_REQUEST: 'The selected financial context could not be sent.',
  TOO_LARGE: 'Select fewer financial details or ask a shorter question.',
  CONTEXT_TOO_LARGE: 'The selected facts exceed the assistant context limit. Select fewer details.',
  BUSY: 'The selected model is still finishing another request. Wait, then try again.',
  MODEL_UNAVAILABLE: 'The selected model is unavailable. Check or restart the Windows companion.',
  TIMEOUT: 'The explanation took too long. Review the companion before retrying deliberately.',
  CANCELLED: 'The explanation was cancelled.',
  INVALID_MODEL_RESPONSE:
    'The model response could not be verified. The calculated facts remain available.',
  NETWORK: 'The local companion could not be reached. The calculated facts remain available.',
  FAILED: 'The explanation could not be completed.',
  PROVIDER_MISMATCH: 'The configured assistant changed. Re-pair the companion before asking again.',
  PROVIDER_AUTH:
    'The selected provider rejected its server credential or access. Check the private companion configuration.',
  RATE_LIMITED:
    'The selected provider cannot accept another request. Check its limits before retrying deliberately.',
  REFUSED: 'The selected provider declined this question. The calculated facts remain available.',
  INCOMPLETE: 'The explanation did not finish. No partial answer was accepted.',
});
class AssistantError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.FAILED);
    this.name = 'AssistantError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'FAILED';
  }
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) =>
  object(value) && Object.keys(value).sort().join(',') === names.sort().join(',');
const requestId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{16,96}$/.test(value);
function validateWire(value) {
  if (
    !keys(value, [
      'version',
      'requestId',
      'templateVersion',
      'period',
      'currency',
      'facts',
      'question',
    ]) ||
    value.version !== 1 ||
    !requestId(value.requestId) ||
    value.templateVersion !== 'recorded-facts-v1' ||
    !keys(value.period, ['startDate', 'endDate', 'inclusive']) ||
    value.period.inclusive !== true ||
    !validDate(value.period.startDate) ||
    !validDate(value.period.endDate) ||
    value.period.startDate > value.period.endDate ||
    !CURRENCIES.some((item) => item.code === value.currency) ||
    typeof value.question !== 'string' ||
    !value.question.trim() ||
    value.question.length > MAX_QUESTION_LENGTH ||
    !Array.isArray(value.facts) ||
    value.facts.length < BASE_IDS.length ||
    value.facts.length > 32
  )
    throw new AssistantError('BAD_REQUEST');
  const seen = new Set();
  for (const fact of value.facts) {
    if (
      !keys(fact, ['id', 'label', 'value']) ||
      ![...BASE_IDS, ...OPTIONAL_IDS].includes(fact.id) ||
      seen.has(fact.id) ||
      typeof fact.label !== 'string' ||
      !fact.label ||
      fact.label.length > 160 ||
      typeof fact.value !== 'string' ||
      !fact.value ||
      fact.value.length > 400
    )
      throw new AssistantError('BAD_REQUEST');
    seen.add(fact.id);
  }
  if (BASE_IDS.some((id) => !seen.has(id))) throw new AssistantError('BAD_REQUEST');
  return {
    version: 1,
    requestId: value.requestId,
    templateVersion: value.templateVersion,
    period: { ...value.period },
    currency: value.currency,
    facts: value.facts.map((fact) => ({ ...fact })),
    question: value.question.trim(),
  };
}
function payloadFromWire(value) {
  const wire = validateWire(value);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: encodeData({
        selectedPeriod: wire.period,
        currency: wire.currency,
        facts: wire.facts,
      }),
    },
    { role: 'user', content: encodeData({ question: wire.question }) },
  ];
  if (messages.reduce((sum, row) => sum + row.content.length, 0) > MAX_PROMPT_CHARACTERS)
    throw new AssistantError('CONTEXT_TOO_LARGE');
  return {
    model: MODEL_ID,
    messages,
    temperature: 0,
    seed: 7,
    max_tokens: 160,
    stream: false,
  };
}
function wireFromPayload(payload, id) {
  if (
    !payload ||
    payload.model !== MODEL_ID ||
    !Array.isArray(payload.messages) ||
    payload.messages.length !== 3 ||
    payload.messages[0].role !== 'system' ||
    payload.messages[0].content !== SYSTEM_PROMPT ||
    payload.messages[1].role !== 'user' ||
    payload.messages[2].role !== 'user'
  )
    throw new AssistantError('BAD_REQUEST');
  let facts, question;
  try {
    facts = JSON.parse(payload.messages[1].content);
    question = JSON.parse(payload.messages[2].content);
  } catch {
    throw new AssistantError('BAD_REQUEST');
  }
  if (!keys(facts, ['selectedPeriod', 'currency', 'facts']) || !keys(question, ['question']))
    throw new AssistantError('BAD_REQUEST');
  return validateWire({
    version: 1,
    requestId: id,
    templateVersion: 'recorded-facts-v1',
    period: facts.selectedPeriod,
    currency: facts.currency,
    facts: facts.facts,
    question: question.question,
  });
}
// llama.cpp b11393 supports schema-constrained JSON via response_format.
// The companion derives this grammar from its validated fact set; the mobile client
// cannot choose a schema, and numeric/invented evidence IDs are never coerced.
function responseFormatForPayload(payload) {
  const wire = wireFromPayload(payload, 'schema-validation');
  return {
    type: 'json_object',
    schema: {
      type: 'object',
      properties: {
        answer: { type: 'string', minLength: 1, maxLength: 1200 },
        factIds: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: { type: 'string', enum: wire.facts.map((fact) => fact.id) },
        },
      },
      required: ['answer', 'factIds'],
      additionalProperties: false,
    },
  };
}
// Exact no-tools, three-string-message branch of the pinned GGUF chat template.
function renderQwenPrompt(payload) {
  if (
    !payload ||
    !Array.isArray(payload.messages) ||
    payload.messages.length !== 3 ||
    payload.messages.some(
      (message, index) =>
        message.role !== (index === 0 ? 'system' : 'user') || typeof message.content !== 'string',
    )
  )
    throw new AssistantError('BAD_REQUEST');
  return (
    payload.messages
      .map((message) => `<|im_start|>${message.role}\n${message.content}<|im_end|>\n`)
      .join('') + '<|im_start|>assistant\n'
  );
}
module.exports = {
  AssistantError,
  MESSAGES,
  MODEL_ID,
  requestId,
  validateWire,
  payloadFromWire,
  wireFromPayload,
  responseFormatForPayload,
  renderQwenPrompt,
};
