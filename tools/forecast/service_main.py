"""Owned loopback service: private stdin configuration precedes any listener."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import threading

HERE = Path(__file__).resolve().parent
APP_ROOT = HERE.parents[1]


def configuration(raw):
    if not raw or len(raw) > 8192 or not raw.endswith(b'\n'):
        raise ValueError('Missing bounded forecast configuration.')
    value = json.loads(raw.decode('utf-8'))
    if not isinstance(value, dict) or set(value) != {'version', 'runId', 'runDirectory', 'key', 'modelPython', 'sitePackages'} or type(value['version']) is not int or value['version'] != 1:
        raise ValueError('Invalid forecast configuration.')
    if not isinstance(value['runId'], str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', value['runId']):
        raise ValueError('Invalid forecast run identity.')
    if not isinstance(value['key'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{43,128}', value['key']):
        raise ValueError('Invalid private forecast key.')
    directory = Path(value['runDirectory']).resolve(strict=True)
    directory.relative_to((APP_ROOT / '.runtime').resolve())
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('Invalid forecast run directory.')
    model_python = Path(value['modelPython']).resolve(strict=True)
    site_packages = Path(value['sitePackages']).resolve(strict=True)
    if not model_python.is_file() or not (site_packages / 'flask').is_dir() or not (site_packages / 'prophet').is_dir():
        raise ValueError('The selected forecast environment is unavailable.')
    return value, directory


# CmdStan adds a worker UUID, temporary directories and output filenames below
# this root. Keep that owned path short instead of inheriting the launcher depth.
MAX_FIT_ROOT_UNITS = 120

def fit_runtime_root(service_directory):
    directory = Path(service_directory).resolve()
    runtime = (APP_ROOT / '.runtime').resolve()
    if not directory.relative_to(runtime).parts:
        raise ValueError('Use an owned service directory inside the runtime root.')
    owner = hashlib.sha256(os.path.normcase(str(directory)).encode('utf-8')).hexdigest()[:20]
    target = runtime / 'forecast-fits' / owner
    if len(str(target).encode('utf-16-le')) // 2 > MAX_FIT_ROOT_UNITS:
        raise ValueError('Use a shorter project checkout path for the Windows Prophet worker.')
    return target


def main():
    if os.name != 'nt':
        raise RuntimeError('Windows is required.')
    value, directory = configuration(sys.stdin.buffer.readline(8193))
    sys.path.insert(0, str(Path(value['sitePackages']).resolve()))
    sys.path.insert(0, str(HERE))
    from importlib.metadata import version
    if version('prophet') != '1.5.0' or version('flask') != '3.1.3':
        raise RuntimeError('Use the reviewed Prophet and Flask package versions.')
    from forecast_service import create_app
    from windows_runner import WindowsProphetRunner
    from werkzeug.serving import make_server, WSGIRequestHandler
    class QuietHandler(WSGIRequestHandler):
        def log(self, *args, **kwargs):
            pass
    runner = WindowsProphetRunner(value['modelPython'], fit_runtime_root(directory), timeout_seconds=30)
    app = create_app(value['key'], runner)
    app.logger.disabled = True
    server = make_server('127.0.0.1', 0, app, threaded=True, request_handler=QuietHandler)
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.1}, daemon=True)
    thread.start()
    print(json.dumps({'stage': 'forecast-ready', 'pid': os.getpid(), 'port': server.server_port}), flush=True)
    confirmed = False
    try:
        while True:
            line = sys.stdin.buffer.readline(64)
            if not line or line == b'stop\n':
                break
            raise RuntimeError('Unsupported forecast lifecycle command.')
    finally:
        confirmed = app.forecast_close(25)
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
        confirmed = confirmed and not thread.is_alive() and runner.idle.is_set() and not runner.blocked
        print(json.dumps({'stage': 'forecast-stopped', 'stopped': confirmed}), flush=True)
    return 0 if confirmed else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print('Owned forecast service failed; no request or credential was logged.', file=sys.stderr)
        raise SystemExit(1)
