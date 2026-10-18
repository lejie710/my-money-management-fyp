// Explicit debug-emulator pairing. Credentials travel through stdin, never command arguments.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateProviders } = require('../../src/companion/providerContract');
const {
  verifyInstalledPackage,
  verifyDebuggablePackage,
  PROJECT_PACKAGE,
} = require('../project-app-launch.cjs');
const APP_ROOT = path.resolve(__dirname, '../..');
const DEVICE_PORT = 8787;
const PRIVATE_FILE = 'files/companion-connection.json';
const ABSENT = '__FYP_COMPANION_ABSENT__';
const CREATED = '__FYP_COMPANION_TEMP_CREATED__';
function strictConnection(value, runId) {
  const match =
    typeof value?.url === 'string'
      ? /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/v1\/recognize$/.exec(value.url)
      : null;
  if (
    ![1, 2].includes(value?.version) ||
    value.runId !== runId ||
    !match ||
    Number(match[1]) > 65535 ||
    typeof value.token !== 'string' ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(value.token)
  )
    throw Error('Connection could not be verified.');
  if (value.version === 1 && value.providers !== undefined)
    throw Error('Legacy pairing cannot select cloud providers.');
  return {
    hostPort: Number(match[1]),
    deviceBytes: JSON.stringify({
      version: value.version,
      runId,
      url: `http://127.0.0.1:${DEVICE_PORT}/v1/recognize`,
      token: value.token,
      ...(value.version === 2 ? { providers: validateProviders(value.providers) } : {}),
    }),
  };
}
function reversePort(output) {
  const rows = output
    .split(/\r?\n/)
    .filter((line) => line.trim().split(/\s+/)[1] === `tcp:${DEVICE_PORT}`);
  if (!rows.length) return null;
  if (rows.length !== 1) throw Error('Device port has ambiguous ownership.');
  const match = /^\S+\s+tcp:8787\s+tcp:([1-9]\d{0,4})\s*$/.exec(rows[0]);
  if (!match || Number(match[1]) > 65535) throw Error('Device mapping could not be verified.');
  return Number(match[1]);
}
function parseArguments(args) {
  const action = args.shift();
  if (!['pair', 'clear'].includes(action)) throw Error('Choose pair or clear.');
  const values = { action };
  while (args.length) {
    const key = args.shift(),
      value = args.shift();
    if (
      !['--adb', '--python', '--serial', '--run-name', '--runtime-root'].includes(key) ||
      !value ||
      values[key]
    )
      throw Error('Invalid pairing arguments.');
    values[key] = value;
  }
  if (
    !values['--adb'] ||
    !values['--python'] ||
    !/^emulator-\d+$/.test(values['--serial'] || '') ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(values['--run-name'] || '')
  )
    throw Error('Use explicit tools, an owned emulator serial and the run name.');
  return values;
}
function pairAndroid(options, dependencies = {}) {
  const io = dependencies.fs || fs,
    run = dependencies.run || spawnSync,
    appRoot = dependencies.appRoot || APP_ROOT;
  const runtime = path.resolve(
    options['--runtime-root'] || path.join(appRoot, '.runtime', 'companion'),
  );
  if (!runtime.startsWith(path.resolve(appRoot, '.runtime') + path.sep))
    throw Error('Runtime path must stay ignored and local.');
  const runId = options['--run-name'],
    directory = path.join(runtime, 'runs', runId),
    pairingFile = path.join(directory, 'pairing.json'),
    pairingConnection = path.join(directory, 'pairing-connection.json');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) throw Error('Invalid run name.');
  const temporaryFile = `files/companion-connection.${runId}.pending.json`;
  const invoke = (binary, args, input) =>
    run(binary, args, {
      input,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
  const execute = (binary, args, input) => {
    const result = invoke(binary, args, input);
    if (result.status !== 0 || result.error)
      throw Error('The exact owned command did not finish successfully.');
    return result;
  };
  const verifyArgs = [
    path.join(__dirname, 'control.py'),
    'verify',
    '--run-name',
    runId,
    '--runtime-root',
    runtime,
  ];
  let verified = invoke(options['--python'], verifyArgs);
  let stopped = false;
  if (verified.status !== 0 || verified.error) {
    if (options.action !== 'clear') throw Error('Live run ownership is unavailable.');
    verifyArgs[1] = 'verify-stopped';
    verified = execute(options['--python'], verifyArgs);
    stopped = true;
  }
  const ownership = JSON.parse(verified.stdout);
  if (
    ownership.valid !== true ||
    ownership.runId !== runId ||
    (stopped && ownership.stopped !== true)
  )
    throw Error('Live PID/start-time ownership is unavailable.');
  const raw = io.readFileSync(
    stopped ? pairingConnection : path.join(directory, 'connection.json'),
    'utf8',
  );
  if (Buffer.byteLength(raw) > 4096) throw Error('Connection metadata is oversized.');
  const config = JSON.parse(raw);
  if (config.pid !== ownership.companionPid)
    throw Error('The live companion does not match its connection.');
  const { hostPort, deviceBytes } = strictConnection(config, runId);
  const adb = (args, input) =>
    execute(options['--adb'], ['-s', options['--serial'], ...args], input);
  if (
    adb(['get-state']).stdout.trim() !== 'device' ||
    adb(['shell', 'getprop', 'ro.kernel.qemu']).stdout.trim() !== '1'
  )
    throw Error('The selected target is not the explicit running emulator.');
  verifyInstalledPackage(adb(['shell', 'pm', 'path', PROJECT_PACKAGE]));
  verifyDebuggablePackage(adb(['shell', 'dumpsys', 'package', PROJECT_PACKAGE]));
  const mapping = () => reversePort(adb(['reverse', '--list']).stdout);
  const readPrivate = (file = PRIVATE_FILE) =>
    adb([
      'shell',
      '-T',
      'run-as',
      PROJECT_PACKAGE,
      'sh',
      '-c',
      `'if [ -f ${file} ]; then cat ${file}; else printf ${ABSENT}; fi'`,
    ]).stdout;
  const existing = io.existsSync(pairingFile)
    ? JSON.parse(io.readFileSync(pairingFile, 'utf8'))
    : null;
  const expected = {
    version: 1,
    runId,
    serial: options['--serial'],
    devicePort: DEVICE_PORT,
    hostPort,
    companionPid: config.pid,
    temporaryFile,
  };
  if (
    existing &&
    (typeof existing !== 'object' ||
      Array.isArray(existing) ||
      Object.keys(existing).sort().join(',') !==
        [...Object.keys(expected), 'phase', 'mappingOwned', 'temporaryOwned'].sort().join(',') ||
      !['preparing', 'paired'].includes(existing.phase) ||
      typeof existing.mappingOwned !== 'boolean' ||
      typeof existing.temporaryOwned !== 'boolean' ||
      (existing.phase === 'paired' && (!existing.mappingOwned || !existing.temporaryOwned)))
  )
    throw Error('Saved pairing ownership is malformed and was retained.');
  if (existing && Object.entries(expected).some(([key, value]) => existing[key] !== value))
    throw Error('Existing pairing belongs to another run or target.');
  if (options.action === 'pair') {
    const before = mapping();
    if (existing) {
      if (
        existing.phase !== 'paired' ||
        !existing.mappingOwned ||
        before !== hostPort ||
        readPrivate() !== deviceBytes
      )
        throw Error('Existing pairing needs explicit recovery before reuse.');
      return { status: 'already-paired' };
    }
    if (before !== null)
      throw Error('Device port8787 is already in use; its mapping was not replaced.');
    if (readPrivate() !== ABSENT)
      throw Error('The app already has a private connection; it was not replaced.');
    if (readPrivate(temporaryFile) !== ABSENT)
      throw Error('The run temporary file already exists; it was not replaced.');
    // Preserve the exact live connection privately before any device mutation so
    // a confirmed owned shutdown can still clear its matching stale pairing.
    if (io.existsSync(pairingConnection)) {
      if (io.readFileSync(pairingConnection, 'utf8') !== raw)
        throw Error('Pairing connection proof differs and was retained.');
    } else io.writeFileSync(pairingConnection, raw, { flag: 'wx', mode: 0o600 });
    if (io.readFileSync(pairingConnection, 'utf8') !== raw)
      throw Error('Pairing connection proof was not confirmed.');
    const record = { ...expected, phase: 'preparing', mappingOwned: false, temporaryOwned: false };
    io.writeFileSync(pairingFile, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    adb(['reverse', '--no-rebind', `tcp:${DEVICE_PORT}`, `tcp:${hostPort}`]);
    if (mapping() !== hostPort) throw Error('The new mapping could not be confirmed.');
    record.mappingOwned = true;
    io.writeFileSync(pairingFile, JSON.stringify(record));
    // fd3 uses exclusive creation. The fixed stdout marker proves ownership even
    // if a later stdin copy fails; no token is written to command arguments/stdout.
    const written = invoke(
      options['--adb'],
      [
        '-s',
        options['--serial'],
        'shell',
        '-T',
        'run-as',
        PROJECT_PACKAGE,
        'sh',
        '-c',
        `'umask 077; set -C; exec 3> ${temporaryFile} || exit 78; printf ${CREATED}; cat >&3'`,
      ],
      deviceBytes,
    );
    if (written.stdout === CREATED) {
      record.temporaryOwned = true;
      io.writeFileSync(pairingFile, JSON.stringify(record));
    }
    if (
      written.status !== 0 ||
      written.error ||
      !record.temporaryOwned ||
      readPrivate(temporaryFile) !== deviceBytes
    )
      throw Error('Private temporary delivery could not be confirmed.');
    adb(['shell', '-T', 'run-as', PROJECT_PACKAGE, 'mv', '-n', temporaryFile, PRIVATE_FILE]);
    if (readPrivate() !== deviceBytes)
      throw Error('Private connection delivery could not be confirmed.');
    record.phase = 'paired';
    io.writeFileSync(pairingFile, JSON.stringify(record));
    return { status: 'paired' };
  }
  if (!existing || !existing.mappingOwned)
    throw Error('There is no confirmed mapping owned by this run.');
  const before = mapping();
  if (before !== null && before !== hostPort)
    throw Error('Device mapping now belongs to another target.');
  const privateBytes = readPrivate();
  if (privateBytes !== ABSENT && privateBytes !== deviceBytes)
    throw Error('The private connection now belongs to another run.');
  const temporaryBytes = readPrivate(temporaryFile);
  if (temporaryBytes !== ABSENT && !existing.temporaryOwned)
    throw Error('Temporary file creation was not confirmed; it was retained.');
  if (privateBytes !== ABSENT) {
    adb(['shell', '-T', 'run-as', PROJECT_PACKAGE, 'rm', PRIVATE_FILE]);
    if (readPrivate() !== ABSENT) throw Error('Private connection removal is unconfirmed.');
  }
  if (temporaryBytes !== ABSENT) {
    adb(['shell', '-T', 'run-as', PROJECT_PACKAGE, 'rm', temporaryFile]);
    if (readPrivate(temporaryFile) !== ABSENT)
      throw Error('Owned temporary removal is unconfirmed.');
  }
  if (before !== null) {
    adb(['reverse', '--remove', `tcp:${DEVICE_PORT}`]);
    if (mapping() !== null) throw Error('Mapping removal is unconfirmed.');
  }
  io.unlinkSync(pairingFile);
  if (io.existsSync(pairingConnection)) io.unlinkSync(pairingConnection);
  return { status: 'cleared' };
}
if (require.main === module) {
  try {
    const result = pairAndroid(parseArguments(process.argv.slice(2)));
    console.info(`Owned Android companion pairing ${result.status}. Credentials were not printed.`);
  } catch {
    console.error(
      'Pairing is incomplete or ownership could not be confirmed. Existing recovery metadata was retained; no credentials were printed.',
    );
    process.exitCode = 1;
  }
}
module.exports = {
  PRIVATE_FILE,
  DEVICE_PORT,
  strictConnection,
  reversePort,
  parseArguments,
  pairAndroid,
};
