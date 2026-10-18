"""Explicit Windows OCR/assistant owner. Importing this file never starts a process."""
import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from assets import HERE, inside, pins, runtime_root, verify_runtime
from owned_process import OwnedJob, available_memory, process_identity
from lemond_launcher import start_lemond, read_json
from model_profile import MemoryGuard, ModelLoader
from provider_config import select_for_arguments, has_local_model, companion_environment


def run_directory(root, run_id):
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',run_id):
        raise RuntimeError('Use a new lowercase run name of at most 64 characters.')
    return inside(Path(root)/'runs'/run_id,root)


def plan(args, selection=None):
    selection=selection or select_for_arguments(args)
    root=runtime_root(args.runtime_root)
    directory=run_directory(root,args.run_name)
    node=Path(args.node or shutil.which('node') or '').resolve()
    if not node.is_file() or node.name.lower()!='node.exe':
        raise RuntimeError('Choose an installed Node.js executable explicitly.')
    package=model=None
    if has_local_model(selection):
        lock=pins()
        package=inside(args.package_dir or root/'vendor'/('lemonade-'+lock['lemonade']['version']),root)
        model=inside(args.model_file or package/'models'/lock['model']['cachePath'],root)
    return root,directory,node,package,model


def launch(args):
    if os.name!='nt':
        raise RuntimeError('This local companion currently supports Windows only.')
    selection=select_for_arguments(args)
    root,directory,node,package,model=plan(args,selection)
    checked=subprocess.run([str(node),'--version'],capture_output=True,text=True,env=companion_environment(os.environ),creationflags=subprocess.CREATE_NO_WINDOW,timeout=10)
    match=re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)\s*',checked.stdout)
    if checked.returncode or not match or tuple(map(int,match.groups()))<(24,12,0):
        raise RuntimeError('Node.js 24.12 or later is required.')
    if has_local_model(selection):
        verify_runtime(root,package,model)
        if available_memory()<pins()['profile']['minimumAvailableBytes']:
            raise RuntimeError('Available memory is below the bounded assistant profile.')
    directory.mkdir(parents=True,exist_ok=False)
    def stage(name):
        text=json.dumps({'stage':name,'unix':time.time()})
        try:
            with (directory/'stages.log').open('a',encoding='utf-8') as output:
                output.write(text+'\n')
        except OSError:
            pass
        try:print(text,flush=True)
        except OSError:pass
    job=OwnedJob();server=child=None;failure=False;shutdown_confirmed=False;guard=loader=None;forecast_service=None;forecast_stopped=True
    try:
        model_config=None
        if has_local_model(selection):
            guard=MemoryGuard(available_memory,pins()['profile']['runtimeMinimumAvailableBytes'],pins()['profile']['runtimeLowMemorySamples'])
            guard.start();guard.check();loader=ModelLoader(guard)
            server,key,port=start_lemond(package,job,stage,runtime_root=root)
            catalog=read_json(port,key,'/api/v1/models?show_all=true')
            if not any(row.get('id')==pins()['model']['id'] and row.get('downloaded') is True for row in catalog.get('data',[])):
                raise RuntimeError('Pinned model is not present in the actual runtime catalog.')
            stage('loading-model-explicit-nonpersistent-bounded-profile')
            loader.load(port,key,pins()['model']['id'])
            stage('effective-model-cache-and-backend-flags-confirmed')
            model_config={'baseUrl':f'http://127.0.0.1:{port}/api/v1','key':key}
        forecast_config=None
        if selection['providers']['forecast']:
            source=HERE.parents[1]/'tools'/'forecast'/'launcher.py'
            spec=importlib.util.spec_from_file_location('_owned_forecast_launcher',source)
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            forecast_service=module.start_owned_forecast(selection['forecastPython'],directory,job)
            forecast_config={'baseUrl':forecast_service['baseUrl'],'key':forecast_service['key']}
            stage('owned-forecast-service-ready-model-not-yet-requested')
        # Private provider credentials travel only in the bounded stdin message.
        # Ambient unrelated credentials and Node boot hooks are not inherited.
        child_environment=companion_environment(os.environ)
        with (directory/'companion.log').open('wb') as output:
            child=subprocess.Popen([str(node),str(HERE/'child.cjs')],cwd=HERE,env=child_environment,stdin=subprocess.PIPE,stdout=output,stderr=output,creationflags=subprocess.CREATE_NO_WINDOW)
            job.assign(child)
            ownership={'version':1,'runId':args.run_name,'mode':getattr(args,'mode',None) or 'configured','launcher':process_identity(os.getpid()),'companion':process_identity(child.pid),'model':process_identity(server.pid) if server else None,'forecast':process_identity(forecast_service.get('servicePid',forecast_service['process'].pid)) if forecast_service else None,'providers':selection['providers']}
            with (directory/'owner.json').open('x',encoding='utf-8') as file:
                json.dump(ownership,file,indent=2)
            config={'version':2,'runId':args.run_name,'runtimeRoot':str(root),'runDirectory':str(directory),'port':args.port,'model':model_config,'forecast':forecast_config,'providers':selection['providers'],'credentials':selection['secrets']}
            payload=(json.dumps(config)+'\n').encode('utf-8')
            if len(payload)>4096:
                raise RuntimeError('Runtime configuration exceeds its bounded channel.')
            child.stdin.write(payload);child.stdin.flush()
            deadline=time.monotonic()+15
            while not (directory/'connection.json').is_file():
                if guard:guard.check()
                if child.poll() is not None or time.monotonic()>deadline:
                    raise RuntimeError('Companion startup was not confirmed.')
                time.sleep(.1)
            stage('shared-companion-ready-selected-providers-configured')
            while not (directory/'STOP').exists():
                if guard:guard.check()
                if child.poll() is not None:
                    raise RuntimeError('The owned companion stopped unexpectedly.')
                if forecast_service and forecast_service['process'].poll() is not None:
                    raise RuntimeError('The owned forecast service stopped unexpectedly.')
                time.sleep(.25)
            # Pairing must be cleared while the exact run still exists. A request
            # to stop never silently removes another emulator's reverse mapping.
            if (directory/'pairing.json').exists():
                raise RuntimeError('Clear this run\'s Android pairing before stopping.')
    except BaseException:
        failure=True
        stage('owned-run-failed-or-interrupted')
    finally:
        stage('stopping-owned-children')
        if child is not None and child.poll() is None:
            try:
                child.stdin.write(b'stop\n');child.stdin.flush();child.stdin.close();child.wait(timeout=2 if guard and guard.tripped else 135)
            except Exception:
                failure=True
        if forecast_service:
            try: forecast_stopped=forecast_service['close']()
            except Exception: forecast_stopped=False
            if not forecast_stopped: failure=True
        if server is not None and server.poll() is None:
            # The job handle, not a saved PID or process name, owns final termination.
            try:server.kill()
            except Exception:failure=True
        try:
            shutdown_confirmed=job.stop()
        except Exception:
            shutdown_confirmed=False
        for process in [child,server,forecast_service['process'] if forecast_service else None]:
            if process is not None:
                try:process.wait(timeout=10)
                except Exception:shutdown_confirmed=False
        requests_drained=loader.drain() if loader else True
        if guard:guard.close()
        if child is not None and child.returncode!=0:
            failure=True
        summary={'version':1,'runId':args.run_name,'ownedProcessesStopped':shutdown_confirmed,'connectionRemoved':not (directory/'connection.json').exists(),'pairingCleared':not (directory/'pairing.json').exists(),'failed':failure,'unconfirmedOwnedPids':[process.pid for process in getattr(job,'spawned',[]) if process.poll() is None],'requestThreadsDrained':requests_drained,'forecastStopped':forecast_stopped,'memoryGuardTripped':guard.tripped if guard else False,'memoryReadFailed':guard.read_failed if guard else False,'minimumAvailableBytes':guard.minimum_observed if guard else None}
        (directory/'summary.json').write_text(json.dumps(summary,indent=2)+'\n',encoding='utf-8')
        stage('owned-run-stopped' if shutdown_confirmed else 'owned-run-stop-unconfirmed')
    return 1 if failure or not shutdown_confirmed or not requests_drained else 0


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode',choices=['ocr','assistant'])
    parser.add_argument('--provider-config',help='Explicit private JSON configuration under the ignored .runtime directory.')
    parser.add_argument('--check-config',action='store_true',help='Validate configuration and print only public descriptors; start no process.')
    parser.add_argument('--run-name',required=True)
    parser.add_argument('--runtime-root')
    parser.add_argument('--node')
    parser.add_argument('--package-dir')
    parser.add_argument('--model-file')
    parser.add_argument('--port',type=int,default=0)
    args=parser.parse_args()
    if not 0<=args.port<=65535:parser.error('Use a valid port, or 0 for an available port.')
    if args.provider_config and args.mode:
        parser.error('Choose either the legacy --mode option or --provider-config.')
    try:
        if args.check_config:
            print(json.dumps(select_for_arguments(args)['providers'],indent=2))
            return 0
        return launch(args)
    except Exception:
        print('Companion startup refused. Check local paths, pinned assets, run name and prerequisites. No download or cloud fallback was attempted.')
        return 1


if __name__=='__main__':
    raise SystemExit(main())
