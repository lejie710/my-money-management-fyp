// Starts one private loopback Flask child only when the caller explicitly enables Prophet.
const path = require('node:path'),
  fs = require('node:fs/promises'),
  { spawn } = require('node:child_process'),
  { randomBytes } = require('node:crypto');
const { createProphetAdapter } = require('../../scripts/companion/forecast/prophetAdapter.cjs');
function environment(python, directory, source = process.env) {
  const system = Object.entries(source).find(([k]) => k.toUpperCase() === 'SYSTEMROOT')?.[1];
  if (process.platform === 'win32' && !system)
    throw Error('Windows process environment is unavailable.');
  return {
    ...(system ? { SystemRoot: system, WINDIR: system } : {}),
    PATH:
      path.dirname(python) +
      path.delimiter +
      (system ? path.join(system, 'System32') : '/usr/bin:/bin'),
    HOME: directory,
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
    MPLCONFIGDIR: path.join(directory, 'mpl'),
    XDG_CACHE_HOME: path.join(directory, 'cache'),
    OMP_NUM_THREADS: '1',
    OPENBLAS_NUM_THREADS: '1',
    LANG: 'C.UTF-8',
  };
}
async function startPortableForecast({
  python,
  runtimeDirectory,
  onUnexpectedExit = () => {},
  spawnProcess = spawn,
  fetch: fetcher = globalThis.fetch,
} = {}) {
  const executable = await fs.realpath(python),
    directory = path.resolve(runtimeDirectory);
  if (!(await fs.stat(executable)).isFile()) throw Error('Choose an installed Python environment.');
  await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  for (const name of ['mpl', 'cache']) await fs.mkdir(path.join(directory, name), { mode: 0o700 });
  const key = randomBytes(32).toString('base64url');
  const child = spawnProcess(
    executable,
    ['-I', '-B', path.join(__dirname, 'forecast_service_main.py')],
    {
      cwd: directory,
      env: environment(executable, directory),
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      shell: false,
    },
  );
  let ending = false,
    stopped = false,
    closed = null,
    buffer = '',
    total = 0,
    failed = false,
    resolveReady,
    rejectReady,
    resolveExit;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  child.once('error', () => {
    failed = true;
    rejectReady(Error('Private model startup failed.'));
    resolveExit(-1);
  });
  child.once('exit', (code) => {
    resolveExit(code);
    if (!ending) {
      failed = true;
      rejectReady(Error('Private model stopped unexpectedly.'));
      onUnexpectedExit();
    }
  });
  child.stdout.on('data', (chunk) => {
    try {
      total += chunk.length;
      if (total > 32768) throw Error();
      buffer += chunk.toString('utf8');
      if (buffer.length > 8192 && !buffer.includes('\n')) throw Error();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.length > 8192) throw Error();
        const row = JSON.parse(line);
        if (
          row.stage === 'forecast-ready' &&
          Number.isSafeInteger(row.pid) &&
          row.pid > 0 &&
          Number.isSafeInteger(row.port) &&
          row.port > 0 &&
          row.port <= 65535
        )
          resolveReady(row);
        else if (row.stage === 'forecast-stopped' && row.stopped === true) stopped = true;
        else throw Error();
      }
    } catch {
      failed = true;
      rejectReady(Error('Private model status was invalid.'));
      child.stdin.destroy();
    }
  });
  let startupTimer;
  const close = () =>
    closed ||
    (closed = (async () => {
      ending = true;
      try {
        child.stdin.end('stop\n');
      } catch {
        failed = true;
      }
      let stopTimer;
      try {
        const code = await Promise.race([
          exited,
          new Promise((_, reject) => {
            stopTimer = setTimeout(() => reject(Error()), 40000);
          }),
        ]);
        if (code !== 0 || !stopped || failed || buffer.trim()) throw Error();
        return true;
      } catch {
        try {
          child.kill();
        } catch {}
        throw Error('Private model shutdown was not confirmed.');
      } finally {
        clearTimeout(stopTimer);
      }
    })());
  try {
    child.stdin.write(JSON.stringify({ version: 1, key, runtimeRoot: directory }) + '\n');
    const status = await Promise.race([
      ready,
      new Promise((_, reject) => {
        startupTimer = setTimeout(() => reject(Error('Private model startup deadline.')), 30000);
      }),
    ]);
    const baseUrl = 'http://127.0.0.1:' + status.port;
    const health = await fetcher(baseUrl + '/health', {
      headers: { Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!health.ok || health.redirected || health.url !== baseUrl + '/health') throw Error();
    const raw = await health.text();
    if (raw.length > 4096) throw Error();
    const data = JSON.parse(raw);
    if (
      data.version !== 1 ||
      data.status !== 'ready' ||
      data.engine !== 'prophet' ||
      data.contractVersion !== 'recorded-expense-prophet-v1'
    )
      throw Error();
    const inspect = async () => {
      const response = await fetcher(baseUrl + '/owned-status', {
        headers: { Authorization: 'Bearer ' + key },
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!response.ok || response.redirected || response.url !== baseUrl + '/owned-status')
        throw Error('Private model status unavailable.');
      const raw = await response.text();
      if (raw.length > 4096) throw Error('Private model status oversized.');
      const value = JSON.parse(raw);
      if (
        value.version !== 1 ||
        typeof value.idle !== 'boolean' ||
        typeof value.blocked !== 'boolean'
      )
        throw Error('Private model status invalid.');
      return value;
    };
    return {
      createAdapter: () => createProphetAdapter({ baseUrl, key }),
      close,
      child,
      inspect,
      port: status.port,
      servicePid: status.pid,
    };
  } catch {
    try {
      await close();
    } catch {}
    throw Error('Private Prophet service could not start.');
  } finally {
    clearTimeout(startupTimer);
  }
}
module.exports = { startPortableForecast, environment };
