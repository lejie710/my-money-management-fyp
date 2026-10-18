const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateProviders,
  getProvider,
  providerRequestBinding,
  LEGACY_PROVIDERS,
  LOCAL_MODEL_ID,
} = require('../src/companion/providerContract');
const { MODEL_ID } = require('../src/assistant/grounding');
const cloud = () => ({
  ocr: { engine: 'google-cloud-vision', processing: 'cloud', maxImageBytes: 6291456 },
  assistant: { engine: 'openai', processing: 'cloud', model: 'configured-test-model' },
  forecast: {
    engine: 'prophet',
    processing: 'local',
    version: 'recorded-expense-prophet-v1',
    maxHistoryMonths: 120,
  },
});
test('legacy transports remain strictly local, with the actual pinned model', () => {
  assert.equal(LOCAL_MODEL_ID, MODEL_ID);
  for (const config of [{}, { version: 1 }]) {
    assert.deepEqual(getProvider(config, 'ocr'), LEGACY_PROVIDERS.ocr);
    assert.deepEqual(getProvider(config, 'assistant'), LEGACY_PROVIDERS.assistant);
    assert.equal(getProvider(config, 'forecast'), null);
    assert.equal(providerRequestBinding(config, 'assistant'), null);
  }
  assert.throws(() => getProvider({ version: 1, providers: cloud() }, 'assistant'));
  assert.throws(() => getProvider({ version: 3 }, 'ocr'));
});
test('v2 canonicalizes immutable explicit providers without mutating input', () => {
  const input = cloud(),
    before = JSON.stringify(input);
  const output = validateProviders(input);
  assert.deepEqual(output, input);
  assert.equal(JSON.stringify(input), before);
  assert.ok(Object.isFrozen(output));
  assert.ok(Object.isFrozen(output.ocr));
  input.assistant.model = 'changed';
  assert.equal(output.assistant.model, 'configured-test-model');
  const reversed = { forecast: cloud().forecast, assistant: cloud().assistant, ocr: cloud().ocr };
  assert.equal(JSON.stringify(validateProviders(reversed)), JSON.stringify(output));
});
test('credentials, arbitrary endpoints, unknown capabilities and misleading limits are rejected', () => {
  for (const [path, value] of [
    ['apiKey', 'private'],
    ['url', 'https://example.com'],
    ['maxImageBytes', 10485760],
    ['processing', 'local'],
  ]) {
    const p = cloud();
    p.ocr[path] = value;
    assert.throws(() => validateProviders(p));
  }
  for (const model of ['', ' model', 'a\nmodel', '模型', 'x'.repeat(161)]) {
    const p = cloud();
    p.assistant.model = model;
    assert.throws(() => validateProviders(p));
  }
  assert.throws(() => validateProviders({ ...cloud(), other: null }));
  assert.throws(() => validateProviders({ ocr: null, assistant: null, forecast: null }));
  const p = cloud();
  p.forecast.maxHistoryMonths = 121;
  assert.throws(() => validateProviders(p));
});
test('request binding changes with run, capability and selected model, never includes credentials', () => {
  const config = { version: 2, runId: 'provider-test', providers: cloud() };
  const binding = providerRequestBinding(config, 'assistant');
  assert.deepEqual(JSON.parse(binding), [2, 'provider-test', 'assistant', cloud().assistant]);
  assert.notEqual(
    binding,
    providerRequestBinding({ ...config, runId: 'another-run' }, 'assistant'),
  );
  const changed = cloud();
  changed.assistant.model = 'another-model';
  assert.notEqual(binding, providerRequestBinding({ ...config, providers: changed }, 'assistant'));
  assert.notEqual(binding, providerRequestBinding(config, 'ocr'));
  assert.throws(() => providerRequestBinding({ ...config, runId: 'bad\nrun' }, 'assistant'));
  const disabled = { ...cloud(), assistant: null };
  assert.equal(getProvider({ ...config, providers: disabled }, 'assistant'), null);
  assert.throws(() => providerRequestBinding({ ...config, providers: disabled }, 'assistant'));
});
