"""Private Windows prototype: suspended Python worker inside an owned Job.

No process starts on import. This is not a public service launcher.
"""

import ctypes
from ctypes import wintypes
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import uuid

HERE = Path(__file__).resolve().parent
APP_ROOT = HERE.parents[1]
BOUNDARY = APP_ROOT / 'scripts/companion/owned_process.py'
MAX_INPUT = 65536
MAX_OUTPUT = 65536


def load_boundary():
    spec = importlib.util.spec_from_file_location('_prophet_owned_boundary', BOUNDARY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def child_environment(python, directory, source):
    system = source.get('SystemRoot') or source.get('SYSTEMROOT')
    if not system or not Path(system).is_dir():
        raise RuntimeError('Windows system directory is unavailable.')
    directory = Path(directory)
    for name in ('tmp', 'mpl', 'cache', 'config'):
        (directory / name).mkdir()
    return {
        'SystemRoot': system,
        'WINDIR': system,
        'PATH': str(Path(python).parent) + os.pathsep + str(Path(system) / 'System32'),
        'TEMP': str(directory / 'tmp'),
        'TMP': str(directory / 'tmp'),
        'MPLCONFIGDIR': str(directory / 'mpl'),
        'APPDATA': str(directory / 'config'),
        'LOCALAPPDATA': str(directory / 'cache'),
        'XDG_CONFIG_HOME': str(directory / 'config'),
        'XDG_CACHE_HOME': str(directory / 'cache'),
        'OMP_NUM_THREADS': '1',
        'OPENBLAS_NUM_THREADS': '1',
    }


class SecurityAttributes(ctypes.Structure):
    _fields_ = [('length', wintypes.DWORD), ('descriptor', ctypes.c_void_p), ('inherit', wintypes.BOOL)]


class StartupInfo(ctypes.Structure):
    _fields_ = [
        ('cb', wintypes.DWORD), ('reserved', wintypes.LPWSTR), ('desktop', wintypes.LPWSTR),
        ('title', wintypes.LPWSTR), ('x', wintypes.DWORD), ('y', wintypes.DWORD),
        ('xsize', wintypes.DWORD), ('ysize', wintypes.DWORD), ('xchars', wintypes.DWORD),
        ('ychars', wintypes.DWORD), ('fill', wintypes.DWORD), ('flags', wintypes.DWORD),
        ('show', wintypes.WORD), ('reserved2size', wintypes.WORD), ('reserved2', ctypes.c_void_p),
        ('stdin', wintypes.HANDLE), ('stdout', wintypes.HANDLE), ('stderr', wintypes.HANDLE),
    ]


class StartupInfoEx(ctypes.Structure):
    _fields_ = [('startup', StartupInfo), ('attributes', ctypes.c_void_p)]


class ProcessInfo(ctypes.Structure):
    _fields_ = [('process', wintypes.HANDLE), ('thread', wintypes.HANDLE), ('pid', wintypes.DWORD), ('tid', wintypes.DWORD)]


def configure_api(api):
    api.CreatePipe.argtypes = [ctypes.POINTER(wintypes.HANDLE), ctypes.POINTER(wintypes.HANDLE), ctypes.c_void_p, wintypes.DWORD]
    api.SetHandleInformation.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD]
    api.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    api.CreateFileW.restype = wintypes.HANDLE
    api.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.c_size_t)]
    api.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
    api.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
    api.DeleteProcThreadAttributeList.restype = None
    api.CreateProcessW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(ProcessInfo)]
    api.ResumeThread.argtypes = [wintypes.HANDLE]
    api.ResumeThread.restype = wintypes.DWORD
    api.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    api.WaitForSingleObject.restype = wintypes.DWORD
    api.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    api.PeekNamedPipe.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    api.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    api.WriteFile.argtypes = api.ReadFile.argtypes


class ExactProcess:
    def __init__(self, api, info):
        self.api, self._handle, self.pid = api, info.process, info.pid

    def poll(self):
        code = wintypes.DWORD()
        if not self.api.GetExitCodeProcess(self._handle, ctypes.byref(code)):
            raise RuntimeError('Owned process status is unavailable.')
        return None if code.value == 259 else code.value

    def wait(self, timeout):
        if self.api.WaitForSingleObject(self._handle, int(timeout * 1000)) != 0:
            raise TimeoutError('Owned process has not stopped.')
        return self.poll()

    def kill(self):
        if self.poll() is None and not self.api.TerminateProcess(self._handle, 1):
            raise RuntimeError('Owned process could not be stopped.')


def strict_json(raw):
    def pairs(rows):
        result = {}
        for key, value in rows:
            if key in result:
                raise ValueError('Duplicate response field.')
            result[key] = value
        return result
    def constant(_):
        raise ValueError('Nonfinite response.')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant)


class WindowsProphetRunner:
    def __init__(self, python, runtime_root, timeout_seconds=30, worker=None):
        if os.name != 'nt':
            raise RuntimeError('Windows is required.')
        self.python = Path(python).resolve(strict=True)
        self.worker = Path(worker or HERE / 'prophet_worker.py').resolve(strict=True)
        self.runtime = Path(runtime_root).resolve()
        self.runtime.relative_to((APP_ROOT / '.runtime').resolve())
        if not self.python.is_file() or not self.worker.is_file() or not 0.05 <= timeout_seconds <= 120:
            raise ValueError('Choose explicit trusted worker files and a bounded deadline.')
        self.timeout = timeout_seconds
        self.blocked = False
        self.last_run = None
        self.capacity = threading.Lock()

    def __call__(self, history, targets):
        if self.blocked or not self.capacity.acquire(blocking=False):
            raise RuntimeError('The owned runner is unavailable or still busy.')
        try:
            return self._execute(history, targets)
        finally:
            self.capacity.release()

    def _execute(self, history, targets):
        payload = json.dumps({'version': 1, 'history': history, 'targets': targets}, allow_nan=False, separators=(',', ':')).encode('utf-8') + b'\n'
        if len(payload) > MAX_INPUT:
            raise ValueError('Model input exceeds the bounded protocol.')
        directory = self.runtime / ('run-' + uuid.uuid4().hex)
        directory.mkdir(parents=True)
        environment = child_environment(self.python, directory, os.environ)
        boundary = load_boundary()
        job = boundary.OwnedJob()
        api = job.api
        configure_api(api)
        handles = []
        attributes = None
        attributes_initialized = False
        process = None
        writer = None
        write_failed = threading.Event()
        info = ProcessInfo()
        output = bytearray()
        started = time.monotonic()
        self.last_run = {'directory': str(directory), 'pid': None, 'assignedBeforeResume': False, 'stoppedConfirmed': False}
        try:
            security = SecurityAttributes(ctypes.sizeof(SecurityAttributes), None, True)
            child_in, parent_in, parent_out, child_out = (wintypes.HANDLE() for _ in range(4))
            for read, write in ((child_in, parent_in), (parent_out, child_out)):
                if not api.CreatePipe(ctypes.byref(read), ctypes.byref(write), ctypes.byref(security), 65536):
                    raise RuntimeError('Owned pipes could not be created.')
                handles.extend([read.value, write.value])
            for handle in (parent_in, parent_out):
                if not api.SetHandleInformation(handle, 1, 0):
                    raise RuntimeError('Parent pipe ownership could not be installed.')
            null = api.CreateFileW('NUL', 0x40000000, 3, ctypes.byref(security), 3, 0x80, None)
            if not null or null == ctypes.c_void_p(-1).value:
                raise RuntimeError('Private diagnostic sink is unavailable.')
            handles.append(null)
            size = ctypes.c_size_t()
            api.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
            if not size.value:
                raise RuntimeError('Explicit child handle list is unavailable.')
            attributes = ctypes.create_string_buffer(size.value)
            if not api.InitializeProcThreadAttributeList(attributes, 1, 0, ctypes.byref(size)):
                raise RuntimeError('Explicit child handle list could not be initialized.')
            attributes_initialized = True
            inherited = (wintypes.HANDLE * 3)(child_in.value, child_out.value, null)
            if not api.UpdateProcThreadAttribute(attributes, 0, 0x20002, inherited, ctypes.sizeof(inherited), None, None):
                raise RuntimeError('Explicit child handle list could not be installed.')
            startup = StartupInfoEx()
            startup.startup.cb = ctypes.sizeof(StartupInfoEx)
            startup.startup.flags = 0x100
            startup.startup.stdin, startup.startup.stdout, startup.startup.stderr = child_in.value, child_out.value, null
            startup.attributes = ctypes.cast(attributes, ctypes.c_void_p)
            command = ctypes.create_unicode_buffer(subprocess.list2cmdline([str(self.python), '-I', str(self.worker)]))
            block = ctypes.create_unicode_buffer('\0'.join(f'{key}={value}' for key, value in sorted(environment.items())) + '\0')
            flags = 0x4 | 0x400 | 0x80000 | 0x08000000
            if not api.CreateProcessW(str(self.python), command, None, None, True, flags, block, str(directory), ctypes.byref(startup), ctypes.byref(info)):
                raise RuntimeError('The suspended owned worker could not be created.')
            process = ExactProcess(api, info)
            handles.extend([info.process, info.thread])
            self.last_run['pid'] = int(info.pid)
            job.assign(process)
            self.last_run['assignedBeforeResume'] = True
            if api.ResumeThread(info.thread) == 0xFFFFFFFF:
                raise RuntimeError('The assigned worker could not resume.')
            for handle in (child_in.value, child_out.value, null, info.thread):
                api.CloseHandle(handle)
                handles.remove(handle)

            input_handle = parent_in.value
            def send_input():
                try:
                    buffer = ctypes.create_string_buffer(payload)
                    sent = 0
                    while sent < len(payload):
                        count = wintypes.DWORD()
                        if not api.WriteFile(input_handle, ctypes.byref(buffer, sent), min(4096, len(payload) - sent), ctypes.byref(count), None) or not count.value:
                            raise RuntimeError('Owned input was not delivered.')
                        sent += count.value
                except Exception:
                    write_failed.set()
                finally:
                    api.CloseHandle(input_handle)
            writer = threading.Thread(target=send_input, daemon=True)
            writer.start()
            handles.remove(input_handle)
            while True:
                if time.monotonic() - started >= self.timeout:
                    raise TimeoutError('The owned model computation exceeded its deadline.')
                if write_failed.is_set():
                    raise RuntimeError('Owned input delivery failed.')
                available = wintypes.DWORD()
                if not api.PeekNamedPipe(parent_out, None, 0, None, ctypes.byref(available), None):
                    if ctypes.get_last_error() == 109:
                        break
                    raise RuntimeError('Owned output could not be inspected.')
                if available.value:
                    buffer = ctypes.create_string_buffer(min(4096, available.value))
                    count = wintypes.DWORD()
                    if not api.ReadFile(parent_out, buffer, len(buffer), ctypes.byref(count), None):
                        raise RuntimeError('Owned output could not be read.')
                    output.extend(buffer.raw[:count.value])
                    if len(output) > MAX_OUTPUT:
                        raise RuntimeError('Owned model output exceeded its limit.')
                    continue
                if process.poll() is not None:
                    # The worker can write its final bytes between the first peek
                    # and the exit observation. Recheck after confirmed exit.
                    if not api.PeekNamedPipe(parent_out, None, 0, None, ctypes.byref(available), None):
                        if ctypes.get_last_error() == 109:
                            break
                        raise RuntimeError('Final owned output could not be inspected.')
                    if available.value:
                        continue
                    break
                time.sleep(0.01)
            remaining = self.timeout - (time.monotonic() - started)
            if remaining <= 0 or process.wait(timeout=remaining) != 0:
                raise RuntimeError('Owned worker did not complete successfully.')
            remaining = self.timeout - (time.monotonic() - started)
            if remaining <= 0:
                raise TimeoutError('Owned input delivery exceeded its deadline.')
            writer.join(timeout=remaining)
            if writer.is_alive():
                raise TimeoutError('Owned input delivery exceeded its deadline.')
            if write_failed.is_set():
                raise RuntimeError('Owned input delivery failed.')
            result = strict_json(bytes(output))
            if time.monotonic() - started >= self.timeout:
                raise TimeoutError('The owned model result exceeded its deadline.')
            return result
        finally:
            confirmed = job.stop()
            if writer and writer.ident is not None:
                writer.join(timeout=2)
                confirmed = confirmed and not writer.is_alive()
            self.last_run['stoppedConfirmed'] = confirmed
            self.last_run['outputBytes'] = len(output)
            if attributes_initialized:
                api.DeleteProcThreadAttributeList(attributes)
            for handle in reversed(handles):
                api.CloseHandle(handle)
            if not confirmed:
                self.blocked = True
                raise RuntimeError('Owned worker cleanup is unconfirmed; further requests are blocked.')
