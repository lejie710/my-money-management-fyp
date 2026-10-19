const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
function allowedFiles() {
  const patterns = fs
    .readFileSync(path.join(root, '.dockerignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.equal(patterns.shift(), '**', 'The context must start excluded.');
  const names = patterns.map((line) => {
    assert.match(line, /^![A-Za-z0-9_.\/-]+$/, 'Exceptions must be literal canonical file paths.');
    const name = line.slice(1);
    assert(
      !name.startsWith('/') &&
        !name.endsWith('/') &&
        !name.split('/').some((part) => !part || part === '.' || part === '..'),
    );
    const info = fs.lstatSync(path.join(root, name));
    assert(
      info.isFile() && !info.isSymbolicLink(),
      'A directory exception would include its descendants.',
    );
    return name;
  });
  assert.equal(new Set(names).size, names.length);
  return new Set(names);
}
// For this restricted grammar, Docker matches ** first and then exact paths or
// their parent paths. No wildcard emulator or third-party matcher is involved.
// See moby/patternmatcher MatchesOrParentMatches and Docker context documentation.
function excludedByLiteralPolicy(names, filename) {
  const parts = filename.split('/');
  return !parts.some((_, index) => names.has(parts.slice(0, index + 1).join('/')));
}
test('Docker context permits only reviewed files and excludes private configuration and runtime probes', () => {
  const names = allowedFiles();
  for (const name of names) assert.equal(excludedByLiteralPolicy(names, name), false);
  for (const filename of [
    'tools/backend/private.json',
    'tools/backend/.env',
    'tools/backend/.env.production',
    'tools/backend/private.sqlite',
    'tools/backend/private.sqlite-wal',
    'tools/backend/private.sqlite-shm',
    'tools/backend/nested/private.json',
    'tools/backend/private.pem',
    'tools/backend/private.key',
    'tools/backend/.runtime/private.sqlite',
    'src/private.json',
    'src/private.js',
    'src/services/private.json',
    '.runtime/private.sqlite',
    '.git/config',
    'tools/forecast/private.json',
    'scripts/companion/assistant/private.json',
    'node_modules/private.json',
  ])
    assert.equal(excludedByLiteralPolicy(names, filename), true, filename);
});
test('Docker exact file list retains Node imports and both portable model worker source paths', () => {
  const names = allowedFiles();
  for (const filename of [
    'LICENSE',
    'tools/backend/Dockerfile',
    'tools/backend/.env.example',
    'tools/backend/README.md',
    'tools/backend/requirements-python312.txt',
    'tools/backend/main.cjs',
    'tools/backend/forecast_service_main.py',
    'tools/backend/linux_runner.py',
    'tools/backend/linux_fit_guardian.py',
    'tools/forecast/forecast_service.py',
    'tools/forecast/monthly_forecast.py',
    'tools/forecast/prophet_worker.py',
    'tools/forecast/windows_runner.py',
    'tools/forecast/service_main.py',
    'scripts/companion/owned_process.py',
  ])
    assert(names.has(filename), 'Missing runtime source: ' + filename);
  for (const filename of names) {
    if (!/\.(?:c?js)$/.test(filename)) continue;
    const content = fs.readFileSync(path.join(root, filename), 'utf8');
    for (const match of content.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = match[1];
      if (!spec.startsWith('.')) {
        assert(spec.startsWith('node:'), 'Unexpected package dependency: ' + spec);
        continue;
      }
      const base = path.resolve(root, path.dirname(filename), spec);
      const resolved = [base, base + '.js', base + '.cjs', path.join(base, 'index.js')].find(
        (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
      );
      assert(resolved, 'Unresolved local import in ' + filename);
      const relative = path.relative(root, resolved).split(path.sep).join('/');
      assert(names.has(relative), 'Excluded transitive import: ' + relative);
    }
  }
  const pythonRoots = ['tools/backend', 'tools/forecast', 'scripts/companion'];
  for (const filename of names) {
    if (!filename.endsWith('.py')) continue;
    const content = fs.readFileSync(path.join(root, filename), 'utf8');
    for (const match of content.matchAll(
      /^\s*(?:from\s+([A-Za-z_]\w*)\s+import|import\s+([A-Za-z_]\w*))/gm,
    )) {
      const module = match[1] || match[2];
      const local = pythonRoots
        .map((dir) => dir + '/' + module + '.py')
        .filter((rel) => fs.existsSync(path.join(root, rel)));
      for (const relative of local)
        assert(names.has(relative), 'Excluded Python import: ' + relative);
    }
  }
});
