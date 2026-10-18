const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const GRADLE_URL = 'https://services.gradle.org/distributions/gradle-9.4.1-bin.zip';
const GRADLE_SHA256 = '2ab2958f2a1e51120c326cad6f385153bb11ee93b3c216c5fccebfdfbb7ec6cb';
const SDK_PACKAGES = [
  ['platforms', 'android-37.0', 'android.jar'],
  ['build-tools', '37.0.0', 'aapt2.exe'],
  ['build-tools', '36.0.0', 'aapt2.exe'],
  ['ndk', '27.1.12297006', 'source.properties'],
  ['cmake', '3.30.5', 'bin', 'cmake.exe'],
  ['cmake', '3.30.5', 'bin', 'ninja.exe'],
];
const PROTECTED = ['package.json', 'package-lock.json', 'app.json', '.gitignore'];
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function wrapperWithChecksum(text) {
  const properties = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(distributionUrl|distributionSha256Sum)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match && /^\s*(distributionUrl|distributionSha256Sum)(?:\s|[:=]|$)/.test(line))
      throw new Error(
        'Gradle wrapper distribution settings use an unsupported format; preserve them for review.',
      );
    if (!match) continue;
    if (properties.has(match[1]))
      throw new Error(
        'Gradle wrapper has duplicate distribution settings; preserve it and review the native project.',
      );
    properties.set(match[1], match[2]);
  }
  if (properties.get('distributionUrl')?.replace(/\\:/g, ':') !== GRADLE_URL)
    throw new Error(
      'This helper supports the reviewed Gradle 9.4.1 distribution only. The existing wrapper was not replaced.',
    );
  const checksum = properties.get('distributionSha256Sum');
  if (checksum !== undefined && checksum !== GRADLE_SHA256)
    throw new Error(
      'The existing Gradle checksum differs from the reviewed distribution; it was not overwritten.',
    );
  if (checksum !== undefined) return text;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  return (
    text + (text.endsWith('\n') ? '' : newline) + `distributionSha256Sum=${GRADLE_SHA256}${newline}`
  );
}

function requireFile(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile())
    throw new Error(
      `${label} is missing. Follow docs/ANDROID_SETUP.md; this helper does not install prerequisites.`,
    );
}

function runBuild({
  args = process.argv.slice(2),
  project = path.resolve(__dirname, '..'),
  platform = process.platform,
  nodeVersion = process.versions.node,
  node = process.execPath,
  env = process.env,
  run = spawnSync,
  log = console.log,
} = {}) {
  if (args.some((arg) => arg !== '--prebuild-only') || new Set(args).size !== args.length)
    throw new Error('Usage: node scripts/build-android.cjs [--prebuild-only]');
  if (platform !== 'win32')
    throw new Error('This helper covers the documented Windows Android build only.');
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (major !== 24 || minor < 12)
    throw new Error('Use Node.js 24.12 or newer within Node 24; development used 24.22.0.');
  if (!env.JAVA_HOME || !path.isAbsolute(env.JAVA_HOME))
    throw new Error('Set JAVA_HOME to an absolute JDK 17 directory.');
  if (!env.ANDROID_HOME || !path.isAbsolute(env.ANDROID_HOME))
    throw new Error('Set ANDROID_HOME to an absolute Android SDK directory.');
  if (!env.GRADLE_USER_HOME || !path.isAbsolute(env.GRADLE_USER_HOME))
    throw new Error(
      'Set GRADLE_USER_HOME to a short absolute cache path outside this repository, for example C:\\g\\money.',
    );
  project = path.resolve(project);
  const cache = path.resolve(env.GRADLE_USER_HOME);
  const cacheRelative = path.relative(project, cache);
  if (
    !cacheRelative ||
    (!cacheRelative.startsWith(`..${path.sep}`) &&
      cacheRelative !== '..' &&
      !path.isAbsolute(cacheRelative))
  )
    throw new Error(
      'GRADLE_USER_HOME must be outside this repository so build caches cannot enter the source handoff.',
    );
  if (cache.length > 60 || project.length > 80)
    log(
      'Windows path warning: prefer a short checkout and Gradle cache; the CMake bound cannot shorten every dependency path.',
    );

  const java = path.join(env.JAVA_HOME, 'bin', 'java.exe');
  requireFile(java, 'JDK java.exe');
  for (const pieces of SDK_PACKAGES)
    requireFile(path.join(env.ANDROID_HOME, ...pieces), `SDK ${pieces.slice(0, 2).join(';')}`);
  const cli = path.join(project, 'node_modules', 'expo', 'bin', 'cli');
  const template = path.join(project, 'node_modules', 'expo', 'template.tgz');
  requireFile(cli, 'Installed Expo CLI');
  requireFile(template, 'Bundled Expo template');
  for (const [name, expected] of [
    ['expo', '58.0.14'],
    ['react-native', '0.88.0'],
  ]) {
    const file = path.join(project, 'node_modules', name, 'package.json');
    requireFile(file, `Installed ${name}`);
    if (JSON.parse(fs.readFileSync(file, 'utf8')).version !== expected)
      throw new Error(
        `The reviewed build expects ${name} ${expected}; review the helper before changing native versions.`,
      );
  }
  const childEnv = {
    ...env,
    JAVA_HOME: env.JAVA_HOME,
    ANDROID_HOME: env.ANDROID_HOME,
    GRADLE_USER_HOME: cache,
    EXPO_NO_TELEMETRY: '1',
  };
  for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'path') delete childEnv[key];
  childEnv.PATH = [
    path.dirname(node),
    path.join(env.JAVA_HOME, 'bin'),
    env.PATH || env.Path || '',
  ].join(path.delimiter);
  const invoke = (executable, commandArgs, options, label) => {
    const result = run(executable, commandArgs, {
      windowsHide: true,
      shell: false,
      env: childEnv,
      ...options,
    });
    if (!result || result.error || result.signal || result.status !== 0)
      throw new Error(
        `${label} did not finish successfully${result?.error?.code === 'ETIMEDOUT' ? ' within its time limit' : ''}. Generated files were retained for inspection; no build success is claimed.`,
      );
    return result;
  };
  const version = invoke(
    java,
    ['-version'],
    { cwd: project, encoding: 'utf8', timeout: 15000, maxBuffer: 16384 },
    'Java version check',
  );
  if (!/version\s+"17(?:\.|"|\+)/.test(`${version.stdout || ''}\n${version.stderr || ''}`))
    throw new Error('JAVA_HOME does not report Java 17. No prebuild or build was started.');

  const native = path.join(project, 'android');
  if (!fs.existsSync(native)) {
    const before = new Map(
      PROTECTED.map((name) => [name, digest(fs.readFileSync(path.join(project, name)))]),
    );
    log(
      'Generating Android from the installed Expo template without installing packages or cleaning an existing native project.',
    );
    invoke(
      node,
      [
        cli,
        'prebuild',
        '--platform',
        'android',
        '--no-install',
        '--no-clean',
        '--template',
        template,
      ],
      {
        cwd: project,
        stdio: 'inherit',
        timeout: 180000,
        env: { ...childEnv, EXPO_OFFLINE: '1', CI: '1' },
      },
      'Expo prebuild',
    );
    for (const [name, hash] of before)
      if (digest(fs.readFileSync(path.join(project, name))) !== hash)
        throw new Error(
          `Prebuild changed ${name}. Review the retained change before building; nothing was reverted automatically.`,
        );
  } else {
    log('Keeping the existing android directory. Prebuild is skipped to preserve native edits.');
  }
  const wrapper = path.join(native, 'gradle', 'wrapper', 'gradle-wrapper.properties');
  const wrapperJar = path.join(native, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  requireFile(wrapper, 'Generated Gradle wrapper properties');
  requireFile(wrapperJar, 'Generated Gradle wrapper JAR');
  requireFile(path.join(native, 'app', 'build.gradle'), 'Generated Android application');
  const original = fs.readFileSync(wrapper, 'utf8');
  const pinned = wrapperWithChecksum(original);
  if (pinned !== original) {
    // Preserve every existing property and add only the verified distribution hash.
    fs.writeFileSync(wrapper, pinned, 'utf8');
    log('Pinned the reviewed Gradle 9.4.1 distribution checksum in the generated wrapper.');
  }
  if (args.includes('--prebuild-only')) {
    log(
      'Native generation and wrapper checks passed. No Gradle build, APK installation, emulator, or Metro service was started.',
    );
    return { built: false, nativePrepared: true };
  }
  log(
    'Building a local x86_64 debug APK. Gradle may download its pinned distribution and Maven dependencies; SDK auto-installation is disabled.',
  );
  // Calling the wrapper entry point directly avoids cmd.exe interpolation of paths.
  // JAVA_HOME and the wrapper properties still select the reviewed JVM/distribution.
  invoke(
    java,
    [
      '-Xmx64m',
      '-Xms64m',
      '-classpath',
      wrapperJar,
      'org.gradle.wrapper.GradleWrapperMain',
      ':app:assembleDebug',
      '--no-daemon',
      '--max-workers=2',
      '--no-parallel',
      '--console=plain',
      '-PreactNativeArchitectures=x86_64',
      '-Pandroid.cmakeVersion=3.30.5',
      '-Pexpo.android.cmakeObjectPathMax=240',
      '-Pandroid.builder.sdkDownload=false',
      '-Pkotlin.compiler.execution.strategy=in-process',
    ],
    { cwd: native, stdio: 'inherit', timeout: 3600000 },
    'Android debug build',
  );
  const apk = path.join(native, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  requireFile(apk, 'Built debug APK');
  if (fs.statSync(apk).size === 0)
    throw new Error('Gradle returned success but the debug APK is empty.');
  log(`Built ${apk}. Device installation and runtime verification are separate steps.`);
  return { built: true, nativePrepared: true, apk };
}

if (require.main === module) {
  try {
    runBuild();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { GRADLE_URL, GRADLE_SHA256, SDK_PACKAGES, wrapperWithChecksum, runBuild };
