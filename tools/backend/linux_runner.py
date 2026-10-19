"""One Linux Prophet fit in an owned session, with bounded pipes and confirmed cleanup."""
import ctypes
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid

FORECAST = Path(__file__).resolve().parents[1] / 'forecast'
if str(FORECAST) not in sys.path:
    sys.path.insert(0, str(FORECAST))
from monthly_forecast import ForecastError

MAX_BYTES = 65536

def linux_subreaper():
    if not sys.platform.startswith('linux'):
        raise RuntimeError('The Linux runner requires Linux.')
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('Owned descendant reaping could not be enabled.')

def worker_environment(python, directory):
    for name in ('tmp', 'cache', 'config', 'mpl'):
        (directory / name).mkdir()
    return {'PATH': str(Path(python).parent) + ':/usr/bin:/bin', 'HOME': str(directory),
            'TMPDIR': str(directory / 'tmp'), 'MPLCONFIGDIR': str(directory / 'mpl'),
            'XDG_CACHE_HOME': str(directory / 'cache'), 'XDG_CONFIG_HOME': str(directory / 'config'),
            'OMP_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1', 'LANG': 'C.UTF-8'}

class LinuxProphetRunner:
    def __init__(self, python, runtime_root, timeout_seconds=30, guardian=None):
        linux_subreaper()
        self.python = Path(python).resolve(strict=True)
        self.root = Path(runtime_root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not self.python.is_file() or not self.root.is_dir() or self.root.is_symlink() or not 0.1 <= timeout_seconds <= 60:
            raise ValueError('Invalid owned model paths or deadline.')
        self.guardian = Path(guardian or Path(__file__).with_name('linux_fit_guardian.py')).resolve(strict=True)
        self.timeout = timeout_seconds
        self.lock = threading.Lock()
        self.cancelled = threading.Event()
        self.idle = threading.Event(); self.idle.set()
        self.blocked = False
        self.last_run = None

    def __call__(self, history, targets):
        return self.run(history, targets)

    def cancel(self):
        self.cancelled.set()

    def close(self, timeout_seconds=10):
        self.cancel()
        return self.idle.wait(timeout_seconds) and not self.blocked

    def run(self, history, targets, cancel_event=None):
        if self.blocked or not self.lock.acquire(blocking=False):
            raise ForecastError('CLEANUP_UNCONFIRMED' if self.blocked else 'BUSY')
        self.idle.clear(); self.cancelled.clear()
        process = None; directory = None; selector = None; stopped = False
        try:
            payload = json.dumps({'version': 1, 'history': history, 'targets': targets}, allow_nan=False, separators=(',', ':')).encode('utf-8') + b'\n'
            if len(payload) > MAX_BYTES:
                raise ForecastError('TOO_LARGE')
            directory = self.root / ('fit-' + uuid.uuid4().hex)
            directory.mkdir(mode=0o700)
            env = worker_environment(self.python, directory)
            process = subprocess.Popen([str(self.python), '-I', '-B', str(self.guardian), str(os.getpid())],
                cwd=directory, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
            # start_new_session runs setsid before exec. Never reap this leader before
            # terminating its group; retaining its PID prevents group-id reuse.
            os.set_blocking(process.stdin.fileno(), False)
            os.set_blocking(process.stdout.fileno(), False)
            selector = selectors.DefaultSelector()
            selector.register(process.stdin, selectors.EVENT_WRITE)
            selector.register(process.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + self.timeout
            offset = 0; output = bytearray(); work_count = 0
            while True:
                if self.cancelled.is_set() or (cancel_event is not None and cancel_event.is_set()):
                    raise ForecastError('CANCELLED')
                if time.monotonic() >= deadline:
                    raise ForecastError('TIMEOUT')
                for key, events in selector.select(min(.05, max(0, deadline-time.monotonic()))):
                    work_count += 1
                    if work_count > 8192:
                        raise ForecastError('INVALID_MODEL_RESPONSE')
                    if key.fileobj is process.stdin:
                        try: count = os.write(process.stdin.fileno(), payload[offset:offset+8192])
                        except BlockingIOError: continue
                        if count < 1: raise ForecastError('MODEL_FAILED')
                        offset += count
                        if offset == len(payload): selector.unregister(process.stdin)
                    else:
                        try: chunk = os.read(process.stdout.fileno(), 8192)
                        except BlockingIOError: continue
                        if not chunk: raise ForecastError('MODEL_FAILED')
                        output.extend(chunk)
                        if len(output) > MAX_BYTES: raise ForecastError('INVALID_MODEL_RESPONSE')
                if b'\n' in output:
                    if not output.endswith(b'\n') or output.count(b'\n') != 1 or offset != len(payload):
                        raise ForecastError('INVALID_MODEL_RESPONSE')
                    if time.monotonic() >= deadline: raise ForecastError('TIMEOUT')
                    result = json.loads(output.decode('utf-8'), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                    if not isinstance(result, list) or len(result) != 6:
                        raise ForecastError('INVALID_MODEL_RESPONSE')
                    return result
        except ForecastError:
            raise
        except Exception:
            raise ForecastError('MODEL_FAILED') from None
        finally:
            if selector is not None: selector.close()
            if process is not None:
                try:
                    # Exact child PID is still reserved: no poll()/wait() above.
                    try: os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    process.wait(timeout=5)
                    deadline = time.monotonic() + 3
                    while True:
                        try:
                            while True:
                                child, _ = os.waitpid(-process.pid, os.WNOHANG)
                                if child == 0: break
                        except ChildProcessError: pass
                        try: os.killpg(process.pid, 0)
                        except ProcessLookupError:
                            stopped = True; break
                        if time.monotonic() >= deadline: break
                        time.sleep(.02)
                except Exception: stopped = False
                for stream in (process.stdin, process.stdout):
                    try: stream.close()
                    except Exception: pass
            else: stopped = True
            self.last_run = {'stoppedConfirmed': stopped, 'ownedProcessCreated': process is not None}
            if not stopped: self.blocked = True
            if stopped and directory is not None:
                try:
                    if directory.parent.resolve() != self.root or directory.is_symlink(): raise ValueError()
                    shutil.rmtree(directory)
                except Exception: self.blocked = True
            self.idle.set(); self.lock.release()
            if self.blocked: raise ForecastError('CLEANUP_UNCONFIRMED')
