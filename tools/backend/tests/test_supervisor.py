"""Offline supervisor boundary tests. Native Linux calls and child creation are mocked."""
import importlib.util
import json
from pathlib import Path
import signal
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parents[1]
ROOT=HERE.parents[1]
sys.path.insert(0,str(HERE));sys.path.insert(0,str(HERE.parent/'forecast'))
import linux_runner as module
import forecast_service_main as entry
import linux_fit_guardian as guardian
from monthly_forecast import ForecastError

class Stream:
    def __init__(self,fd):self.fd=fd
    def fileno(self):return self.fd
    def close(self):pass

class Process:
    def __init__(self,events):self.pid=123456;self.stdin=Stream(10);self.stdout=Stream(11);self.events=events
    def wait(self,timeout):self.events.append(('wait',self.pid));return -9

class Selector:
    def __init__(self):self.entries=[]
    def register(self,file,event):self.entries.append((type('Key',(),{'fileobj':file})(),event))
    def unregister(self,file):self.entries=[row for row in self.entries if row[0].fileobj is not file]
    def select(self,timeout):return list(self.entries)
    def close(self):pass

class Supervisor(unittest.TestCase):
    def run_fake(self,output=None,cancel=False,kill_fails=False,time_values=None):
        runtime=ROOT/'.runtime';runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='backend-supervisor-',dir=runtime) as temp:
            events=[];proc=Process(events)
            data=output if output is not None else json.dumps([{'month':'2026-11','estimateMinor':1200.0}]*6).encode()+b'\n'
            def kill(pid,sig):
                events.append(('group',pid,sig))
                if kill_fails:raise PermissionError()
                if sig==0:raise ProcessLookupError()
            cancel_event=threading.Event()
            if cancel:cancel_event.set()
            with patch.object(module,'linux_subreaper'),patch.object(module.subprocess,'Popen',return_value=proc) as popen,patch.object(module.selectors,'DefaultSelector',Selector),patch.object(module.os,'set_blocking'),patch.object(module.os,'write',side_effect=lambda fd,value:len(value)),patch.object(module.os,'read',return_value=data),patch.object(module.os,'killpg',side_effect=kill,create=True),patch.object(module.os,'waitpid',side_effect=ChildProcessError(),create=True),patch.object(module.os,'WNOHANG',1,create=True),patch.object(module.signal,'SIGKILL',9,create=True):
                runner=module.LinuxProphetRunner(sys.executable,Path(temp)/'fits',timeout_seconds=.1)
                clock=patch.object(module.time,'monotonic',side_effect=time_values) if time_values else patch.object(module.time,'monotonic',return_value=1.0)
                with clock:
                    try:result=runner.run([{'month':'2026-09','expenseMinor':1200}],['2026-11'],cancel_event)
                    except ForecastError as error:result=error.code
                return result,runner,events,popen.call_args
    def test_owned_session_output_is_accepted_only_after_group_termination_and_reaping(self):
        result,runner,events,args=self.run_fake()
        self.assertIsInstance(result,list);self.assertTrue(runner.last_run['stoppedConfirmed'])
        self.assertEqual(events[:2],[('group',123456,9),('wait',123456)])
        self.assertTrue(args.kwargs['start_new_session']);self.assertTrue(args.kwargs['close_fds'])
        self.assertNotIn('OPENAI_API_KEY',args.kwargs['env'])
        self.assertNotIn('GOOGLE_APPLICATION_CREDENTIALS',args.kwargs['env'])
    def test_cancel_and_timeout_still_cleanup_only_owned_group(self):
        for values in [{'cancel':True},{'time_values':[1.0,1.2,1.2]}]:
            result,runner,events,_=self.run_fake(**values)
            self.assertIn(result,['CANCELLED','TIMEOUT']);self.assertTrue(runner.last_run['stoppedConfirmed'])
            self.assertEqual(events[0],('group',123456,9))
    def test_oversized_and_multiple_line_outputs_fail_before_acceptance(self):
        for output in [b'x'*65537,b'[]\n[]\n']:
            result,runner,_,_=self.run_fake(output=output)
            self.assertEqual(result,'INVALID_MODEL_RESPONSE');self.assertTrue(runner.last_run['stoppedConfirmed'])
    def test_unconfirmed_cleanup_blocks_next_request(self):
        result,runner,_,_=self.run_fake(kill_fails=True)
        self.assertEqual(result,'CLEANUP_UNCONFIRMED');self.assertTrue(runner.blocked)
        with self.assertRaises(ForecastError) as caught:runner.run([],[])
        self.assertEqual(caught.exception.code,'CLEANUP_UNCONFIRMED')
    def test_guardian_refuses_to_signal_an_unowned_process_group(self):
        with patch.object(guardian.sys,'platform','linux'),patch.object(guardian.os,'getpgrp',return_value=12,create=True),patch.object(guardian.os,'getpid',return_value=34),patch.object(guardian.os,'killpg',create=True) as kill:
            with self.assertRaises(SystemExit):guardian.stop_group()
            kill.assert_not_called()
    def test_private_service_configuration_requires_exact_bounded_shape(self):
        runtime=ROOT/'.runtime';runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='backend-config-',dir=runtime) as temp:
            value={'version':1,'key':'x'*43,'runtimeRoot':temp}
            self.assertEqual(entry.configuration((json.dumps(value)+'\n').encode())[0],value)
            for altered in [{**value,'version':True},{**value,'extra':1},{**value,'key':'short'}]:
                with self.assertRaises(ValueError):entry.configuration((json.dumps(altered)+'\n').encode())
            with self.assertRaises(ValueError):entry.configuration(json.dumps(value).encode())

if __name__=='__main__':unittest.main()
