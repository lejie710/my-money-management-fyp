"""Start a verified local Prophet service inside a caller-owned Windows Job."""
import json
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import queue
import re
import secrets
import subprocess
import threading
import time
import urllib.request

HERE = Path(__file__).resolve().parent
APP_ROOT = HERE.parents[1]
VERSION = 'recorded-expense-prophet-v1'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('Local forecast redirects are not allowed.')


def start_owned_forecast(python_executable, run_directory, job):
    if os.name != 'nt' or not callable(getattr(job, 'assign', None)):
        raise RuntimeError('Use a caller-owned Windows process Job.')
    python = Path(python_executable).resolve(strict=True)
    parent = Path(run_directory).resolve(strict=True)
    parent.relative_to((APP_ROOT / '.runtime').resolve())
    if not python.is_file() or not parent.is_dir() or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', parent.name):
        raise ValueError('Use an explicit interpreter and owned run directory.')
    venv = python.parent.parent
    venv_config = venv / 'pyvenv.cfg'
    if venv_config.is_file():
        if venv_config.stat().st_size > 4096:
            raise ValueError('The selected Python environment metadata is invalid.')
        properties = dict(line.split('=', 1) for line in venv_config.read_text(encoding='utf-8').splitlines() if '=' in line)
        home = next((value.strip() for key, value in properties.items() if key.strip() == 'home'), '')
        service_python = (Path(home) / 'python.exe').resolve(strict=True)
        site_packages = (venv / 'Lib' / 'site-packages').resolve(strict=True)
    else:
        service_python = python
        site_packages = (python.parent / 'Lib' / 'site-packages').resolve(strict=True)
    if not service_python.is_file() or not (site_packages / 'flask').is_dir() or not (site_packages / 'prophet').is_dir():
        raise ValueError('Install the pinned forecast requirements in the selected Python environment.')
    directory = parent / 'forecast-service'
    directory.mkdir()
    for name in ('tmp', 'mpl', 'cache', 'config'):
        (directory / name).mkdir()
    key = secrets.token_urlsafe(32)
    system = os.environ.get('SystemRoot') or os.environ.get('SYSTEMROOT')
    if not system:
        raise RuntimeError('Windows system directory is unavailable.')
    env = {'SystemRoot': system, 'WINDIR': system,
           'PATH': str(python.parent) + os.pathsep + str(Path(system) / 'System32'),
           'TMP': str(directory / 'tmp'), 'TEMP': str(directory / 'tmp'),
           'MPLCONFIGDIR': str(directory / 'mpl'), 'APPDATA': str(directory / 'config'),
           'LOCALAPPDATA': str(directory / 'cache'), 'OMP_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1'}
    process = subprocess.Popen([str(service_python), '-I', '-S', '-B', str(HERE / 'service_main.py')],
        cwd=directory, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
    statuses = queue.Queue(maxsize=4)
    reader_failed = threading.Event()
    def read_status():
        try:
            while True:
                raw = process.stdout.readline(8193)
                if not raw:
                    break
                if len(raw) > 8192 or not raw.endswith(b'\n'):
                    raise RuntimeError('Unbounded forecast status.')
                statuses.put_nowait(json.loads(raw.decode('utf-8')))
        except Exception:
            reader_failed.set()
    reader = threading.Thread(target=read_status, daemon=True)
    stopped = None
    service_handle = None
    close_lock = threading.Lock()
    def close():
        nonlocal stopped, service_handle
        with close_lock:
            if stopped is not None:
                return stopped
            try:
                if process.poll() is None:
                    process.stdin.write(b'stop\n')
                    process.stdin.flush()
                    process.stdin.close()
                process.wait(timeout=35)
                reader.join(timeout=2)
                messages = []
                while not statuses.empty():
                    messages.append(statuses.get_nowait())
                stopped = process.returncode == 0 and not reader_failed.is_set() and not reader.is_alive() and any(message == {'stage': 'forecast-stopped', 'stopped': True} for message in messages)
            except Exception:
                stopped = False
                if process.poll() is None:
                    process.kill()
                try:
                    process.wait(timeout=10)
                except Exception:
                    pass
            if service_handle is not None:
                job.api.CloseHandle(service_handle)
                service_handle = None
            return stopped
    try:
        job.assign(process)
        reader.start()
        configuration = {'version': 1, 'runId': parent.name, 'runDirectory': str(directory), 'key': key, 'modelPython': str(python), 'sitePackages': str(site_packages)}
        process.stdin.write(json.dumps(configuration, separators=(',', ':')).encode('utf-8') + b'\n')
        process.stdin.flush()
        ready = statuses.get(timeout=30)
        if not isinstance(ready, dict) or set(ready) != {'stage', 'pid', 'port'} or ready['stage'] != 'forecast-ready' or type(ready['pid']) is not int or ready['pid'] <= 0 or type(ready['port']) is not int or not 1 <= ready['port'] <= 65535:
            raise RuntimeError('Owned forecast startup was not confirmed.')
        # Windows virtual-environment launchers may relay a base Python child.
        # Retain its exact handle and prove membership in the caller's Job.
        api = job.api
        api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        api.OpenProcess.restype = wintypes.HANDLE
        api.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
        api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        api.WaitForSingleObject.restype = wintypes.DWORD
        service_handle = api.OpenProcess(0x1000 | 0x100000, False, ready['pid'])
        included = wintypes.BOOL()
        if not service_handle or not api.IsProcessInJob(service_handle, job.handle, ctypes.byref(included)) or not included.value or api.WaitForSingleObject(service_handle, 0) != 258:
            raise RuntimeError('The announced forecast service is not live in its owned Job.')
        base = f"http://127.0.0.1:{ready['port']}"
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        request = urllib.request.Request(base + '/health', headers={'Authorization': 'Bearer ' + key})
        with opener.open(request, timeout=5) as response:
            raw = response.read(4097)
            if response.status != 200 or response.geturl() != base + '/health' or len(raw) > 4096:
                raise RuntimeError('Owned forecast health was not confirmed.')
            body = json.loads(raw)
        if body != {'version': 1, 'status': 'ready', 'engine': 'prophet', 'contractVersion': VERSION} or process.poll() is not None or api.WaitForSingleObject(service_handle, 0) != 258:
            raise RuntimeError('Owned forecast identity was not confirmed.')
        return {'process': process, 'servicePid': ready['pid'], 'port': ready['port'], 'key': key, 'baseUrl': base, 'close': close}
    except Exception:
        close()
        raise RuntimeError('The owned local forecast service could not start.') from None
