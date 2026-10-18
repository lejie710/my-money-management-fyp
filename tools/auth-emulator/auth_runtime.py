"""Local Auth paths, export integrity and ownership checks; no process work on import."""
import hashlib
import json
import os
import re
import subprocess
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP_ROOT = HERE.parents[1]
CLI_VERSION = '15.34.0'
PROJECT = 'demo-fyp-local'
PORTS = {'auth': 9099, 'hub': 4409, 'logging': 4500}
MAX_JSON_BYTES = 16 * 1024 * 1024
PORT_QUERY = """$ErrorActionPreference = 'Stop'
$wantedPorts = @(9099, 4409, 4500)
$rows = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $wantedPorts -contains $_.LocalPort } | ForEach-Object {
    [ordered]@{ address = $_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess }
})
ConvertTo-Json -InputObject $rows -Depth 3 -Compress
"""


def inside(path, root):
    value, parent = Path(path).resolve(), Path(root).resolve()
    if value == parent or not value.is_relative_to(parent):
        raise RuntimeError('The path must remain inside this app-owned runtime directory.')
    return value


def runtime_root(value=None):
    return inside(value or APP_ROOT / '.runtime' / 'auth-emulator', APP_ROOT / '.runtime')


def run_name(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', value):
        raise RuntimeError('Choose a new lowercase run name of at most64 characters.')
    return value


def read_json(path, maximum=MAX_JSON_BYTES):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or not 1 <= path.stat().st_size <= maximum:
        raise RuntimeError('Local metadata is missing, linked or outside its byte limit.')
    raw = path.read_bytes()
    if len(raw) > maximum:
        raise RuntimeError('Local metadata changed while being read.')
    try:
        return json.loads(raw)
    except Exception:
        raise RuntimeError('Local metadata could not be parsed.') from None


def atomic_json(path, value):
    path = Path(path)
    raw = (json.dumps(value, sort_keys=True, indent=2) + '\n').encode('utf-8')
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    path.parent.mkdir(parents=True, exist_ok=True)
    created = False
    try:
        with temporary.open('xb') as output:
            created = True
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if created and temporary.exists():
            temporary.unlink()
    if path.read_bytes() != raw:
        raise RuntimeError('The saved metadata could not be confirmed.')


def publish_json_exclusive(path, value):
    """Publish complete request bytes without ever replacing another request."""
    path = Path(path)
    raw = (json.dumps(value, sort_keys=True) + '\n').encode('utf-8')
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.pending')
    created = False
    try:
        with temporary.open('xb') as output:
            created = True
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        # Same-directory hard-link creation is atomic and refuses an existing
        # destination on Windows and POSIX. The owner scans only *.json.
        os.link(temporary, path)
    finally:
        if created and temporary.exists():
            temporary.unlink()
    if path.read_bytes() != raw:
        raise RuntimeError('The published request could not be confirmed.')


def account_users(value):
    users = value.get('users') if isinstance(value, dict) else None
    if not isinstance(users, list) or len(users) > 10000:
        raise RuntimeError('The Auth account list cannot be confirmed.')
    ids = []
    for user in users:
        if not isinstance(user, dict) or not isinstance(user.get('localId'), str) or not user['localId']:
            raise RuntimeError('Exported account identities are invalid.')
        if any(key in user and not isinstance(user[key], str) for key in ('email', 'displayName')):
            raise RuntimeError('Exported account profile fields are invalid.')
        if 'emailVerified' in user and not isinstance(user['emailVerified'], bool):
            raise RuntimeError('Exported account profile fields are invalid.')
        ids.append(user['localId'])
    if len(set(ids)) != len(ids):
        raise RuntimeError('Exported account identities are invalid.')
    return users


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('Local Auth redirects are not allowed.')


def local_json(port, route, body=None):
    if port not in PORTS.values() or not route.startswith('/') or route.startswith('//'):
        raise RuntimeError('Use an explicit local Auth endpoint.')
    url = f'http://127.0.0.1:{port}{route}'
    request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode('utf-8'),
                                     headers={'Content-Type': 'application/json', 'Authorization': 'Bearer owner'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=60 if body is not None else 5) as response:
        if response.status != 200 or response.geturl() != url:
            raise RuntimeError('The local Auth response could not be confirmed.')
        raw = response.read(MAX_JSON_BYTES + 1)
        if len(raw) > MAX_JSON_BYTES:
            raise RuntimeError('The local Auth response exceeds its bounded size.')
        return json.loads(raw)


def scan_ports():
    shell = Path(os.environ.get('SystemRoot', 'C:/Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    # Fixed read-only command text works under the host's script-file policy;
    # no execution policy, environment setting or network state is changed.
    result = subprocess.run([str(shell), '-NoProfile', '-NonInteractive', '-Command', PORT_QUERY],
                            capture_output=True, text=True, encoding='utf-8', timeout=15,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode or result.stderr:
        raise RuntimeError('Listening port ownership could not be read.')
    rows = json.loads(result.stdout)
    if not isinstance(rows, list):
        raise RuntimeError('The port ownership snapshot is invalid.')
    return rows


def verify_ports(rows, pid=None, require_all=False):
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {'address', 'port', 'pid'} or row['port'] not in PORTS.values():
            raise RuntimeError('Unexpected port metadata; no listener was adopted.')
        if pid is None:
            raise RuntimeError('An Auth, hub or logging port is already occupied. Existing services were left running.')
        if row['address'] not in ('127.0.0.1', '::1') or row['pid'] != pid:
            raise RuntimeError('A listener is not this exact owned loopback process.')
        seen.add(row['port'])
    if require_all and seen != set(PORTS.values()):
        raise RuntimeError('The owned Auth service has not bound all three expected ports.')


def verify_ready(pid, request=local_json):
    hub = request(PORTS['hub'], '/')
    if hub.get('pid') != pid or hub.get('version') != CLI_VERSION:
        raise RuntimeError('The live hub identity or CLI version does not match this run.')
    emulators = request(PORTS['hub'], '/emulators')
    if set(emulators) != set(PORTS):
        raise RuntimeError('Unexpected emulators are running; only Auth, hub and logging are allowed.')
    for name, port in PORTS.items():
        if emulators[name].get('host') not in ('127.0.0.1', '::1') or emulators[name].get('port') != port:
            raise RuntimeError('An emulator endpoint does not match its explicit loopback configuration.')
    configuration = request(PORTS['auth'], f'/emulator/v1/projects/{PROJECT}/config')
    if not isinstance(configuration, dict):
        raise RuntimeError('The demo Auth project is unavailable.')


def export_summary(directory):
    directory = Path(directory).resolve()
    metadata = read_json(inside(directory / 'firebase-export-metadata.json', directory), 65536)
    if set(metadata) != {'version', 'auth'} or metadata['version'] != CLI_VERSION or metadata['auth'] != {'version': CLI_VERSION, 'path': 'auth_export'}:
        raise RuntimeError('The export is not the pinned Auth-only snapshot format.')
    accounts = read_json(inside(directory / 'auth_export/accounts.json', directory))
    config = read_json(inside(directory / 'auth_export/config.json', directory), 1024 * 1024)
    users = account_users(accounts)
    if not isinstance(config, dict):
        raise RuntimeError('The Auth export cannot be confirmed.')
    paths = ['firebase-export-metadata.json', 'auth_export/accounts.json', 'auth_export/config.json']
    actual = sorted(path.relative_to(directory).as_posix() for path in directory.rglob('*') if path.is_file())
    if actual != sorted(paths) and actual != sorted(paths + ['export-integrity.json']):
        raise RuntimeError('Unexpected files are present in this Auth-only snapshot.')
    hashes = {}
    for relative in paths:
        file = inside(directory / relative, directory)
        if file.is_symlink():
            raise RuntimeError('A snapshot file cannot be a link.')
        hashes[relative] = hashlib.sha256(file.read_bytes()).hexdigest()
    return {'version': 1, 'projectId': PROJECT, 'cliVersion': CLI_VERSION, 'userCount': len(users), 'files': hashes}


def verify_export(directory):
    actual = export_summary(directory)
    if read_json(Path(directory) / 'export-integrity.json', 65536) != actual:
        raise RuntimeError('The saved Auth export differs from its confirmed integrity record.')
    return actual


def import_directory(root):
    pointer = Path(root) / 'last-export.json'
    if not pointer.exists():
        return None
    value = read_json(pointer, 65536)
    if set(value) != {'version', 'exportId'} or value['version'] != 1:
        raise RuntimeError('The last export pointer is invalid; no empty replacement was created.')
    identifier = run_name(value['exportId'])
    directory = inside(Path(root) / 'exports' / identifier, root)
    verify_export(directory)
    return directory


def verify_imported(directory, request=local_json):
    if directory is None:
        return
    expected = account_users(read_json(Path(directory) / 'auth_export/accounts.json'))
    actual = account_users(request(PORTS['auth'], f'/identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:batchGet?maxResults=-1'))
    def identity(rows):
        return sorted((row['localId'], row.get('email'), row.get('displayName'), bool(row.get('emailVerified'))) for row in rows)
    if identity(actual) != identity(expected):
        raise RuntimeError('Imported account IDs/profile fields do not match the confirmed snapshot.')


def export_owned(root, identifier, pid, ports=scan_ports, request=local_json):
    root = Path(root).resolve()
    verify_ports(ports(), pid, require_all=True)
    verify_ready(pid, request)
    identifier = run_name(identifier)
    destination = inside(root / 'exports' / identifier, root)
    destination.mkdir(parents=True, exist_ok=False)
    request(PORTS['hub'], '/_admin/export', {'path': str(destination), 'initiatedBy': 'owned-local-auth-helper', 'targets': ['auth']})
    summary = export_summary(destination)
    atomic_json(destination / 'export-integrity.json', summary)
    verify_export(destination)
    atomic_json(root / 'last-export.json', {'version': 1, 'exportId': identifier})
    return identifier
