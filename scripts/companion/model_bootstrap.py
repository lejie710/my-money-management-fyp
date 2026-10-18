"""Wait for bounded private stdin before starting Lemond inside an already assigned Windows Job."""
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from assets import inside, runtime_root


def validate_configuration(value):
    if not isinstance(value,dict) or set(value)!={'version','runtimeRoot','package','port','key'} or value['version']!=1:
        raise RuntimeError('Invalid model bootstrap configuration.')
    root=runtime_root(value['runtimeRoot'])
    package=inside(value['package'],root)
    if not isinstance(value['port'],int) or isinstance(value['port'],bool) or not 1<=value['port']<=65535 or not isinstance(value['key'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{43,128}',value['key']):
        raise RuntimeError('Invalid model bootstrap endpoint.')
    if not (package/'lemond.exe').is_file():
        raise RuntimeError('The verified Lemond executable is unavailable.')
    return package,value['port'],value['key']


def main():
    if os.name!='nt':raise RuntimeError('Windows is required.')
    raw=sys.stdin.buffer.readline(4097)
    if not raw or len(raw)>4096 or not raw.endswith(b'\n'):
        raise RuntimeError('Missing bounded model configuration.')
    package,port,key=validate_configuration(json.loads(raw))
    # The parent does not send this configuration until this bootstrap is in
    # its Job Object. Descendants therefore inherit the owned job at creation.
    child=subprocess.Popen([str(package/'lemond.exe'),str(package),'--port',str(port)],cwd=package,
        env={**os.environ,'LEMONADE_API_KEY':key},stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)
    return child.wait()


if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception:
        print('The owned model bootstrap refused startup.',file=sys.stderr)
        raise SystemExit(1)
