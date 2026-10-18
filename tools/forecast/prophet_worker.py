"""One request from stdin; imports Prophet only inside the assigned worker."""
import contextlib
import json
import os
from pathlib import Path
import sys


def main():
    raw = sys.stdin.buffer.readline(65537)
    if not raw or len(raw) > 65536 or not raw.endswith(b'\n'):
        return 2
    request = json.loads(raw.decode('utf-8'))
    if not isinstance(request, dict) or set(request) != {'version', 'history', 'targets'} or request['version'] != 1:
        return 2
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    with open(os.devnull, 'w', encoding='utf-8') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        from monthly_forecast import run_prophet
        result = run_prophet(request['history'], request['targets'])
    output = json.dumps(result, allow_nan=False, separators=(',', ':')).encode('utf-8')
    if len(output) > 65536:
        return 2
    sys.stdout.buffer.write(output)
    sys.stdout.buffer.flush()
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        raise SystemExit(2)
