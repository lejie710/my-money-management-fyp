"""Linux session leader: parent death kills this exact fit group, including native Stan."""
import ctypes
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys

MAX_BYTES = 65536

def stop_group(*_):
    if not sys.platform.startswith('linux') or os.getpgrp() != os.getpid():
        raise SystemExit(2)
    os.killpg(os.getpgrp(), signal.SIGKILL)

def main():
    if not sys.platform.startswith('linux') or len(sys.argv) != 2 or not sys.argv[1].isdigit() or os.getpgrp() != os.getpid():
        return 2
    import resource
    expected_parent = int(sys.argv[1])
    signal.signal(signal.SIGTERM, stop_group)
    signal.signal(signal.SIGINT, stop_group)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0 or os.getppid() != expected_parent:
        stop_group()
    resource.setrlimit(resource.RLIMIT_AS, (2*1024**3, 2*1024**3))
    resource.setrlimit(resource.RLIMIT_CPU, (45, 45))
    resource.setrlimit(resource.RLIMIT_FSIZE, (64*1024**2, 64*1024**2))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    raw = sys.stdin.buffer.readline(MAX_BYTES+1)
    if not raw or len(raw) > MAX_BYTES or not raw.endswith(b'\n'): stop_group()
    # Validate JSON shape here; monthly_forecast validates every money/calendar value.
    payload = json.loads(raw.decode('utf-8'))
    if not isinstance(payload, dict) or set(payload) != {'version','history','targets'} or payload['version'] != 1: stop_group()
    worker = Path(__file__).resolve().parents[1] / 'forecast' / 'prophet_worker.py'
    process = subprocess.Popen([sys.executable, '-I', '-B', str(worker)], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True)
    process.stdin.write(raw); process.stdin.flush(); process.stdin.close()
    output = bytearray()
    while True:
        chunk = process.stdout.read1(8192)
        if not chunk: break
        output.extend(chunk)
        if len(output) > MAX_BYTES-1: stop_group()
    if process.wait() != 0 or not output or b'\n' in output: stop_group()
    sys.stdout.buffer.write(output+b'\n'); sys.stdout.buffer.flush()
    # The owner confirms output, then kills/reaps the still-live group leader.
    # EOF from a crashed owner is also an explicit group cleanup trigger.
    sys.stdin.buffer.read(1)
    stop_group()
    return 2

if __name__ == '__main__':
    try: raise SystemExit(main())
    except Exception: stop_group()
