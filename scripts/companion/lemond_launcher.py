"""Reference-derived Embeddable Lemonade launcher with explicit paths and owned hidden children.

The free-port/key/health/retry sequence follows the Local AI App Integration
reference launcher. Adaptations: verified local assets, Windows job ownership,
bounded JSON, and discarded native output instead of financial-text logs.
"""
import json
import os
import secrets
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,request,fp,code,msg,headers,new_url):
        raise RuntimeError('Local runtime redirects are not allowed.')


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0))
        return sock.getsockname()[1]


def request_json(port,key,path,timeout=10,body=None):
    if type(port) is not int or not 1<=port<=65535 or not path.startswith('/api/v1/') or any(character in path for character in ['#','\\','\r','\n']):
        raise RuntimeError('Invalid local runtime endpoint.')
    url=f'http://127.0.0.1:{port}{path}'
    headers={'Authorization':f'Bearer {key}'}
    data=None
    if body is not None:
        data=json.dumps(body).encode('utf-8')
        if len(data)>4096:raise RuntimeError('Local runtime configuration is oversized.')
        headers['Content-Type']='application/json'
    request=urllib.request.Request(url,data=data,method='POST' if body is not None else 'GET',headers=headers)
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    with opener.open(request,timeout=timeout) as response:
        if response.geturl()!=url:
            raise RuntimeError('The local runtime response came from another URL.')
        data=response.read(1024*1024+1)
        if response.status!=200 or len(data)>1024*1024:
            raise RuntimeError('Runtime response could not be verified.')
        return json.loads(data.decode('utf-8'))


def read_json(port,key,path,timeout=10):
    return request_json(port,key,path,timeout=timeout)


def wait_for_health(port,key,process,timeout_s=30):
    deadline=time.monotonic()+timeout_s
    while time.monotonic()<deadline:
        if process.poll() is not None:
            raise RuntimeError('The owned model server exited before readiness.')
        try:
            health=read_json(port,key,'/api/v1/health',timeout=1)
            if health.get('version')=='2026.42.1' and health.get('telemetry',{}).get('enabled') is False:
                return
        except Exception:
            pass
        time.sleep(.25)
    raise RuntimeError('The owned model server did not pass its bounded health check.')


def start_lemond(package,job,stage,retries=3,runtime_root=None):
    package=Path(package)
    runtime_root=Path(runtime_root) if runtime_root else package.parents[1]
    for attempt in range(retries):
        port,key=free_port(),secrets.token_urlsafe(32)
        stage('starting-private-model-server')
        process=subprocess.Popen([sys.executable,str(Path(__file__).with_name('model_bootstrap.py'))],cwd=package,
            stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            job.assign(process)
            payload=(json.dumps({'version':1,'runtimeRoot':str(runtime_root),'package':str(package),'port':port,'key':key})+'\n').encode('utf-8')
            if len(payload)>4096:raise RuntimeError('Model startup configuration is oversized.')
            process.stdin.write(payload);process.stdin.flush();process.stdin.close()
            wait_for_health(port,key,process)
            stage('model-service-healthy-inference-not-yet-verified')
            return process,key,port
        except Exception:
            # No companion is running during these startup attempts. Stop the
            # exact bootstrap job and every inherited descendant before retrying.
            if not job.stop():raise RuntimeError('Model startup cleanup is unconfirmed; retries stopped.')
            stage('private-model-start-attempt-failed')
            if attempt+1<retries:job.reopen_after_confirmed_stop()
    raise RuntimeError('The owned model server could not be started; no download or fallback was attempted.')
