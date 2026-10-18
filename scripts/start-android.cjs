const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { launchProjectApp } = require('./project-app-launch.cjs');

const project = path.resolve(__dirname, '..');
const sdk =
  [
    process.env.ANDROID_HOME,
    path.join(process.env.USERPROFILE || '', 'DevTools', 'FYP', 'AndroidSdk'),
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'),
  ].find(
    (candidate) => candidate && fs.existsSync(path.join(candidate, 'emulator', 'emulator.exe')),
  ) || '';
const adb = path.join(sdk, 'platform-tools', 'adb.exe');
const emulator = path.join(sdk, 'emulator', 'emulator.exe');
let serial = 'emulator-5580';
const loopbackSerial = '127.0.0.1:5581';
const avdName = 'FYP_API35';
const software = process.argv.includes('--software');
const softwareGraphics = software || process.argv.includes('--software-graphics');
const headless = process.argv.includes('--headless');
const bootOnly = process.argv.includes('--boot-only');
const projectApp = process.argv.includes('--project-app');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function adbRun(args, options = {}) {
  return spawnSync(adb, ['-s', serial, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? 15000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
  });
}

async function main() {
  if (!fs.existsSync(adb) || !fs.existsSync(emulator)) {
    throw new Error('Android SDK is missing. Complete the documented Android setup first.');
  }
  const devices = spawnSync(adb, ['devices'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  if (devices.status !== 0) {
    throw new Error(
      'Android device discovery failed. Check the existing ADB connection before starting another emulator.\n' +
        (devices.stderr || devices.error?.message || ''),
    );
  }
  if (
    !devices.stdout?.includes(`${serial}\tdevice`) &&
    devices.stdout?.includes(`${loopbackSerial}\tdevice`)
  ) {
    serial = loopbackSerial;
  }
  let existingDevice = devices.stdout?.includes(`${serial}\tdevice`);
  if (!existingDevice) {
    if (
      devices.stdout?.includes('emulator-5580\toffline') ||
      devices.stdout?.includes(`${loopbackSerial}\toffline`)
    ) {
      throw new Error(
        'The configured Android emulator is offline. Reconnect it before opening another instance.',
      );
    }
    // A restarted ADB server may lose the emulator alias while the virtual phone stays alive.
    const reconnect = spawnSync(adb, ['connect', loopbackSerial], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    if (reconnect.error || reconnect.status === null) {
      throw new Error(
        'Android reconnection did not complete. Check the existing virtual phone before starting another instance.',
      );
    }
    if (
      reconnect.status === 0 &&
      /(?:already )?connected to 127\.0\.0\.1:5581/.test(reconnect.stdout || '')
    ) {
      serial = loopbackSerial;
      existingDevice = true;
    }
  }
  if (!existingDevice) {
    if (!software) {
      const acceleration = spawnSync(emulator, ['-accel-check'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
      });
      if (acceleration.status !== 0) {
        throw new Error(
          'Android hardware acceleration is unavailable. If Windows Hypervisor Platform was just enabled, restart Windows and try again.\n' +
            acceleration.stdout +
            acceleration.stderr,
        );
      }
    }
    const avds = spawnSync(emulator, ['-list-avds'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    if (!avds.stdout?.split(/\r?\n/).includes(avdName)) {
      throw new Error(
        `Android virtual device ${avdName} is missing. Complete the Android setup first.`,
      );
    }
    console.log(`Opening ${avdName}${software ? ' with slower software emulation' : ''}...`);
    const logs = path.join(project, '.expo');
    fs.mkdirSync(logs, { recursive: true });
    const output = fs.openSync(path.join(logs, 'emulator.log'), 'a');
    const args = [
      '-avd',
      avdName,
      '-port',
      '5580',
      '-no-audio',
      '-gpu',
      softwareGraphics ? 'swiftshader' : 'host',
    ];
    // A saved VM snapshot can restore a stale debug app and its old Metro sockets.
    // Cold boot keeps installed apps and userdata; only new emulator starts use this flag.
    if (projectApp || headless) args.push('-no-snapshot');
    if (headless) args.push('-no-window');
    if (software) args.push('-accel', 'off');
    const child = spawn(emulator, args, {
      detached: true,
      windowsHide: headless,
      stdio: ['ignore', output, output],
    });
    child.unref();
    fs.closeSync(output);
  } else {
    const currentAvd = adbRun(['shell', 'getprop', 'ro.boot.qemu.avd_name']).stdout?.trim();
    if (currentAvd !== avdName)
      throw new Error(
        `Port 5580 belongs to another emulator (${currentAvd}). Close it or select another port in this launcher.`,
      );
  }

  const deadline = Date.now() + (software ? 600000 : 240000);
  let booted = false;
  let nextBootNotice = Date.now();
  while (Date.now() < deadline) {
    if (adbRun(['shell', 'getprop', 'sys.boot_completed']).stdout?.trim() === '1') {
      booted = true;
      break;
    }
    if (Date.now() >= nextBootNotice) {
      console.log('Waiting for Android to finish starting...');
      nextBootNotice = Date.now() + 10000;
    }
    await pause(1000);
  }
  if (!booted) throw new Error('Android did not finish starting. See .expo/emulator.log.');
  // Project-app mode verifies the package and Metro checkout before touching
  // forwarding. Preserve the established boot-only and Expo Go behavior.
  if (bootOnly || !projectApp) {
    const reverse = adbRun(['reverse', 'tcp:8081', 'tcp:8081']);
    if (reverse.status !== 0)
      throw new Error(
        'Could not connect Android to the local development server: ' + reverse.stderr,
      );
  }
  if (bootOnly) {
    console.log('Android is ready.');
    return;
  }
  const cli = path.join(project, 'node_modules', 'expo', 'bin', 'cli');
  if (!fs.existsSync(cli)) throw new Error('Project dependencies are missing. Run npm ci first.');
  if (projectApp) {
    const verified = adbRun(['shell', 'getprop', 'ro.boot.qemu.avd_name']);
    if (verified.status !== 0 || verified.error || verified.stdout?.trim() !== avdName)
      throw new Error(
        'The configured virtual phone could not be verified before opening the project app. Check its ADB connection.',
      );
    await launchProjectApp({
      adbRun,
      spawn,
      fetch,
      signalTimeout: (milliseconds) => AbortSignal.timeout(milliseconds),
      project,
      cli,
      node: process.execPath,
      sdk,
      serial,
      env: process.env,
      now: () => Date.now(),
      pause,
      log: (message) => console.log(message),
      stdout: process.stdout,
      stderr: process.stderr,
      onMetroError: (error) => {
        console.error(error.message);
        process.exitCode = 1;
      },
      onMetroExit: (code) => {
        if (code !== 0) process.exitCode = code || 1;
      },
    });
    return;
  }
  let existingStatus;
  try {
    existingStatus = await fetch('http://127.0.0.1:8081/status', {
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* No running local server; start one below. */
  }
  if (existingStatus) {
    const manifestResponse = await fetch('http://127.0.0.1:8081/', {
      headers: { 'Expo-Platform': 'android', Accept: 'application/expo+json' },
      signal: AbortSignal.timeout(5000),
    });
    const manifest = await manifestResponse.json();
    if (manifest.extra?.expoClient?.slug !== 'my-money-management') {
      throw new Error(
        'Port 8081 is used by another project. Stop that server or change this project port.',
      );
    }
    const opened = adbRun([
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      'exp://127.0.0.1:8081?__expo_disable_fab=1',
      'host.exp.exponent',
    ]);
    if (opened.status !== 0) throw new Error('Could not open Expo Go: ' + opened.stderr);
    console.log('Opened the app using its existing local development server.');
    return;
  }
  console.log(
    'Starting the local app. Keep this terminal open; Ctrl+C stops the development server.',
  );
  const metro = spawn(
    process.execPath,
    [cli, 'start', '--android', '--localhost', '--port', '8081', '--max-workers', '2'],
    {
      cwd: project,
      env: {
        ...process.env,
        ANDROID_HOME: sdk,
        ANDROID_SERIAL: serial,
        EXPO_NO_TELEMETRY: '1',
      },
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  metro.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  metro.on('exit', (code) => {
    process.exitCode = code || 0;
  });
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
