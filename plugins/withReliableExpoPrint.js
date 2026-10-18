const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withDangerousMod } = require('@expo/config-plugins');
const ROOT = path.join(__dirname, 'expo-print-58.0.6');
const VERSION = '58.0.6';
const ORIGINAL_MODULE_SHA = '86756fea943cdd58785385c64e2f3fb6b77311959ad5e62a5f6c3314b428ba7c';
const ORIGINAL_RENDER_SHA = '8a7ef81a8501173a22435d0454cd4c12418246a0f97c361a34658d79a457a763';
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const normalized = (value) => value.replace(/\r\n/g, '\n');
function patchModule(source) {
  const original = normalized(source);
  if (sha(original) !== ORIGINAL_MODULE_SHA)
    throw new Error(
      'Expo Print source differs from reviewed 58.0.6; preserve it and review the compatibility patch.',
    );
  const start = original.indexOf(
    '  private suspend fun printToFile(options: PrintOptions): FilePrintResult? {',
  );
  const end = original.indexOf('  private fun createPrintToFileCallbacks(', start);
  if (start < 0 || end < 0) throw new Error('Expo Print patch anchors are missing.');
  let result =
    original.slice(0, start) +
    normalized(fs.readFileSync(path.join(ROOT, 'printToFile.kt.fragment'), 'utf8')) +
    '\n' +
    original.slice(end);
  result = result.replace(
    '  private val jobName = "Printing"',
    '  private val jobName = "Printing"\n  private val activePdfTasks = java.util.Collections.synchronizedSet(mutableSetOf<ReliablePdfRenderTask>())',
  );
  result = result.replace(
    '  override fun definition() = ModuleDefinition {',
    '  override fun definition() = ModuleDefinition {\n    Constant("ReliablePdfVersion") { 1 }\n    OnDestroy {\n      val tasks = synchronized(activePdfTasks) { activePdfTasks.toList() }\n      tasks.forEach { it.cancel() }\n    }',
  );
  return result;
}
function atomicWrite(file, bytes) {
  const temporary = file + '.fyp-' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function applyReliableExpoPrint(projectRoot) {
  const root = path.resolve(projectRoot);
  const application = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const sourceModules = application.expo?.autolinking?.android?.buildFromSource;
  if (!Array.isArray(sourceModules) || !sourceModules.includes('expo-print'))
    throw new Error(
      'Reliable PDF requires package.json expo.autolinking.android.buildFromSource to include expo-print, so the patched Kotlin replaces the precompiled publication.',
    );
  const packagePath = require.resolve('expo-print/package.json', { paths: [root] });
  const directory = path.dirname(packagePath);
  const relative = path.relative(
    fs.realpathSync(path.join(root, 'node_modules')),
    fs.realpathSync(directory),
  );
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Expo Print must be installed inside this project node_modules.');
  if (JSON.parse(fs.readFileSync(packagePath, 'utf8')).version !== VERSION)
    throw new Error(
      'Reliable PDF supports reviewed expo-print 58.0.6 only; review before updating it.',
    );
  const sourceDirectory = path.join(directory, 'android/src/main/java/expo/modules/print');
  const modulePath = path.join(sourceDirectory, 'PrintModule.kt');
  const rendererPath = path.join(sourceDirectory, 'PrintPDFRenderTask.kt');
  const helperPath = path.join(sourceDirectory, 'ReliablePdfRenderTask.kt');
  const source = normalized(fs.readFileSync(modulePath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'patch-manifest.json'), 'utf8'));
  const helper = normalized(fs.readFileSync(path.join(ROOT, 'ReliablePdfRenderTask.kt'), 'utf8'));
  const fragment = normalized(fs.readFileSync(path.join(ROOT, 'printToFile.kt.fragment'), 'utf8'));
  if (sha(helper) !== manifest.helperSha256 || sha(fragment) !== manifest.fragmentSha256)
    throw new Error('Reliable PDF patch sources changed; review and update the manifest hashes.');
  if (sha(normalized(fs.readFileSync(rendererPath, 'utf8'))) !== ORIGINAL_RENDER_SHA)
    throw new Error(
      'Expo Print renderer differs from reviewed 58.0.6; do not silently mix native lifecycles.',
    );
  if (
    fs.existsSync(helperPath) &&
    sha(normalized(fs.readFileSync(helperPath, 'utf8'))) !== manifest.helperSha256
  )
    throw new Error('Existing ReliablePdfRenderTask differs; preserve it for review.');
  const actual = sha(source);
  if (actual !== ORIGINAL_MODULE_SHA && actual !== manifest.patchedModuleSha256)
    throw new Error('Expo Print module has unrecognized edits; preserve them for review.');
  const patched = actual === ORIGINAL_MODULE_SHA ? patchModule(source) : source;
  if (sha(patched) !== manifest.patchedModuleSha256)
    throw new Error('Reviewed Expo Print patch output hash did not match.');
  const helperMissing = !fs.existsSync(helperPath);
  if (helperMissing) atomicWrite(helperPath, helper);
  if (actual === ORIGINAL_MODULE_SHA) atomicWrite(modulePath, patched);
  return {
    changed: actual === ORIGINAL_MODULE_SHA || helperMissing,
    version: VERSION,
    capability: 'ReliablePdfVersion',
    value: 1,
  };
}
function withReliableExpoPrint(config) {
  return withDangerousMod(config, [
    'android',
    async (value) => {
      applyReliableExpoPrint(value.modRequest.projectRoot);
      return value;
    },
  ]);
}
module.exports = withReliableExpoPrint;
module.exports.applyReliableExpoPrint = applyReliableExpoPrint;
module.exports.patchModule = patchModule;
module.exports.ORIGINAL_MODULE_SHA = ORIGINAL_MODULE_SHA;
module.exports.ORIGINAL_RENDER_SHA = ORIGINAL_RENDER_SHA;
