import os
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import subprocess
import sys
import time
import unittest
import uuid
from unittest.mock import patch
from types import SimpleNamespace
from windows_runner import WindowsProphetRunner, child_environment, configure_api, load_boundary, strict_json, APP_ROOT, HERE


class RunnerTests(unittest.TestCase):
    def make(self, source, timeout=3):
        directory = APP_ROOT / '.runtime' / 'forecast-tests' / uuid.uuid4().hex
        directory.mkdir(parents=True)
        worker = directory / 'worker.py'
        worker.write_text(source, encoding='utf-8')
        return WindowsProphetRunner(sys.executable, directory / 'runs', timeout, worker)

    def test_suspended_assignment_bounded_roundtrip_and_no_inherited_secret(self):
        source = "import json,os,sys\np=json.loads(sys.stdin.buffer.readline(65537))\nprint(json.dumps({'history':p['history'],'secret':os.environ.get('FYP_REVIEW_PRIVATE_VALUE')}))\n"
        runner = self.make(source)
        before = os.environ.get('FYP_REVIEW_PRIVATE_VALUE')
        os.environ['FYP_REVIEW_PRIVATE_VALUE'] = 'synthetic-private-value'
        try:
            self.assertEqual(runner([{'month': '2026-09', 'expenseMinor': 100}], []), {'history': [{'month': '2026-09', 'expenseMinor': 100}], 'secret': None})
        finally:
            if before is None: os.environ.pop('FYP_REVIEW_PRIVATE_VALUE', None)
            else: os.environ['FYP_REVIEW_PRIVATE_VALUE'] = before
        self.assertTrue(runner.last_run['assignedBeforeResume'])
        self.assertTrue(runner.last_run['stoppedConfirmed'])

    def test_deadline_stops_worker_and_native_descendant_job(self):
        source = "import subprocess,sys,time\nsys.stdin.buffer.readline(65537)\nsubprocess.Popen([sys.executable,'-I','-c','import time; time.sleep(60)'])\ntime.sleep(60)\n"
        runner = self.make(source, 0.5)
        started = time.monotonic()
        with self.assertRaises(TimeoutError): runner([], [])
        self.assertLess(time.monotonic() - started, 5)
        self.assertTrue(runner.last_run['stoppedConfirmed'])

    def test_output_overflow_is_stopped_and_not_accepted(self):
        runner = self.make("import sys\nsys.stdin.buffer.readline(65537)\nsys.stdout.write('x'*131072)\nsys.stdout.flush()\n")
        with self.assertRaisesRegex(RuntimeError, 'output exceeded'): runner([], [])
        self.assertTrue(runner.last_run['stoppedConfirmed'])

    def test_unread_stdin_does_not_escape_deadline(self):
        runner = self.make("import time\ntime.sleep(60)\n", 0.3)
        with self.assertRaises(TimeoutError): runner(['x' * 60000], [])
        self.assertTrue(runner.last_run['stoppedConfirmed'])

    def test_nonzero_and_invalid_output_never_return_success(self):
        for source in ["import sys\nsys.stdin.buffer.readline(65537)\nsys.exit(2)\n", "import sys\nsys.stdin.buffer.readline(65537)\nprint('not JSON')\n"]:
            runner = self.make(source)
            with self.assertRaises((RuntimeError, ValueError)): runner([], [])
            self.assertTrue(runner.last_run['stoppedConfirmed'])

    def test_duplicate_and_nonfinite_json_rejected(self):
        for raw in [b'{"x":1,"x":2}', b'{"x":NaN}', b'\xff']:
            with self.assertRaises((ValueError, UnicodeError)): strict_json(raw)

    def test_final_output_is_drained_when_exit_races_the_first_empty_peek(self):
        boundary = load_boundary()
        raced = []
        class RaceJob(boundary.OwnedJob):
            def __init__(self):
                super().__init__()
                configure_api(self.api)
                original = self.api.PeekNamedPipe
                def peek(*args):
                    result = original(*args)
                    available = args[4]._obj
                    if result and available.value and not raced:
                        self.spawned[0].wait(timeout=1)
                        available.value = 0
                        raced.append(True)
                    return result
                self.api.PeekNamedPipe = peek
        runner = self.make("import json,sys\nsys.stdin.buffer.readline(65537)\nprint(json.dumps({'tail':'x'*5000}))\n")
        with patch('windows_runner.load_boundary', return_value=SimpleNamespace(OwnedJob=RaceJob)):
            self.assertEqual(runner([], []), {'tail': 'x' * 5000})
        self.assertEqual(raced, [True])
        self.assertTrue(runner.last_run['stoppedConfirmed'])

    def test_late_input_write_failure_cannot_accept_a_valid_worker_response(self):
        boundary = load_boundary()
        class LateWriteJob(boundary.OwnedJob):
            def __init__(self):
                super().__init__()
                configure_api(self.api)
                original = self.api.WriteFile
                def write(*args):
                    self.spawned[0].wait(timeout=1)
                    time.sleep(0.1)
                    return original(*args)
                self.api.WriteFile = write
        runner = self.make("import sys\nsys.stdin.close()\nprint('{\"valid\":true}')\n")
        with patch('windows_runner.load_boundary', return_value=SimpleNamespace(OwnedJob=LateWriteJob)):
            with self.assertRaisesRegex(RuntimeError, 'input delivery failed'):
                runner([], [])
        self.assertTrue(runner.last_run['stoppedConfirmed'])

    def test_parent_crash_closes_noninherited_job_and_stops_exact_worker_handles(self):
        directory = APP_ROOT / '.runtime' / 'forecast-tests' / uuid.uuid4().hex
        directory.mkdir(parents=True)
        identities = directory / 'identities.json'
        assignment = directory / 'assignment.json'
        worker = directory / 'crash_worker.py'
        worker.write_text(
            "import json,os,subprocess,sys,time\nfrom pathlib import Path\n"
            "sys.stdin.buffer.readline(65537)\n"
            "child=subprocess.Popen([sys.executable,'-I','-c','import time; time.sleep(60)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)\n"
            f"Path({str(identities)!r}).write_text(json.dumps({{'worker':os.getpid(),'descendant':child.pid}}),encoding='utf-8')\n"
            "time.sleep(60)\n", encoding='utf-8')
        parent_script = directory / 'crash_parent.py'
        parent_script.write_text(
            "import ctypes,json,os,sys\nfrom ctypes import wintypes\nfrom pathlib import Path\n"
            f"sys.path.insert(0,{str(HERE)!r})\n"
            "import windows_runner as runner\n"
            "boundary=runner.load_boundary()\noriginal=boundary.OwnedJob\n"
            "class ObservedJob(original):\n"
            " def assign(self,process):\n"
            "  super().assign(process)\n"
            "  self.api.GetHandleInformation.argtypes=[wintypes.HANDLE,ctypes.POINTER(wintypes.DWORD)]\n"
            "  flags=wintypes.DWORD()\n"
            "  if not self.api.GetHandleInformation(self.handle,ctypes.byref(flags)): raise RuntimeError('handle check failed')\n"
            f"  Path({str(assignment)!r}).write_text(json.dumps({{'parent':os.getpid(),'worker':process.pid,'jobHandleInheritable':bool(flags.value&1)}}),encoding='utf-8')\n"
            "boundary.OwnedJob=ObservedJob\nrunner.load_boundary=lambda:boundary\n"
            f"runner.WindowsProphetRunner(sys.executable,{str(directory / 'runs')!r},timeout_seconds=60,worker={str(worker)!r})([],[])\n",
            encoding='utf-8')
        base = Path(getattr(sys, '_base_executable', sys.executable)).resolve(strict=True)
        parent_env_dir = directory / 'parent-environment'
        parent_env_dir.mkdir()
        environment = child_environment(base, parent_env_dir, os.environ)
        parent = subprocess.Popen([str(base), '-I', str(parent_script)], cwd=directory,
            env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
        boundary = load_boundary()
        api = boundary.kernel()
        configure_api(api)
        api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        api.OpenProcess.restype = wintypes.HANDLE
        api.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        api.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        captured = []
        try:
            deadline = time.monotonic() + 5
            data = assigned = None
            while time.monotonic() < deadline:
                self.assertIsNone(parent.poll(), 'Owned test parent exited before child identity capture.')
                try:
                    data = json.loads(identities.read_text(encoding='utf-8'))
                    assigned = json.loads(assignment.read_text(encoding='utf-8'))
                    break
                except (OSError, ValueError):
                    time.sleep(0.02)
            self.assertIsNotNone(data)
            self.assertEqual(assigned['parent'], parent.pid)
            self.assertEqual(assigned['worker'], data['worker'])
            self.assertFalse(assigned['jobHandleInheritable'])
            self.assertEqual(os.path.normcase(boundary.process_identity(parent.pid)['executable']), os.path.normcase(str(base)))
            for pid in (data['worker'], data['descendant']):
                expected = boundary.process_identity(pid)
                self.assertEqual(os.path.normcase(expected['executable']), os.path.normcase(str(base)))
                handle = api.OpenProcess(0x1000 | 0x100000 | 1, False, pid)
                self.assertTrue(handle)
                times = [wintypes.FILETIME() for _ in range(4)]
                name = ctypes.create_unicode_buffer(32768)
                size = wintypes.DWORD(len(name))
                verified = False
                try:
                    self.assertTrue(api.GetProcessTimes(handle, *[ctypes.byref(value) for value in times]))
                    self.assertTrue(api.QueryFullProcessImageNameW(handle, 0, name, ctypes.byref(size)))
                    created = str((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime)
                    self.assertEqual(created, expected['createdFileTime'])
                    self.assertEqual(os.path.normcase(name.value), os.path.normcase(expected['executable']))
                    verified = True
                    captured.append(handle)
                finally:
                    if not verified: api.CloseHandle(handle)
            # Popen retains this exact base-Python parent handle; no PID lookup is used to kill it.
            parent.kill()
            parent.wait(timeout=3)
            for handle in captured:
                self.assertEqual(api.WaitForSingleObject(handle, 3000), 0,
                    'A captured owned descendant survived closure of the parent Job handle.')
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait(timeout=3)
            for handle in captured:
                if api.WaitForSingleObject(handle, 0) != 0:
                    api.TerminateProcess(handle, 1)
                    api.WaitForSingleObject(handle, 3000)
                api.CloseHandle(handle)


    def test_explicit_cancel_stops_owned_worker_before_deadline_and_allows_a_fresh_call(self):
        import threading
        from monthly_forecast import ForecastError
        runner = self.make("import sys,time\nsys.stdin.buffer.readline(65537)\ntime.sleep(60)\n", 10)
        outcomes = []
        def fit():
            try: runner([], [])
            except ForecastError as error: outcomes.append(error.code)
        task = threading.Thread(target=fit)
        task.start()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and not (runner.last_run and runner.last_run['assignedBeforeResume']):
            time.sleep(0.01)
        self.assertTrue(runner.cancel())
        task.join(3)
        self.assertFalse(task.is_alive())
        self.assertEqual(outcomes, ['CANCELLED'])
        self.assertTrue(runner.last_run['stoppedConfirmed'])
        self.assertFalse(runner.blocked)
        self.assertTrue(runner.close())
        with self.assertRaises(RuntimeError): runner([], [])

    def test_pre_cancelled_request_never_starts_a_worker(self):
        import threading
        from monthly_forecast import ForecastError
        runner = self.make("raise AssertionError('must never execute')\n")
        cancel = threading.Event(); cancel.set()
        with self.assertRaises(ForecastError) as error: runner.run([], [], cancel_event=cancel)
        self.assertEqual(error.exception.code, 'CANCELLED')
        self.assertIsNone(runner.last_run['pid'])
        self.assertTrue(runner.last_run['stoppedConfirmed'])


    def test_unconfirmed_cleanup_has_explicit_error_and_blocks_another_worker(self):
        from monthly_forecast import ForecastError
        boundary = load_boundary()
        class UnconfirmedJob(boundary.OwnedJob):
            def stop(self):
                super().stop()  # Actually stop the synthetic worker; only its report is uncertain.
                return False
        runner = self.make("import sys\nsys.stdin.buffer.readline(65537)\nprint('[]')\n")
        with patch('windows_runner.load_boundary', return_value=SimpleNamespace(OwnedJob=UnconfirmedJob)):
            with self.assertRaises(ForecastError) as error: runner([], [])
            self.assertEqual(error.exception.code, 'CLEANUP_UNCONFIRMED')
        previous = runner.last_run
        self.assertTrue(runner.blocked)
        with self.assertRaises(RuntimeError): runner([], [])
        self.assertIs(runner.last_run, previous)


if __name__ == '__main__': unittest.main()
