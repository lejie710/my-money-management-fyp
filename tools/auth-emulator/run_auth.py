"""Explicit local Auth owner. Never imports a service or starts a child merely on import."""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from auth_runtime import (HERE, CLI_VERSION, PROJECT, PORTS, runtime_root, run_name, inside, read_json,
                          atomic_json, scan_ports, verify_ports, verify_ready, import_directory,
                          verify_imported, export_owned)
from owned_process import OwnedJob, process_identity


class AuthSession:
    def __init__(self, root, directory, child, job, ports=scan_ports, exporter=export_owned):
        self.root, self.directory, self.child, self.job = root, directory, child, job
        self.ports, self.exporter = ports, exporter
        self.stopped = False

    def action(self, action, request_id):
        if action not in ('export', 'stop') or not isinstance(request_id, str) or not re_request(request_id):
            raise RuntimeError('Use an explicit export or stop action.')
        if self.stopped or self.child.poll() is not None:
            raise RuntimeError('The exact owned Auth process is no longer running.')
        # A failed export returns before any stop effect, preserving the running service.
        export_id = self.exporter(self.root, 'snapshot-' + request_id, self.child.pid)
        if action == 'export':
            return {'ok': True, 'action': action, 'exportId': export_id, 'stopped': False}
        graceful = False
        try:
            self.child.stdin.write(b'stop\n'); self.child.stdin.flush(); self.child.stdin.close()
            self.child.wait(timeout=30)
            graceful = self.child.returncode == 0
        except Exception:
            graceful = False
        # The last snapshot is confirmed. Final termination, if needed, is limited
        # to the already-owned Job, never a PID obtained from metadata or process name.
        confirmed = self.job.stop()
        self.stopped = confirmed
        try:
            ports_clear = not self.ports()
        except Exception:
            ports_clear = False
        return {'ok': graceful and confirmed and ports_clear, 'action': action, 'exportId': export_id,
                'stopped': confirmed, 'portsClear': ports_clear, 'graceful': graceful}


def re_request(value):
    return len(value) == 32 and all(character in '0123456789abcdef' for character in value)


def prepare(args):
    root = runtime_root(args.runtime_root)
    name = run_name(args.run_name)
    directory = inside(root / 'runs' / name, root)
    node = Path(args.node or shutil.which('node') or '').resolve()
    if not node.is_file() or node.name.lower() != 'node.exe':
        raise RuntimeError('Choose an installed Windows Node24 executable.')
    metadata = read_json(HERE / 'node_modules/firebase-tools/package.json', 1024 * 1024)
    if metadata.get('version') != CLI_VERSION:
        raise RuntimeError('Install the exact pinned Firebase CLI tool package first.')
    verify_ports(scan_ports())
    previous = import_directory(root)
    root.mkdir(parents=True, exist_ok=True)
    directory.mkdir(parents=True, exist_ok=False)
    (directory / 'requests').mkdir()
    (directory / 'responses').mkdir()
    return root, directory, node, previous


def launch(args):
    if os.name != 'nt':
        raise RuntimeError('The owned Auth launcher currently supports Windows only.')
    root, directory, node, previous = prepare(args)
    version = subprocess.run([str(node), '--version'], capture_output=True, text=True, timeout=10,
                             creationflags=subprocess.CREATE_NO_WINDOW)
    if version.returncode or not version.stdout.startswith('v24.'):
        raise RuntimeError('Node24 is required for this pinned toolchain.')
    launcher = process_identity(os.getpid())
    lock_file = root / 'owner-lock.json'
    lock = {'version': 1, 'runId': args.run_name, 'launcher': launcher}
    with lock_file.open('x', encoding='utf-8') as output:
        json.dump(lock, output)
    job = None; child = None; session = None; ready = False; result = None
    def stage(name):
        record = {'stage': name, 'runId': args.run_name}
        atomic_json(directory / 'status.json', record)
        print(json.dumps(record), flush=True)
    try:
        job = OwnedJob()
        child = subprocess.Popen([str(node), str(HERE / 'cli_child.cjs')], cwd=HERE,
                                 stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        job.assign(child)
        owner = {'version': 1, 'runId': args.run_name, 'projectId': PROJECT, 'cliVersion': CLI_VERSION,
                 'launcher': launcher, 'child': process_identity(child.pid)}
        atomic_json(directory / 'owner.json', owner)
        configuration = {'version': 1, 'runId': args.run_name, 'runtimeRoot': str(root),
                         'runDirectory': str(directory), 'importDirectory': str(previous) if previous else None}
        payload = (json.dumps(configuration) + '\n').encode('utf-8')
        if len(payload) > 4096:
            raise RuntimeError('Private startup configuration is too large.')
        child.stdin.write(payload); child.stdin.flush()
        stage('starting-owned-auth')
        deadline = time.monotonic() + 90
        while True:
            if child.poll() is not None:
                raise RuntimeError('The owned Auth process exited before readiness.')
            rows = scan_ports()
            verify_ports(rows, child.pid)
            if {row['port'] for row in rows} == set(PORTS.values()):
                try:
                    verify_ready(child.pid)
                    verify_imported(previous)
                    break
                except Exception:
                    if time.monotonic() >= deadline:
                        raise RuntimeError('The owned Auth endpoints/import could not be confirmed.') from None
            if time.monotonic() >= deadline:
                raise RuntimeError('The owned Auth process did not become ready in time.')
            time.sleep(.25)
        ready = True
        session = AuthSession(root, directory, child, job)
        stage('ready-auth-only-loopback-import-confirmed' if previous else 'ready-auth-only-loopback-fresh')
        while not session.stopped:
            if child.poll() is not None:
                raise RuntimeError('The owned Auth process stopped unexpectedly; last confirmed export was retained.')
            try:
                requests = sorted((directory / 'requests').glob('*.json'))
                for request in requests:
                    identifier = request.stem
                    if not re_request(identifier):
                        continue
                    response = directory / 'responses' / (identifier + '.json')
                    if response.exists():
                        continue
                    value = None
                    try:
                        value = read_json(request, 1024)
                        if set(value) != {'version', 'runId', 'requestId', 'action'} or value['version'] != 1 or value['runId'] != args.run_name or value['requestId'] != identifier:
                            raise RuntimeError('Invalid owner request.')
                        outcome = session.action(value['action'], identifier)
                        atomic_json(response, outcome)
                        if outcome.get('stopped'):
                            result = outcome
                            break
                    except Exception:
                        atomic_json(response, {'ok': False, 'action': value.get('action') if isinstance(value, dict) else None,
                                               'stopped': False, 'message': 'Export or stop was not confirmed. The owned service and last confirmed snapshot were retained; inspect status before retrying.'})
                time.sleep(.2)
            except KeyboardInterrupt:
                try:
                    result = session.action('stop', uuid.uuid4().hex)
                except Exception:
                    stage('export-unconfirmed-service-left-running')
        return 0 if result and result.get('ok') else 1
    finally:
        stopped = job.stop() if job is not None else True
        summary = {'version': 1, 'runId': args.run_name, 'wasReady': ready, 'ownedProcessesStopped': stopped,
                   'exportConfirmed': bool(result and result.get('exportId')), 'graceful': bool(result and result.get('graceful'))}
        atomic_json(directory / 'summary.json', summary)
        # Clean release only for successful shutdown, or a failed pre-ready start.
        # Abnormal ready-state loss retains its lock as an explicit recovery signal.
        if stopped and (not ready or (result and result.get('ok'))):
            try:
                if read_json(lock_file, 65536) == lock:
                    lock_file.unlink()
            except Exception:
                pass
        if child is not None and child.poll() is None:
            raise RuntimeError('Owned shutdown remains unconfirmed; runtime metadata was retained.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-name', required=True)
    parser.add_argument('--runtime-root')
    parser.add_argument('--node')
    args = parser.parse_args()
    try:
        return launch(args)
    except Exception:
        print('Local Auth startup or shutdown was not confirmed. Existing services, saved exports and ownership metadata were retained for inspection.')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
