"""Portable private Flask service. Only the authenticated Node gateway is public."""
import json
import hmac
import os
from pathlib import Path
import re
import signal
import sys
import threading

HERE = Path(__file__).resolve().parent
FORECAST = HERE.parent / 'forecast'

def configuration(raw):
    if not raw or len(raw)>8192 or not raw.endswith(b'\n'): raise ValueError('Invalid private startup configuration.')
    value=json.loads(raw.decode('utf-8'))
    if not isinstance(value,dict) or set(value)!={'version','key','runtimeRoot'} or type(value['version']) is not int or value['version']!=1 or not isinstance(value['key'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{43,128}',value['key']): raise ValueError('Invalid private startup configuration.')
    directory=Path(value['runtimeRoot']).resolve(strict=True)
    if not directory.is_dir() or directory.is_symlink(): raise ValueError('Invalid owned runtime directory.')
    return value,directory

def main():
    value,directory=configuration(sys.stdin.buffer.readline(8193))
    sys.path.insert(0,str(FORECAST));sys.path.insert(0,str(HERE))
    from importlib.metadata import version
    if version('prophet')!='1.5.0' or version('flask')!='3.1.3': raise RuntimeError('Install the pinned model dependencies.')
    from forecast_service import create_app
    from werkzeug.serving import make_server,WSGIRequestHandler
    if os.name=='nt':
        from windows_runner import WindowsProphetRunner
        from service_main import fit_runtime_root
        runner=WindowsProphetRunner(sys.executable,fit_runtime_root(directory),timeout_seconds=30)
    elif sys.platform.startswith('linux'):
        from linux_runner import LinuxProphetRunner
        runner=LinuxProphetRunner(sys.executable,directory/'fits',timeout_seconds=30)
    else: raise RuntimeError('Only Linux and Windows model workers are supported.')
    app=create_app(value['key'],runner);app.logger.disabled=True
    from flask import request,jsonify
    @app.get('/owned-status')
    def owned_status():
        header=request.headers.get('Authorization','')
        if request.remote_addr not in {'127.0.0.1','::1'} or 'Origin' in request.headers or not header.isascii() or not hmac.compare_digest(header,'Bearer '+value['key']):
            return jsonify({'error':'UNAUTHORIZED'}),401
        previous=runner.last_run or {}
        return jsonify({'version':1,'idle':runner.idle.is_set(),'blocked':runner.blocked,'lastRun':{name:previous.get(name) for name in ['pid','assignedBeforeResume','stoppedConfirmed']}})
    class Quiet(WSGIRequestHandler):
        def log(self,*args,**kwargs): pass
    server=make_server('127.0.0.1',0,app,threaded=True,request_handler=Quiet)
    thread=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.1},daemon=True);thread.start()
    stop=threading.Event()
    def on_signal(*_): stop.set()
    signal.signal(signal.SIGTERM,on_signal);signal.signal(signal.SIGINT,on_signal)
    def control():
        line=sys.stdin.buffer.readline(64)
        # Unknown control input also retires this service instead of accepting more work.
        stop.set()
    reader=threading.Thread(target=control,daemon=True);reader.start()
    print(json.dumps({'stage':'forecast-ready','pid':os.getpid(),'port':server.server_port}),flush=True)
    stop.wait()
    confirmed=app.forecast_close(35)
    server.shutdown();server.server_close();thread.join(timeout=3)
    confirmed=confirmed and not thread.is_alive() and runner.idle.is_set() and not runner.blocked
    print(json.dumps({'stage':'forecast-stopped','stopped':confirmed}),flush=True)
    return 0 if confirmed else 1

if __name__=='__main__':
    try: raise SystemExit(main())
    except Exception:
        print('Private forecast service could not start or stop safely.',file=sys.stderr)
        raise SystemExit(1)
