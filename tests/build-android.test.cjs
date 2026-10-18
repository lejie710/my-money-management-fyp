const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  GRADLE_URL,
  GRADLE_SHA256,
  SDK_PACKAGES,
  wrapperWithChecksum,
  runBuild,
} = require('../scripts/build-android.cjs');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'money-build-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('money-build-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = path.join(root, 'project');
  const write = (name, content = 'fixture') => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  for (const name of ['package.json', 'package-lock.json', 'app.json', '.gitignore'])
    write(`project/${name}`, '{}');
  write('jdk/bin/java.exe');
  for (const pieces of SDK_PACKAGES) write(path.join('sdk', ...pieces));
  write('project/node_modules/expo/bin/cli');
  write('project/node_modules/expo/template.tgz');
  write('project/node_modules/expo/package.json', '{"version":"58.0.14"}');
  write('project/node_modules/react-native/package.json', '{"version":"0.88.0"}');
  const wrapper = path.join(project, 'android/gradle/wrapper/gradle-wrapper.properties');
  const generate = () => {
    write(
      'project/android/gradle/wrapper/gradle-wrapper.properties',
      options.wrapper ??
        `distributionUrl=${GRADLE_URL.replace(':', '\\:')}\ncustomProperty=preserve-me\n`,
    );
    write('project/android/gradle/wrapper/gradle-wrapper.jar');
    write('project/android/app/build.gradle', 'hand-written-native-marker');
  };
  if (options.existing) generate();
  const calls = [];
  const context = {
    project,
    platform: 'win32',
    nodeVersion: '24.22.0',
    node: path.join(root, 'node/node.exe'),
    args: options.args ?? [],
    env: {
      JAVA_HOME: path.join(root, 'jdk'),
      ANDROID_HOME: path.join(root, 'sdk'),
      GRADLE_USER_HOME: path.join(root, 'cache'),
      PATH: 'original-path',
    },
    log() {},
    run(executable, args, settings) {
      calls.push({ executable, args, settings });
      if (args[0] === '-version')
        return {
          status: 0,
          stdout: '',
          stderr: options.javaVersion ?? 'openjdk version "17.0.20"',
        };
      if (args.includes('prebuild')) {
        generate();
        if (options.prebuildMutates) write('project/package.json', '{"changed":true}');
        return options.prebuildResult ?? { status: 0 };
      }
      if (args.includes(':app:assembleDebug')) {
        if (options.emitApk !== false)
          write('project/android/app/build/outputs/apk/debug/app-debug.apk', 'synthetic-apk');
        return options.buildResult ?? { status: 0 };
      }
      throw new Error('Unexpected mocked process invocation');
    },
  };
  return { root, project, wrapper, calls, context };
}

test('fresh preparation uses local template and stops before Gradle in prebuild-only mode', (t) => {
  const f = fixture(t, { args: ['--prebuild-only'] });
  assert.deepEqual(runBuild(f.context), { built: false, nativePrepared: true });
  assert.equal(f.calls.length, 2);
  const prebuild = f.calls[1];
  assert.ok(prebuild.args.includes('--no-install'));
  assert.ok(prebuild.args.includes('--no-clean'));
  assert.equal(prebuild.args.at(-1), path.join(f.project, 'node_modules/expo/template.tgz'));
  assert.equal(prebuild.settings.env.EXPO_OFFLINE, '1');
  assert.equal(prebuild.settings.shell, false);
  assert.match(fs.readFileSync(f.wrapper, 'utf8'), new RegExp(GRADLE_SHA256));
});

test('existing native edits remain intact and wrapper checksum is idempotent', (t) => {
  const f = fixture(t, { existing: true, args: ['--prebuild-only'] });
  runBuild(f.context);
  const before = fs.readFileSync(f.wrapper);
  runBuild(f.context);
  assert.deepEqual(fs.readFileSync(f.wrapper), before);
  assert.equal(
    fs.readFileSync(path.join(f.project, 'android/app/build.gradle'), 'utf8'),
    'hand-written-native-marker',
  );
  assert.equal(
    f.calls.some((call) => call.args.includes('prebuild')),
    false,
  );
  assert.match(before.toString(), /customProperty=preserve-me/);
});

test('foreign wrapper URL, changed hash, and duplicate settings are never overwritten or built', (t) => {
  for (const wrapper of [
    'distributionUrl=https://example.invalid/gradle.zip\n',
    `distributionUrl=${GRADLE_URL}\ndistributionSha256Sum=${'0'.repeat(64)}\n`,
    `distributionUrl=${GRADLE_URL}\ndistributionUrl=${GRADLE_URL}\n`,
    `distributionUrl=${GRADLE_URL}\ndistributionUrl : https://example.invalid/other.zip\n`,
  ]) {
    const f = fixture(t, { existing: true, wrapper });
    assert.throws(() => runBuild(f.context), /wrapper|checksum|distribution/);
    assert.equal(fs.readFileSync(f.wrapper, 'utf8'), wrapper);
    assert.equal(f.calls.length, 1);
  }
});

test('prebuild failure, timeout, or protected-source change prevents building and retains evidence', (t) => {
  for (const options of [
    { prebuildResult: { status: 1, stdout: 'Finished prebuild' } },
    { prebuildResult: { status: null, error: { code: 'ETIMEDOUT' }, stdout: 'Finished prebuild' } },
    { prebuildMutates: true },
  ]) {
    const f = fixture(t, options);
    assert.throws(() => runBuild(f.context), /Prebuild|prebuild/);
    assert.equal(
      f.calls.some((call) => call.args.includes(':app:assembleDebug')),
      false,
    );
    assert.equal(fs.existsSync(f.wrapper), true);
    assert.doesNotMatch(fs.readFileSync(f.wrapper, 'utf8'), /distributionSha256Sum/);
  }
});

test('Windows, Node, JDK, SDK, and external cache prerequisites fail before a build', (t) => {
  const platform = fixture(t);
  platform.context.platform = 'linux';
  assert.throws(() => runBuild(platform.context), /Windows/);
  assert.equal(platform.calls.length, 0);
  const node = fixture(t);
  node.context.nodeVersion = '22.20.0';
  assert.throws(() => runBuild(node.context), /Node.js/);
  assert.equal(node.calls.length, 0);
  const java = fixture(t, { javaVersion: 'openjdk version "21.0.1"' });
  assert.throws(() => runBuild(java.context), /Java 17/);
  assert.equal(java.calls.length, 1);
  const sdk = fixture(t);
  fs.unlinkSync(path.join(sdk.context.env.ANDROID_HOME, ...SDK_PACKAGES[0]));
  assert.throws(() => runBuild(sdk.context), /SDK/);
  assert.equal(sdk.calls.length, 0);
  const cache = fixture(t);
  cache.context.env.GRADLE_USER_HOME = path.join(cache.project, '.gradle');
  assert.throws(() => runBuild(cache.context), /outside this repository/);
  assert.equal(cache.calls.length, 0);
});

test('debug build uses the wrapper directly, bounded workers, pinned native options, and no install or launch', (t) => {
  const f = fixture(t, { existing: true });
  const result = runBuild(f.context);
  assert.equal(result.built, true);
  const build = f.calls.at(-1);
  assert.equal(build.executable, path.join(f.context.env.JAVA_HOME, 'bin/java.exe'));
  for (const arg of [
    'org.gradle.wrapper.GradleWrapperMain',
    '--no-daemon',
    '--max-workers=2',
    '--no-parallel',
    '-PreactNativeArchitectures=x86_64',
    '-Pandroid.cmakeVersion=3.30.5',
    '-Pexpo.android.cmakeObjectPathMax=240',
    '-Pandroid.builder.sdkDownload=false',
  ])
    assert.ok(build.args.includes(arg));
  assert.equal(build.settings.shell, false);
  assert.equal(build.settings.windowsHide, true);
  assert.equal(
    f.calls.some((call) => /adb|emulator|cmd\.exe/i.test(path.basename(call.executable))),
    false,
  );
});

test('failed Gradle or a missing APK cannot be reported as a successful build', (t) => {
  const failure = fixture(t, { existing: true, buildResult: { status: 1 } });
  assert.throws(() => runBuild(failure.context), /debug build did not finish/);
  const missing = fixture(t, { existing: true, emitApk: false });
  assert.throws(() => runBuild(missing.context), /Built debug APK is missing/);
});

test('checksum insertion preserves Windows line endings and refuses duplicate hash properties', () => {
  const source = `distributionUrl=${GRADLE_URL}\r\nother=keep\r\n`;
  assert.equal(wrapperWithChecksum(source), `${source}distributionSha256Sum=${GRADLE_SHA256}\r\n`);
  assert.throws(
    () =>
      wrapperWithChecksum(
        `${source}distributionSha256Sum=${GRADLE_SHA256}\r\ndistributionSha256Sum=${GRADLE_SHA256}\r\n`,
      ),
    /duplicate/,
  );
});
