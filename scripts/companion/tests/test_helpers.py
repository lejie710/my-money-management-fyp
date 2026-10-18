"""Source-bound helper tests; no provider, native child or ADB is started."""
import argparse
import contextlib
import hashlib
import io
import json
import shutil
import sys
import uuid
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SOURCE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(SOURCE))
import assets
import run_companion
import lemond_launcher
import control
import owned_process
import model_bootstrap
import model_profile
import threading


class Helpers(unittest.TestCase):
    def setUp(self):
        self.base=assets.APP_ROOT/'.runtime'/'companion-tests'
        self.base.mkdir(parents=True,exist_ok=True)
        self.root=self.base/('case-'+uuid.uuid4().hex)
        self.root.mkdir()

    def tearDown(self):
        resolved=self.root.resolve()
        self.assertEqual(resolved.parent,self.base.resolve())
        shutil.rmtree(resolved)

    def zip(self,names):
        file=self.root/'fixture.zip'
        with zipfile.ZipFile(file,'w') as archive:
            for name,content in names:archive.writestr(name,content)
        pin={'bytes':file.stat().st_size,'sha256':assets.digest_file(file),'archivePrefix':''}
        return file,pin

    def test_runtime_paths_and_names_are_bounded(self):
        self.assertEqual(assets.runtime_root(self.root),self.root.resolve())
        with self.assertRaises(RuntimeError):assets.runtime_root(assets.APP_ROOT/'source')
        with self.assertRaises(RuntimeError):run_companion.run_directory(self.root,'../outside')
        with self.assertRaises(RuntimeError):run_companion.run_directory(self.root,'x'*65)

    def test_ocr_plan_does_not_load_or_require_any_model_metadata(self):
        node=self.root/'node.exe';node.write_bytes(b'synthetic')
        args=argparse.Namespace(mode='ocr',runtime_root=self.root,run_name='ocr-only',node=str(node),package_dir=None,model_file=None)
        with patch.object(run_companion,'pins',side_effect=AssertionError('OCR must not require model pins')):
            root,directory,exe,package,model=run_companion.plan(args)
        self.assertIsNone(package);self.assertIsNone(model);self.assertEqual(exe,node)

    def test_archive_targets_reject_escape_symlink_and_duplicates(self):
        for entries in [[('../escape',b'x')],[('same',b'x'),('SAME',b'x')],[('C:/path',b'x')]]:
            file,pin=self.zip(entries)
            with zipfile.ZipFile(file) as archive:
                with self.assertRaises(RuntimeError):assets.archive_entries(archive,'')
        file=self.root/'link.zip'
        with zipfile.ZipFile(file,'w') as archive:
            info=zipfile.ZipInfo('link');info.external_attr=0o120777<<16;archive.writestr(info,'target')
        with zipfile.ZipFile(file) as archive:
            with self.assertRaises(RuntimeError):assets.archive_entries(archive,'')

    def test_extract_and_verify_require_pinned_bytes_and_exclusive_targets(self):
        file,pin=self.zip([('resource.txt',b'synthetic public data')]);target=self.root/'package';target.mkdir()
        assets.extract_checked(file,target,pin);assets.verify_extracted(file,target,pin)
        with self.assertRaises(FileExistsError):assets.extract_checked(file,target,pin)
        (target/'resource.txt').write_bytes(b'changed')
        with self.assertRaises(RuntimeError):assets.verify_extracted(file,target,pin)
        with self.assertRaises(RuntimeError):assets.verify_file(file,{**pin,'sha256':'0'*64})

    def test_offline_profile_is_explicit_and_cannot_overwrite_existing_configuration(self):
        package=self.root/'vendor';(package/'resources').mkdir(parents=True)
        (package/'resources/defaults.json').write_text(json.dumps({'telemetry':{},'llamacpp':{}}),encoding='utf-8')
        assets.write_profile(package,package/'models')
        config=json.loads((package/'config.json').read_text())
        self.assertTrue(config['offline']);self.assertTrue(config['no_fetch_executables']);self.assertFalse(config['telemetry']['enabled']);self.assertEqual(config['llamacpp']['backend'],'vulkan');self.assertEqual(config['ctx_size'],2048)
        self.assertEqual(config['llamacpp']['args'],model_profile.LOAD_ARGUMENTS)
        with self.assertRaises(FileExistsError):assets.write_profile(package,package/'models')

    def test_reference_launcher_assigns_exact_child_before_health_and_never_exposes_key_in_stage_output(self):
        events=[]
        def configure(payload):
            self.assertEqual(events[0][0],'assigned');events.append(('configured',json.loads(payload)))
        child=SimpleNamespace(poll=lambda:None,stdin=SimpleNamespace(write=configure,flush=lambda:None,close=lambda:None))
        job=SimpleNamespace(assign=lambda process:events.append(('assigned',process)))
        def health(port,key,process):
            self.assertEqual(events[0],('assigned',process));self.assertEqual(events[1][0],'configured');self.assertGreaterEqual(len(key),43)
        stages=[]
        with patch.object(lemond_launcher,'free_port',return_value=23456),patch.object(lemond_launcher.subprocess,'Popen',return_value=child) as spawn,patch.object(lemond_launcher,'wait_for_health',side_effect=health):
            actual,key,port=lemond_launcher.start_lemond(self.root,job,stages.append)
        self.assertIs(actual,child);self.assertEqual(port,23456);self.assertFalse(any(key in line for line in stages));self.assertEqual(spawn.call_args.kwargs['creationflags'],lemond_launcher.subprocess.CREATE_NO_WINDOW)
        self.assertTrue(spawn.call_args.args[0][-1].endswith('model_bootstrap.py'));self.assertNotIn('env',spawn.call_args.kwargs)

    def test_model_http_rejects_redirects_and_ignores_proxy_configuration(self):
        with self.assertRaises(RuntimeError):lemond_launcher.NoRedirect().redirect_request(None,None,302,'redirect',{},'https://example.test')
        class Response:
            status=200
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def geturl(self):return 'https://example.test/changed'
            def read(self,size):raise AssertionError('Unexpected response body must not be read')
        def opener(*handlers):
            self.assertEqual(handlers[0].proxies,{})
            self.assertIsInstance(handlers[1],lemond_launcher.NoRedirect)
            return SimpleNamespace(open=lambda request,timeout:Response())
        with patch.object(lemond_launcher.urllib.request,'build_opener',side_effect=opener):
            with self.assertRaises(RuntimeError):lemond_launcher.read_json(12345,'synthetic-key','/api/v1/health')

    def test_model_bootstrap_validates_exact_private_configuration_without_executing_it(self):
        package=self.root/'vendor';package.mkdir();(package/'lemond.exe').write_bytes(b'synthetic')
        config={'version':1,'runtimeRoot':str(self.root),'package':str(package),'port':12345,'key':'x'*43}
        self.assertEqual(model_bootstrap.validate_configuration(config),(package.resolve(),12345,'x'*43))
        for change in [{'package':str(assets.APP_ROOT/'source')},{'port':65536},{'key':'short'},{'unexpected':True}]:
            with self.assertRaises(RuntimeError):model_bootstrap.validate_configuration({**config,**change})

    def test_startup_retry_reopens_same_owner_only_after_complete_job_cleanup(self):
        events=[]
        class Input:
            def write(self,data):events.append('configured')
            def flush(self):pass
            def close(self):pass
        child=SimpleNamespace(poll=lambda:None,stdin=Input())
        job=SimpleNamespace(assign=lambda process:events.append('assigned'),stop=lambda:events.append('stopped') or True,reopen_after_confirmed_stop=lambda:events.append('reopened'))
        count=[0]
        def health(*args):
            count[0]+=1
            if count[0]==1:raise RuntimeError('Synthetic port failure')
        with patch.object(lemond_launcher,'free_port',return_value=12345),patch.object(lemond_launcher.subprocess,'Popen',return_value=child),patch.object(lemond_launcher,'wait_for_health',side_effect=health):
            lemond_launcher.start_lemond(self.root,job,lambda stage:None)
        self.assertEqual(events,['assigned','configured','stopped','reopened','assigned','configured'])

    def test_ocr_owner_runs_without_models_and_drains_only_its_injected_child(self):
        node=self.root/'node.exe';node.write_bytes(b'synthetic');events=[]
        args=argparse.Namespace(mode='ocr',runtime_root=str(self.root),run_name='owned',node=str(node),package_dir=None,model_file=None,port=0)
        directory=self.root/'runs'/'owned'
        class Child:
            pid=12345;returncode=None
            def __init__(self):self.stdin=self
            def poll(self):return self.returncode
            def write(self,value):
                if value==b'stop\n':
                    events.append('stop');self.returncode=0;(directory/'connection.json').unlink()
                else:
                    self_config=json.loads(value);self.assert_assigned()
                    if self_config['model'] is not None:raise AssertionError('OCR mode requested model')
                    (directory/'connection.json').write_text('{}');(directory/'STOP').write_text('stop')
            def assert_assigned(self):
                if 'assign' not in events:raise AssertionError('Child received config before job ownership')
            def flush(self):pass
            def close(self):pass
            def wait(self,timeout=None):return self.returncode
        child=Child();job=SimpleNamespace(assign=lambda process:events.append('assign'),stop=lambda:events.append('job-stop') or True)
        with patch.object(run_companion.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout='v24.22.0\n')),patch.object(run_companion.subprocess,'Popen',return_value=child),patch.object(run_companion,'OwnedJob',return_value=job),patch.object(run_companion,'process_identity',side_effect=lambda pid:{'pid':pid,'createdFileTime':'1','executable':'synthetic.exe'}),patch.object(run_companion,'verify_runtime',side_effect=AssertionError('OCR touched model')),contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(run_companion.launch(args),0)
        self.assertEqual(events,['assign','stop','job-stop']);self.assertTrue(json.loads((directory/'summary.json').read_text())['ownedProcessesStopped'])

    def test_control_verifies_both_live_identities_and_refuses_mismatched_records(self):
        directory=run_companion.run_directory(self.root,'owned');directory.mkdir(parents=True)
        (directory/'owner.json').write_text(json.dumps({'version':1,'runId':'owned','launcher':{'pid':10},'companion':{'pid':20}}))
        (directory/'connection.json').write_text(json.dumps({'runId':'owned','pid':20}))
        with patch.object(control,'verify_identity') as verify:
            control.verify_run(self.root,'owned');self.assertEqual(verify.call_count,2)
        (directory/'connection.json').write_text(json.dumps({'runId':'other','pid':20}))
        with self.assertRaises(RuntimeError):control.verify_run(self.root,'owned')

    def test_assignment_failure_retains_exact_child_for_cleanup_without_a_pid_lookup(self):
        calls=[]
        class Child:
            _handle=55
            stopped=False
            def poll(self):return 0 if self.stopped else None
            def kill(self):
                calls.append('kill')
                if len(calls)==1:raise OSError('Synthetic first failure')
                self.stopped=True
            def wait(self,timeout=None):
                if not self.stopped:raise TimeoutError()
                return 0
        job=owned_process.OwnedJob.__new__(owned_process.OwnedJob)
        job.handle=1;job.spawned=[];job.active_count=lambda:0
        job.api=SimpleNamespace(AssignProcessToJobObject=lambda job,handle:False,TerminateJobObject=lambda job,code:True,CloseHandle=lambda job:None)
        child=Child()
        with self.assertRaises(RuntimeError):job.assign(child)
        self.assertEqual(job.spawned,[child]);self.assertTrue(job.stop());self.assertEqual(calls,['kill','kill'])

    def test_unknown_owned_child_exit_is_reported_as_uncertain(self):
        def failed():raise OSError('Synthetic owned child failure')
        child=SimpleNamespace(poll=lambda:None,kill=failed,wait=lambda timeout:None)
        job=owned_process.OwnedJob.__new__(owned_process.OwnedJob)
        job.handle=1;job.spawned=[child];job.active_count=lambda:0
        job.api=SimpleNamespace(TerminateJobObject=lambda job,code:True,CloseHandle=lambda job:None)
        self.assertFalse(job.stop())
        self.assertFalse(job.stop())

    def test_nonpersistent_model_load_confirms_every_effective_flag_before_returning(self):
        observed=[];guard=SimpleNamespace(check=lambda:None)
        command=['C:/synthetic/llamacpp/vulkan/llama-server.exe']+[value for pair in model_profile.EFFECTIVE_FLAGS.items() for value in pair]
        def request(port,key,endpoint,body,timeout):
            observed.append(body);self.assertEqual(endpoint,'/api/v1/load');self.assertEqual(timeout,120);return {'status':'success'}
        with patch.object(model_profile,'request_json',side_effect=request),patch.object(model_profile,'read_json',return_value={'all_models_loaded':[{'model_name':'synthetic-model','launch_command':command,'loaded':True,'backend_alive':True,'recipe_options':{'ctx_size':2048}}]}):
            loader=model_profile.ModelLoader(guard);loader.load(12345,'private-key','synthetic-model');self.assertTrue(loader.drain())
        self.assertEqual(observed,[{'model_name':'synthetic-model','ctx_size':2048,'llamacpp_backend':'vulkan','llamacpp_args':model_profile.LOAD_ARGUMENTS,'merge_args':False,'save_options':False}])

    def test_effective_profile_rejects_missing_duplicate_wrong_value_or_extra_model(self):
        command=['C:/synthetic/llamacpp/vulkan/llama-server.exe']+[value for pair in model_profile.EFFECTIVE_FLAGS.items() for value in pair]
        model={'model_name':'m','launch_command':command,'loaded':True,'backend_alive':True,'recipe_options':{'ctx_size':2048}}
        for changed in [command[:-1],command+['--cache-ram','0'],[item if item!='2048' else '8192' for item in command],command[:-2]]:
            with self.assertRaises(RuntimeError):model_profile.validate_loaded_health({'all_models_loaded':[{**model,'launch_command':changed}]},'m')
        for rows in [[],[{'model_name':'other','launch_command':command}],[{'model_name':'m','launch_command':command}]*2]:
            with self.assertRaises(RuntimeError):model_profile.validate_loaded_health({'all_models_loaded':rows},'m')

    def test_model_readiness_rejects_dead_cpu_or_wrong_context_even_with_matching_flags(self):
        command=['C:\\synthetic\\llamacpp\\vulkan\\llama-server.exe']+[value for pair in model_profile.EFFECTIVE_FLAGS.items() for value in pair]
        model={'model_name':'m','launch_command':command,'loaded':True,'backend_alive':True,'recipe_options':{'ctx_size':2048}}
        self.assertTrue(model_profile.validate_loaded_health({'all_models_loaded':[model]},'m'))
        for changed in [{'loaded':False},{'loaded':'true'},{'backend_alive':False},{'recipe_options':{'ctx_size':8192}},{'launch_command':['C:/synthetic/llamacpp/cpu/llama-server.exe']+command[1:]}]:
            with self.assertRaises(RuntimeError):model_profile.validate_loaded_health({'all_models_loaded':[{**model,**changed}]},'m')

    def test_runtime_memory_requires_two_consecutive_binary_gib_samples_and_read_failure_fails_closed(self):
        samples=iter([2**30-1,2**30,2**30-1,2**30-2]);guard=model_profile.MemoryGuard(lambda:next(samples),2**30,2)
        guard.observe();guard.check();guard.observe();guard.check();guard.observe();guard.check();guard.observe()
        with self.assertRaises(RuntimeError):guard.check()
        self.assertEqual(guard.minimum_observed,2**30-2)
        failed=model_profile.MemoryGuard(lambda:None,2**30,2);failed.observe();self.assertTrue(failed.read_failed)
        with self.assertRaises(RuntimeError):failed.check()
        self.assertEqual(assets.pins()['profile']['minimumAvailableBytes'],6*2**30)

    def test_memory_stop_during_load_never_replays_request_and_drain_tracks_its_thread(self):
        release=threading.Event();started=threading.Event();calls=[]
        def request(*args,**kwargs):calls.append(1);started.set();release.wait(3);return {'status':'success'}
        def check():
            if started.is_set():raise RuntimeError('Synthetic memory pressure')
        with patch.object(model_profile,'request_json',side_effect=request),patch.object(model_profile,'read_json',side_effect=AssertionError('No health after interrupted load')):
            loader=model_profile.ModelLoader(SimpleNamespace(check=check))
            try:
                with self.assertRaises(RuntimeError):loader.load(12345,'private-key','m')
                self.assertEqual(calls,[1])
            finally:release.set();self.assertTrue(loader.drain())

    def test_post_stop_pairing_proof_requires_completed_exact_owned_summary_without_pid_operations(self):
        directory=run_companion.run_directory(self.root,'stopped');directory.mkdir(parents=True)
        (directory/'owner.json').write_text(json.dumps({'version':1,'runId':'stopped','launcher':{'pid':10},'companion':{'pid':20}}))
        (directory/'pairing-connection.json').write_text(json.dumps({'runId':'stopped','pid':20}))
        summary={'version':1,'runId':'stopped','ownedProcessesStopped':True,'unconfirmedOwnedPids':[]}
        (directory/'summary.json').write_text(json.dumps(summary))
        with patch.object(control,'verify_identity',side_effect=AssertionError('Post-stop clear must not operate on PID')):
            control.verify_stopped_run(self.root,'stopped')
            for changed in [{'ownedProcessesStopped':False},{'ownedProcessesStopped':'true'},{'unconfirmedOwnedPids':[20]},{'runId':'foreign'}]:
                (directory/'summary.json').write_text(json.dumps({**summary,**changed}))
                with self.assertRaises(RuntimeError):control.verify_stopped_run(self.root,'stopped')

    def test_post_runtime_requests_keep_private_bounded_body_and_reject_redirect_before_body_read(self):
        class Response:
            status=200
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def geturl(self):return 'http://127.0.0.1:12345/api/v1/load'
            def read(self,limit):self.assert_limit=limit;return b'{"status":"success"}'
        observed=[]
        def opener(*handlers):
            self.assertEqual(handlers[0].proxies,{});self.assertIsInstance(handlers[1],lemond_launcher.NoRedirect)
            return SimpleNamespace(open=lambda request,timeout:observed.append(request) or Response())
        with patch.object(lemond_launcher.urllib.request,'build_opener',side_effect=opener):
            self.assertEqual(lemond_launcher.request_json(12345,'private-key','/api/v1/load',body={'model_name':'m'}),{'status':'success'})
            self.assertEqual(observed[0].get_method(),'POST');self.assertEqual(json.loads(observed[0].data),{'model_name':'m'})
            with self.assertRaises(RuntimeError):lemond_launcher.request_json(12345,'private-key','/api/v1/load',body={'large':'x'*5000})

    def test_owned_model_memory_stop_uses_short_child_drain_and_reports_exact_owned_cleanup(self):
        node=self.root/'node.exe';node.write_bytes(b'synthetic');events=[];directory=self.root/'runs'/'model-pressure'
        args=argparse.Namespace(mode='assistant',runtime_root=str(self.root),run_name='model-pressure',node=str(node),package_dir=str(self.root/'package'),model_file=str(self.root/'model.gguf'),port=0)
        class Process:
            returncode=None
            def __init__(self,pid):self.pid=pid;self.stdin=self
            def poll(self):return self.returncode
            def kill(self):events.append(('kill',self.pid));self.returncode=0
            def write(self,value):
                if value==b'stop\n':self.returncode=0;(directory/'connection.json').unlink();events.append(('stop-child',self.pid))
                else:
                    if 'bounded-load' not in events:raise AssertionError('Node client configured before model profile proof')
                    (directory/'connection.json').write_text('{}')
            def flush(self):pass
            def close(self):pass
            def wait(self,timeout=None):events.append(('wait',self.pid,timeout));return self.returncode
        class Guard:
            tripped=False;read_failed=False;minimum_observed=2**30-1;checks=0
            def start(self):pass
            def check(self):
                self.checks+=1
                if self.checks>=2:self.tripped=True;raise RuntimeError('Synthetic pressure')
            def close(self):events.append('guard-closed')
        server=Process(12340);child=Process(12341);guard=Guard()
        job=SimpleNamespace(spawned=[],assign=lambda process:events.append(('assigned',process.pid)),stop=lambda:events.append('job-stop') or True)
        def start(*args,**kwargs):job.assign(server);return server,'private-key',23456
        loader=SimpleNamespace(load=lambda *args:events.append('bounded-load'),drain=lambda:events.append('request-drained') or True)
        with patch.object(run_companion.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout='v24.22.0\n')),patch.object(run_companion.subprocess,'Popen',return_value=child),patch.object(run_companion,'OwnedJob',return_value=job),patch.object(run_companion,'process_identity',side_effect=lambda pid:{'pid':pid,'createdFileTime':'1','executable':'synthetic.exe'}),patch.object(run_companion,'verify_runtime'),patch.object(run_companion,'available_memory',return_value=7*2**30),patch.object(run_companion,'MemoryGuard',return_value=guard),patch.object(run_companion,'ModelLoader',return_value=loader),patch.object(run_companion,'start_lemond',side_effect=start),patch.object(run_companion,'read_json',return_value={'data':[{'id':assets.pins()['model']['id'],'downloaded':True}]}),contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(run_companion.launch(args),1)
        self.assertIn(('wait',child.pid,2),events);self.assertIn(('kill',server.pid),events);self.assertIn('job-stop',events)
        summary=json.loads((directory/'summary.json').read_text());self.assertTrue(summary['memoryGuardTripped']);self.assertTrue(summary['ownedProcessesStopped']);self.assertTrue(summary['requestThreadsDrained'])


if __name__=='__main__':unittest.main()
