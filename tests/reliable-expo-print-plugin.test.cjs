const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const {
  applyReliableExpoPrint,
  patchModule,
  ORIGINAL_MODULE_SHA,
  ORIGINAL_RENDER_SHA,
} = require('../plugins/withReliableExpoPrint');
const patchRoot = path.resolve(__dirname, '../plugins/expo-print-58.0.6');
const fixtures = path.join(__dirname, 'fixtures/expo-print-58.0.6');
const manifest = JSON.parse(fs.readFileSync(path.join(patchRoot, 'patch-manifest.json'), 'utf8'));
const hash = (text) =>
  crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
function fixture() {
  const parent = fs.realpathSync(os.tmpdir()),
    root = fs.mkdtempSync(path.join(parent, 'fyp-print-patch-'));
  const moduleRoot = path.join(root, 'node_modules/expo-print'),
    native = path.join(moduleRoot, 'android/src/main/java/expo/modules/print');
  fs.mkdirSync(native, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ expo: { autolinking: { android: { buildFromSource: ['expo-print'] } } } }),
  );
  fs.writeFileSync(
    path.join(moduleRoot, 'package.json'),
    JSON.stringify({ name: 'expo-print', version: '58.0.6' }),
  );
  for (const name of ['PrintModule.kt', 'PrintPDFRenderTask.kt'])
    fs.copyFileSync(path.join(fixtures, name), path.join(native, name));
  return {
    root,
    moduleRoot,
    native,
    close() {
      const resolved = path.resolve(root);
      assert.equal(path.dirname(resolved), parent);
      assert.ok(path.basename(resolved).startsWith('fyp-print-patch-'));
      fs.rmSync(resolved, { recursive: true });
    },
  };
}
function withFixture(work) {
  const value = fixture();
  try {
    return work(value);
  } finally {
    value.close();
  }
}
test('reviewed upstream fixtures and replacement output match exact versioned hashes', () => {
  const source = fs.readFileSync(path.join(fixtures, 'PrintModule.kt'), 'utf8');
  assert.equal(hash(source), ORIGINAL_MODULE_SHA);
  assert.equal(
    hash(fs.readFileSync(path.join(fixtures, 'PrintPDFRenderTask.kt'), 'utf8')),
    ORIGINAL_RENDER_SHA,
  );
  assert.equal(hash(patchModule(source)), manifest.patchedModuleSha256);
  assert.equal(
    hash(fs.readFileSync(path.join(patchRoot, 'ReliablePdfRenderTask.kt'), 'utf8')),
    manifest.helperSha256,
  );
});
test('fresh application is exact, exposes native capability and repeated application writes nothing', () =>
  withFixture((value) => {
    assert.deepEqual(applyReliableExpoPrint(value.root), {
      changed: true,
      version: '58.0.6',
      capability: 'ReliablePdfVersion',
      value: 1,
    });
    const module = path.join(value.native, 'PrintModule.kt'),
      helper = path.join(value.native, 'ReliablePdfRenderTask.kt');
    assert.equal(hash(fs.readFileSync(module, 'utf8')), manifest.patchedModuleSha256);
    assert.equal(hash(fs.readFileSync(helper, 'utf8')), manifest.helperSha256);
    const before = [fs.statSync(module).mtimeMs, fs.statSync(helper).mtimeMs];
    assert.equal(applyReliableExpoPrint(value.root).changed, false);
    assert.deepEqual([fs.statSync(module).mtimeMs, fs.statSync(helper).mtimeMs], before);
    assert.equal(
      (fs.readFileSync(module, 'utf8').match(/Constant\("ReliablePdfVersion"\)/g) || []).length,
      1,
    );
  }));
test('a missing owned helper is repaired only for a recognized module', () =>
  withFixture((value) => {
    applyReliableExpoPrint(value.root);
    fs.unlinkSync(path.join(value.native, 'ReliablePdfRenderTask.kt'));
    assert.equal(applyReliableExpoPrint(value.root).changed, true);
    assert.equal(
      hash(fs.readFileSync(path.join(value.native, 'ReliablePdfRenderTask.kt'), 'utf8')),
      manifest.helperSha256,
    );
  }));
test('a changed package version is refused before modifying native source', () =>
  withFixture((value) => {
    fs.writeFileSync(
      path.join(value.moduleRoot, 'package.json'),
      JSON.stringify({ name: 'expo-print', version: '58.0.7' }),
    );
    assert.throws(() => applyReliableExpoPrint(value.root), /58\.0\.6/);
    assert.equal(
      hash(fs.readFileSync(path.join(value.native, 'PrintModule.kt'), 'utf8')),
      ORIGINAL_MODULE_SHA,
    );
    assert.equal(fs.existsSync(path.join(value.native, 'ReliablePdfRenderTask.kt')), false);
  }));
test('unknown upstream module, renderer and helper changes are retained and refused', () => {
  for (const name of ['PrintModule.kt', 'PrintPDFRenderTask.kt', 'ReliablePdfRenderTask.kt'])
    withFixture((value) => {
      const file = path.join(value.native, name),
        text =
          (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') + '\n// unrelated change\n';
      fs.writeFileSync(file, text);
      assert.throws(() => applyReliableExpoPrint(value.root));
      assert.equal(fs.readFileSync(file, 'utf8'), text);
    });
});
test('precompiled publication cannot silently bypass the source repair', () => {
  for (const selection of [undefined, [], ['expo-sharing'], 'expo-print'])
    withFixture((value) => {
      fs.writeFileSync(
        path.join(value.root, 'package.json'),
        JSON.stringify({ expo: { autolinking: { android: { buildFromSource: selection } } } }),
      );
      assert.throws(() => applyReliableExpoPrint(value.root), /buildFromSource/);
      assert.equal(
        hash(fs.readFileSync(path.join(value.native, 'PrintModule.kt'), 'utf8')),
        ORIGINAL_MODULE_SHA,
      );
    });
});
test('native structure retains until cleanup, waits for layout, handles every terminal callback and measures written PDF', () => {
  const helper = fs.readFileSync(path.join(patchRoot, 'ReliablePdfRenderTask.kt'), 'utf8');
  const fragment = fs.readFileSync(path.join(patchRoot, 'printToFile.kt.fragment'), 'utf8');
  assert.match(fragment, /activePdfTasks\.add\(task\)/);
  assert.match(fragment, /activePdfTasks\.remove\(finished\)/);
  assert.match(fragment, /invokeOnCancellation \{ task\.cancel\(\) \}/);
  assert.ok(fragment.indexOf('if (!file.createNewFile())') < fragment.indexOf('MODE_TRUNCATE'));
  assert.match(helper, /onLayoutFinished[^\n]*= onMain/);
  assert.match(helper, /onWriteFinished[^\n]*= onMain/);
  assert.ok(helper.indexOf('adapter.onWrite(') > helper.indexOf('onLayoutFinished'));
  for (const callback of [
    'onLayoutFailed',
    'onLayoutCancelled',
    'onWriteFailed',
    'onWriteCancelled',
    'onRenderProcessGone',
  ])
    assert.ok(helper.includes(callback));
  assert.match(helper, /postDelayed\(timeout, 60_000L\)/);
  assert.match(helper, /if \(terminal\) return\s+terminal = true/);
  assert.match(helper, /PdfRenderer\(readDescriptor\)/);
  assert.match(helper, /renderer\.use \{ it\.pageCount \}/);
  assert.match(helper, /inspectionStarted = true/);
  assert.ok(helper.indexOf('inspector.execute {') < helper.indexOf('PdfRenderer(readDescriptor)'));
  assert.match(helper, /if \(!terminal\) finish\(result, failure/);
  assert.ok(
    helper.indexOf('byteCount > 25L * 1024L * 1024L') <
      helper.indexOf('PdfRenderer(readDescriptor)'),
  );
  assert.doesNotMatch(helper, /view\.contentHeight/);
  for (const value of [
    'javaScriptEnabled = false',
    'blockNetworkLoads = true',
    'allowFileAccess = false',
    'allowContentAccess = false',
  ])
    assert.ok(helper.includes(value));
  assert.match(
    helper,
    /Build\.VERSION\.SDK_INT >= 26\) RendererAwareClient\(\) else PdfClient\(\)/,
  );
  assert.ok(helper.indexOf('onComplete(this,') > helper.indexOf('view?.destroy()'));
});
test('system print and URI-preview method bytes remain unchanged', () => {
  const source = fs.readFileSync(path.join(fixtures, 'PrintModule.kt'), 'utf8'),
    patched = patchModule(source);
  const existing = source.slice(
    source.indexOf('  private suspend fun print(options:'),
    source.indexOf('  private suspend fun printToFile(options:'),
  );
  assert.ok(patched.includes(existing));
  assert.ok(
    patched.endsWith(source.slice(source.indexOf('  private fun createPrintToFileCallbacks('))),
  );
});
