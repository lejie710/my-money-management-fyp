const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path'),
  fs = require('node:fs');
const { configuration } = require('../main.cjs');
function template() {
  const lines = fs
    .readFileSync(path.join(__dirname, '../.env.example'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'));
  const value = Object.fromEntries(
    lines.map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }),
  );
  return {
    ...value,
    FIREBASE_PROJECT_ID: 'project-finance-reference',
    BACKEND_DATA_DIR: path.resolve('.runtime/backend-test-config'),
    TRUSTED_TLS_PROXY: '1',
  };
}
for (const capability of ['assistant', 'ocr', 'forecast'])
  test(`copied placeholder template supports ${capability}-only setup with unused keys empty`, () => {
    const env = template();
    if (capability === 'assistant') {
      env.OPENAI_API_KEY = 'synthetic-openai-placeholder';
      env.OPENAI_MODEL = 'compatible-model';
    }
    if (capability === 'ocr') env.GOOGLE_VISION_API_KEY = 'synthetic-vision-placeholder';
    if (capability === 'forecast') {
      env.ENABLE_PROPHET = '1';
      env.PROPHET_PYTHON = path.resolve('.runtime/python.exe');
    }
    const result = configuration(env);
    assert.ok(result.providers[capability]);
    for (const other of ['assistant', 'ocr', 'forecast'].filter((v) => v !== capability))
      assert.equal(result.providers[other], null);
  });
test('nonempty invalid unused credential is still rejected', () => {
  const env = {
    ...template(),
    ENABLE_PROPHET: '1',
    PROPHET_PYTHON: path.resolve('.runtime/python.exe'),
  };
  for (const invalid of [' ', 'short', 123])
    assert.throws(() => configuration({ ...env, GOOGLE_VISION_API_KEY: invalid }));
});
test('hosted setup requires actual TLS configuration or explicit proxy trust', () => {
  const env = {
    ...template(),
    OPENAI_API_KEY: 'synthetic-openai-placeholder',
    OPENAI_MODEL: 'compatible-model',
    TRUSTED_TLS_PROXY: '0',
  };
  assert.throws(() => configuration(env));
  assert.throws(() =>
    configuration({ ...env, TRUSTED_TLS_PROXY: '1', TRUSTED_PROXY_PEERS: 'anywhere' }),
  );
  assert.equal(
    configuration({ ...env, TLS_KEY_FILE: 'private-key-file', TLS_CERT_FILE: 'private-cert-file' })
      .trustTlsProxy,
    false,
  );
});
