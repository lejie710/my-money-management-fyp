const path = require('node:path');
const { waitForDeviceMetro } = require('./android-metro-readiness.cjs');

const PROJECT_PACKAGE = 'com.lejie710.mymoneymanagement';
const PROJECT_ACTIVITY = `${PROJECT_PACKAGE}/.MainActivity`;
const METRO_ORIGIN = 'http://127.0.0.1:8081';
const METRO_START_TIMEOUT_MS = 120000;

function succeeded(result) {
  return result && result.status === 0 && !result.error;
}

function verifyInstalledPackage(result) {
  if (!succeeded(result))
    throw new Error(
      'Could not verify the installed project Android app. Check ADB and retry; no app was installed or replaced.',
    );
  if (!/^package:\/[^\r\n]+\.apk\s*$/m.test(result.stdout || ''))
    throw new Error(
      `The project Android app (${PROJECT_PACKAGE}) is not installed. Install this project's debug APK first, then retry --project-app. Expo Go was not opened.`,
    );
}

function verifyDebuggablePackage(result) {
  if (!succeeded(result))
    throw new Error(
      'Could not verify whether the installed project app is debuggable. Check ADB and retry; no package was changed.',
    );
  const output = result.stdout || '';
  const packages = [...output.matchAll(/^( *)Package \[([^\]\r\n]+)\][^\r\n]*$/gm)];
  const matching = packages.filter((match) => match[2] === PROJECT_PACKAGE);
  if (matching.length !== 1)
    throw new Error(
      'The installed project package flags could not be verified. Install this project’s debug APK before using --project-app.',
    );
  const header = matching[0];
  const next = packages.find((match) => match.index > header.index);
  const following = output.slice(header.index + header[0].length, next?.index ?? output.length);
  const lines = following.split(/\r?\n/);
  const sectionEnd = lines.findIndex(
    (line) => line.trim() && line.length - line.trimStart().length <= header[1].length,
  );
  const block = lines.slice(0, sectionEnd < 0 ? lines.length : sectionEnd).join('\n');
  // dumpsys indents direct package properties two spaces beyond its header.
  // Ignore component/user flags and privateFlags, even if they mention DEBUGGABLE.
  const flags = [...block.matchAll(/^( *)(pkgFlags|flags)=\[([A-Z0-9_\s]*)\]/gm)];
  const packageFlags = flags.filter((match) => match[1].length === header[1].length + 2);
  const tokens = packageFlags.map((match) =>
    [...new Set(match[3].trim().split(/\s+/))].sort().join(' '),
  );
  if (
    packageFlags.length === 0 ||
    packageFlags.length > 2 ||
    new Set(packageFlags.map((match) => match[2])).size !== packageFlags.length ||
    new Set(tokens).size !== 1
  )
    throw new Error(
      'The installed project package flags are missing or ambiguous. Install this project’s debug APK before using --project-app.',
    );
  if (!tokens[0].split(' ').includes('DEBUGGABLE'))
    throw new Error(
      `The installed ${PROJECT_PACKAGE} is a release/non-debuggable app and will not load this Metro server. Install this project’s debug APK first, then retry --project-app. No app was installed or replaced.`,
    );
}

function verifyManifest(manifest, project) {
  const config = manifest?.extra?.expoClient;
  const serverRoot = manifest?.extra?.expoGo?.developer?.projectRoot;
  if (
    config?.slug !== 'my-money-management' ||
    config?.android?.package !== PROJECT_PACKAGE ||
    typeof serverRoot !== 'string' ||
    !path.isAbsolute(serverRoot) ||
    path.resolve(serverRoot).toLowerCase() !== path.resolve(project).toLowerCase()
  ) {
    throw new Error(
      'Port 8081 could not be verified as this project checkout. Stop the other server yourself before retrying; no existing server was stopped.',
    );
  }
}

function connectionRefused(error) {
  if (error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED') return true;
  const causes = error?.cause?.errors;
  return (
    Array.isArray(causes) &&
    causes.length > 0 &&
    causes.every((item) => item?.code === 'ECONNREFUSED')
  );
}

function transientStartupRead(error) {
  return connectionRefused(error) || error?.name === 'TimeoutError' || error?.name === 'AbortError';
}

/** All process/network effects are injected, so tests never launch Metro or ADB. */
async function launchProjectApp({
  adbRun,
  spawn,
  fetch,
  signalTimeout,
  project,
  cli,
  node,
  sdk,
  serial,
  env,
  now,
  pause,
  log,
  stdout,
  stderr,
  onMetroError,
  onMetroExit,
}) {
  verifyInstalledPackage(adbRun(['shell', 'pm', 'path', PROJECT_PACKAGE]));
  verifyDebuggablePackage(adbRun(['shell', 'dumpsys', 'package', PROJECT_PACKAGE]));
  let metro = null;
  let childError = null;
  let childExit = null;
  let childExited = false;
  let startupDeadline = null;
  let outputPipes = [];
  const detachOutput = () => {
    for (const [source, destination] of outputPipes) source.unpipe(destination);
    outputPipes = [];
  };

  const checkOwnedStartup = () => {
    if (!metro) return;
    if (childError) throw new Error(`Metro could not start: ${childError.message}`);
    if (childExited)
      throw new Error(
        `Metro exited before the verified project app could open (code ${childExit.code}, signal ${childExit.signal || 'none'}).`,
      );
    if (now() >= startupDeadline)
      throw new Error(
        'Metro did not become ready with a verified project manifest within 120 seconds. The project app was not opened.',
      );
  };
  const readTimeout = (maximum) => {
    checkOwnedStartup();
    return metro ? Math.max(1, Math.min(maximum, startupDeadline - now())) : maximum;
  };
  const waitForOwnedStartup = async () => {
    checkOwnedStartup();
    await pause(Math.min(1000, startupDeadline - now()));
    checkOwnedStartup();
  };
  const retryManifestRead = async (error, invalidBody = false) => {
    if (!transientStartupRead(error))
      throw new Error(
        invalidBody
          ? 'Metro returned an invalid project manifest. The project app was not opened.'
          : 'The project manifest could not be read reliably. The project app was not opened.',
      );
    if (!metro)
      throw new Error(
        'The existing Metro server manifest check timed out or lost its connection. Retry after the server finishes starting; no existing server was stopped.',
      );
    await waitForOwnedStartup();
  };

  const readStatus = async (starting = false) => {
    let response;
    let status;
    const timeout = readTimeout(2000);
    try {
      response = await fetch(`${METRO_ORIGIN}/status`, {
        signal: signalTimeout(timeout),
      });
      status = response.ok ? (await response.text()).trim() : null;
    } catch (error) {
      if (connectionRefused(error)) return false;
      if (starting && transientStartupRead(error)) return false;
      throw new Error(
        'Port 8081 could not be checked reliably. Verify its existing server before starting another Metro process.',
      );
    }
    if (!response.ok || status !== 'packager-status:running')
      throw new Error(
        'Port 8081 is occupied but did not return a ready Metro status. No existing server was stopped.',
      );
    return true;
  };

  try {
    let ready = await readStatus();
    if (!ready) {
      log(
        'Starting localhost Metro for the installed project app. Keep this terminal open; Ctrl+C stops this development server.',
      );
      startupDeadline = now() + METRO_START_TIMEOUT_MS;
      metro = spawn(node, [cli, 'start', '--localhost', '--port', '8081', '--max-workers', '2'], {
        cwd: project,
        env: {
          ...env,
          ANDROID_HOME: sdk,
          ANDROID_SERIAL: serial,
          EXPO_NO_TELEMETRY: '1',
        },
        // Expo checks stdout.isTTY, not stdin. Pipes keep fixed-port startup
        // non-interactive while leaving ordinary file watching enabled unless
        // the caller explicitly supplied CI. Forward logs without closing parent streams.
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      metro.on('error', (error) => {
        childError = error;
        onMetroError(error);
      });
      metro.on('exit', (code, signal) => {
        childExited = true;
        childExit = { code, signal };
        onMetroExit(code, signal);
      });
      metro.on('close', detachOutput);
      if (!metro.stdout || !metro.stderr || !stdout || !stderr)
        throw new Error(
          'Metro output streams could not be attached. The project app was not opened.',
        );
      outputPipes = [
        [metro.stdout, stdout],
        [metro.stderr, stderr],
      ];
      for (const [source, destination] of outputPipes) source.pipe(destination, { end: false });
      while (!ready) {
        await waitForOwnedStartup();
        ready = await readStatus(true);
      }
    }

    let manifest;
    while (true) {
      checkOwnedStartup();
      let response;
      const timeout = readTimeout(5000);
      try {
        response = await fetch(`${METRO_ORIGIN}/`, {
          headers: {
            'Expo-Platform': 'android',
            Accept: 'application/expo+json',
          },
          signal: signalTimeout(timeout),
        });
      } catch (error) {
        await retryManifestRead(error);
        continue;
      }
      checkOwnedStartup();
      if (!response.ok)
        throw new Error(
          'Metro is running, but this project manifest could not be read. The project app was not opened.',
        );
      try {
        manifest = await response.json();
      } catch (error) {
        await retryManifestRead(error, true);
        continue;
      }
      checkOwnedStartup();
      verifyManifest(manifest, project);
      break;
    }
    if (childError || childExited)
      throw new Error(
        'The Metro process started by this launcher stopped before the project app could open.',
      );

    const forwarding = adbRun(['reverse', 'tcp:8081', 'tcp:8081']);
    if (
      !succeeded(forwarding) ||
      /^\s*error:/im.test(`${forwarding.stdout || ''}\n${forwarding.stderr || ''}`)
    )
      throw new Error(
        'Could not connect the verified Android app to its local development server: ' +
          (forwarding.stderr ||
            forwarding.error?.message ||
            forwarding.stdout ||
            'ADB forwarding failed.'),
      );

    await waitForDeviceMetro({
      adbRun,
      packageName: PROJECT_PACKAGE,
      now,
      pause,
      log,
      assertActive: () => {
        if (childError || childExited)
          throw new Error(
            'The Metro process started by this launcher stopped before Android could reach it.',
          );
      },
    });
    if (childError || childExited)
      throw new Error(
        'The Metro process started by this launcher stopped before the project app could open.',
      );

    const opened = adbRun([
      'shell',
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LAUNCHER',
      '-n',
      PROJECT_ACTIVITY,
    ]);
    const output = `${opened.stdout || ''}\n${opened.stderr || ''}`;
    if (
      !succeeded(opened) ||
      /(?:^|\n)\s*(?:Error\b|Exception\b|SecurityException\b)/i.test(output) ||
      /Status:\s*(?!ok\b)\S+/i.test(output)
    )
      throw new Error(`Could not open the installed project MainActivity. ${output.trim()}`);
    log('Opened the installed project Android app. Its saved data is separate from Expo Go.');
    return { startedMetro: metro !== null };
  } catch (error) {
    detachOutput();
    // Stop only a Metro child this invocation created, never an existing server or emulator.
    if (metro && !childExited) {
      try {
        metro.kill();
      } catch {
        /* Original launch failure remains the reported error. */
      }
    }
    throw error;
  }
}

module.exports = {
  PROJECT_PACKAGE,
  PROJECT_ACTIVITY,
  METRO_START_TIMEOUT_MS,
  verifyInstalledPackage,
  verifyDebuggablePackage,
  verifyManifest,
  launchProjectApp,
};
