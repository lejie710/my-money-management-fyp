const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCompanionConnection } = require('../src/companion/connection');
const { providerRequestBinding } = require('../src/companion/providerContract');
const value = () => ({
  version: 2,
  runId: 'provider-test',
  url: 'http://127.0.0.1:8787/v1/recognize',
  token: 'a'.repeat(43),
  providers: {
    ocr: { engine: 'google-cloud-vision', processing: 'cloud', maxImageBytes: 6291456 },
    assistant: { engine: 'openai', processing: 'cloud', model: 'selected-model' },
    forecast: null,
  },
});
const parse = (v) =>
  parseCompanionConnection(Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)));
test('v2 pairing exposes only explicit immutable providers with the private fixed endpoint', () => {
  const source = value(),
    result = parse(source);
  assert.deepEqual(result, source);
  assert.ok(Object.isFrozen(result.providers.assistant));
  assert.equal(JSON.parse(providerRequestBinding(result, 'assistant'))[1], source.runId);
});
test('duplicate nested or escaped keys are rejected independently in every object', () => {
  const raw = JSON.stringify(value());
  for (const bad of [
    raw.replace('"engine":"openai"', '"engine":"lemonade","engine":"openai"'),
    raw.replace('"model":"selected-model"', '"model":"wrong","mo\\u0064el":"selected-model"'),
    raw.replace('"version":2', '"version":1,"version":2'),
  ])
    assert.throws(() => parse(bad));
  assert.equal(
    parse(raw.replace('"model":"selected-model"', '"mo\\u0064el":"selected-model"')).providers
      .assistant.model,
    'selected-model',
  );
});
test('v2 cannot carry provider credentials, arbitrary URLs or fabricated limits', () => {
  for (const mutate of [
    (v) => (v.providers.assistant.apiKey = 'private'),
    (v) => (v.url = 'https://example.com'),
    (v) => (v.providers.ocr.maxImageBytes = 10485760),
    (v) => (v.providers.assistant.processing = 'local'),
    (v) =>
      (v.providers.forecast = {
        engine: 'prophet',
        processing: 'local',
        version: 'unexpected',
        maxHistoryMonths: 120,
      }),
  ]) {
    const v = value();
    mutate(v);
    assert.throws(() => parse(v));
  }
});
test('v1 wire shape remains exact and cannot opt into cloud metadata', () => {
  const v = value();
  v.version = 1;
  assert.throws(() => parse(v));
  delete v.providers;
  assert.deepEqual(parse(v), v);
});
