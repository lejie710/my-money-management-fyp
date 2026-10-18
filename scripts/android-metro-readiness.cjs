// Read-only Android dev-server verification. RN's emulator default is 10.0.2.2,
// which is distinct from the device loopback route established by adb reverse.
const DEVICE_METRO_TIMEOUT_MS = 60000;
const STATUS_BODY = 'packager-status:running';
const ALLOWED_AUTHORITIES = new Set(['10.0.2.2:8081', '127.0.0.1:8081', 'localhost:8081']);

function success(result) {
  return result && result.status === 0 && !result.error && !result.stderr;
}

function savedDebugHost(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 65536)
    throw new Error('Android debug-server preferences could not be read within their size bound.');
  if (!/^\s*(?:<\?xml[^?]*\?>\s*)?<map(?:\s*\/>|\s*>[\s\S]*<\/map>)\s*$/.test(xml))
    throw new Error('Android debug-server preferences have an unrecognized format.');
  // Android's own SharedPreferences serializer emits this fixed string shape.
  // Refuse another type, duplicate or escaped/ambiguous setting rather than
  // pretending that an unrecognized setting means the default host.
  const keys = [...xml.matchAll(/\bname\s*=\s*(["'])debug_http_host\1/g)];
  if (keys.length === 0) return '';
  const values = [...xml.matchAll(/<string\s+name=(["'])debug_http_host\1\s*>([^<]*)<\/string>/g)];
  if (keys.length !== 1 || values.length !== 1)
    throw new Error(
      'Android has an ambiguous debug-server setting; inspect it without resetting app data.',
    );
  return values[0][2];
}

function checkedProperty(adbRun, name) {
  const result = adbRun(['shell', 'getprop', name], {
    timeout: 5000,
    maxBuffer: 4096,
  });
  if (!success(result) || typeof result.stdout !== 'string' || result.stdout.length > 4096)
    throw new Error(
      'The Android debug-server host could not be verified. Check the existing device connection.',
    );
  const value = result.stdout.replace(/[\r\n]+$/, '');
  if (/[\r\n]/.test(value))
    throw new Error('The Android debug-server property has an ambiguous response.');
  return value;
}

function readDeviceMetroHost(adbRun, packageName) {
  if (!/^[a-z][a-z0-9_.]+$/.test(packageName)) throw new Error('Invalid project package identity.');
  const preferencePath = `shared_prefs/${packageName}_preferences.xml`;
  const result = adbRun(['shell', 'run-as', packageName, 'cat', preferencePath], {
    timeout: 5000,
    maxBuffer: 65536,
  });
  let override = '';
  if (success(result)) {
    override = savedDebugHost(result.stdout);
  } else {
    // A never-configured debug app has no default preferences file. A permission,
    // package, transport or parse error is not evidence of an absent setting.
    const missing = `cat: ${preferencePath}: No such file or directory`;
    if (
      result?.error ||
      result?.status !== 1 ||
      (result.stdout || '').trim() ||
      (result.stderr || '').trim() !== missing
    )
      throw new Error(
        'Could not verify Android debug-server preferences. No setting or app data was changed.',
      );
  }
  let authority = override;
  if (!authority) {
    const property = checkedProperty(adbRun, 'metro.host');
    if (property) authority = `${property}:8081`;
    else {
      const fingerprint = checkedProperty(adbRun, 'ro.build.fingerprint');
      if (!fingerprint)
        throw new Error('Android emulator identity is unavailable for debug-server selection.');
      const hostname = fingerprint.includes('vbox')
        ? '10.0.3.2'
        : fingerprint.includes('generic') || fingerprint.startsWith('google/sdk_gphone')
          ? '10.0.2.2'
          : 'localhost';
      authority = `${hostname}:8081`;
    }
  }
  if (!ALLOWED_AUTHORITIES.has(authority))
    throw new Error(
      'Android has a different debug-server host or port. Review its Dev Settings before using this localhost project launcher; no override was changed.',
    );
  return { authority, hostname: authority.slice(0, -5) };
}

function statusResponse(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16384)
    throw new Error('Android received an oversized or unreadable Metro response.');
  const separator = raw.indexOf('\r\n\r\n');
  if (separator < 0)
    throw new Error('Android did not receive a complete HTTP status response from Metro.');
  const lines = raw.slice(0, separator).split('\r\n');
  if (!/^HTTP\/1\.[01] 200(?: [^\r\n]*)?$/.test(lines.shift() || ''))
    throw new Error('Android reached a service that did not return a successful Metro status.');
  const headers = new Map();
  for (const line of lines) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line);
    if (!match) throw new Error('Android received malformed HTTP status headers.');
    const key = match[1].toLowerCase();
    if (headers.has(key) && ['content-length', 'transfer-encoding'].includes(key))
      throw new Error('Android received ambiguous HTTP status framing.');
    headers.set(key, match[2].trim());
  }
  let body = raw.slice(separator + 4);
  const transfer = headers.get('transfer-encoding');
  const length = headers.get('content-length');
  if (transfer) {
    if (transfer.toLowerCase() !== 'chunked' || length !== undefined)
      throw new Error('Android received unsupported HTTP status framing.');
    let remaining = body,
      decoded = '',
      completed = false;
    for (let count = 0; count < 32; count++) {
      const end = remaining.indexOf('\r\n');
      if (end < 0 || !/^[0-9a-fA-F]{1,4}$/.test(remaining.slice(0, end))) break;
      const size = parseInt(remaining.slice(0, end), 16);
      remaining = remaining.slice(end + 2);
      if (size === 0) {
        completed = remaining === '\r\n';
        break;
      }
      if (remaining.length < size + 2 || remaining.slice(size, size + 2) !== '\r\n') break;
      decoded += remaining.slice(0, size);
      remaining = remaining.slice(size + 2);
    }
    if (!completed) throw new Error('Android received an incomplete HTTP status body.');
    body = decoded;
  } else if (
    length !== undefined &&
    (!/^(0|[1-9]\d{0,5})$/.test(length) || Number(length) !== Buffer.byteLength(body))
  ) {
    throw new Error('Android received an incomplete HTTP status body.');
  }
  if (body !== STATUS_BODY)
    throw new Error('Android reached a service that is not the ready Metro server.');
  return true;
}

function transientDeviceConnection(result) {
  if (result?.error?.code === 'ETIMEDOUT') return true;
  if (result?.status === 0 && !result.error && !result.stdout && !result.stderr) return true;
  // exec-out preserves HTTP bytes on Windows but can merge a remote command's
  // stderr and does not reliably expose its exit status. Accept only this narrow
  // connection-error shape, never arbitrary ADB or HTTP error output.
  const message = !result?.stdout ? result?.stderr : !result?.stderr ? result?.stdout : '';
  return (
    [0, 1].includes(result?.status) &&
    !result.error &&
    /^nc: (?:connect|read|write|poll)(?:[^\r\n]*): (?:Connection refused|Connection timed out|Network is unreachable|No route to host|Connection reset by peer)\s*$/.test(
      message || '',
    )
  );
}

function deviceProbeCommand(authority) {
  if (!ALLOWED_AUTHORITIES.has(authority)) throw new Error('Unsupported local Metro probe target.');
  const hostname = authority.slice(0, -5);
  // Every substituted character comes from the three literal allowed authorities.
  // Build CRLF on Android: Windows adb shell/stdin altered framing in the actual
  // device probe. exec-out returns the raw response and creates no device file.
  return `printf '%s\\r\\n' 'GET /status HTTP/1.0' 'Host: ${authority}' 'Connection: close' '' | toybox nc -w 2 -W 2 ${hostname} 8081`;
}

async function waitForDeviceMetro({
  adbRun,
  packageName,
  now,
  pause,
  log,
  assertActive = () => {},
}) {
  const deadline = now() + DEVICE_METRO_TIMEOUT_MS;
  const timeoutError = () =>
    new Error(
      'Android could not reach the verified Metro server within 60 seconds. Retry after the virtual phone finishes starting; no app data or debug-host setting was changed.',
    );
  const boundedAdbRun = (args, settings) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw timeoutError();
    return adbRun(args, {
      ...settings,
      timeout: Math.max(1, Math.min(settings.timeout, remaining)),
    });
  };
  const host = readDeviceMetroHost(boundedAdbRun, packageName);
  let announced = false;
  while (now() < deadline) {
    assertActive();
    const result = adbRun(['exec-out', deviceProbeCommand(host.authority)], {
      timeout: Math.max(1, Math.min(3000, deadline - now())),
      maxBuffer: 16384,
    });
    assertActive();
    const transient = transientDeviceConnection(result);
    if (!transient && success(result) && result.stdout) {
      statusResponse(result.stdout);
      if (readDeviceMetroHost(boundedAdbRun, packageName).authority !== host.authority)
        throw new Error(
          'Android debug-server settings changed during readiness verification; retry without resetting data.',
        );
      assertActive();
      if (now() >= deadline) break;
      return host.authority;
    }
    if (!transient)
      throw new Error(
        'The Android-to-Metro check could not run reliably. Check the device connection and toybox nc support; the app was not opened.',
      );
    if (!announced) {
      log('Waiting for the Android device to reach the verified local Metro server...');
      announced = true;
    }
    const remaining = deadline - now();
    if (remaining > 0) await pause(Math.min(500, remaining));
  }
  throw timeoutError();
}

module.exports = {
  DEVICE_METRO_TIMEOUT_MS,
  savedDebugHost,
  readDeviceMetroHost,
  statusResponse,
  transientDeviceConnection,
  deviceProbeCommand,
  waitForDeviceMetro,
};
