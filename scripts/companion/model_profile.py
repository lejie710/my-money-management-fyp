"""Bounded, explicit local model load; no provider work occurs at import."""
import threading
import time
from lemond_launcher import read_json, request_json

LOAD_ARGUMENTS = '--threads 4 --batch-size 128 --ubatch-size 128 --parallel 1 --cache-ram 0 --cache-type-k f16 --cache-type-v f16'
EFFECTIVE_FLAGS = {'--threads':'4','--batch-size':'128','--ubatch-size':'128','--parallel':'1','--cache-ram':'0','--cache-type-k':'f16','--cache-type-v':'f16','--ctx-size':'2048'}


def validate_loaded_health(value, model_id):
    rows=value.get('all_models_loaded') if isinstance(value,dict) else None
    if not isinstance(rows,list) or len(rows)!=1 or not isinstance(rows[0],dict) or rows[0].get('model_name')!=model_id:
        raise RuntimeError('The exact single loaded model was not confirmed.')
    command=rows[0].get('launch_command')
    if not isinstance(command,list) or not all(isinstance(item,str) for item in command):
        raise RuntimeError('Effective bounded backend arguments were not confirmed.')
    model=rows[0]
    if model.get('loaded') is not True or model.get('backend_alive') is not True or not isinstance(model.get('recipe_options'),dict) or model['recipe_options'].get('ctx_size')!=2048 or not command or not command[0].replace('\\','/').lower().endswith('/llamacpp/vulkan/llama-server.exe'):
        raise RuntimeError('A live Vulkan backend with the bounded context was not confirmed.')
    for flag,expected in EFFECTIVE_FLAGS.items():
        positions=[index for index,item in enumerate(command) if item==flag]
        if len(positions)!=1 or positions[0]+1>=len(command) or command[positions[0]+1]!=expected:
            raise RuntimeError('Effective bounded backend arguments were not confirmed.')
    return True


class MemoryGuard:
    """Samples only memory size; stores no questions, paths, responses or credentials."""
    def __init__(self, read_available, minimum_bytes, consecutive_samples):
        self.read_available=read_available
        self.minimum_bytes=minimum_bytes
        self.consecutive_samples=consecutive_samples
        self.low_samples=0
        self.minimum_observed=None
        self.tripped=False
        self.read_failed=False
        self.done=threading.Event()
        self.thread=None
    def observe(self):
        try:
            available=self.read_available()
            if type(available) is not int or available<0:raise ValueError()
            self.minimum_observed=available if self.minimum_observed is None else min(available,self.minimum_observed)
            self.low_samples=self.low_samples+1 if available<self.minimum_bytes else 0
            self.tripped=self.tripped or self.low_samples>=self.consecutive_samples
        except Exception:
            self.read_failed=True
            self.tripped=True
    def start(self):
        self.observe()
        def sample():
            while not self.done.wait(1):self.observe()
        self.thread=threading.Thread(target=sample,daemon=True)
        self.thread.start()
    def check(self):
        if self.tripped:raise RuntimeError('The local model memory guard stopped this owned run.')
    def close(self):
        self.done.set()
        if self.thread is not None:self.thread.join(timeout=2)


class ModelLoader:
    def __init__(self, guard):
        self.guard=guard
        self.requests=[]
    def load(self,port,key,model_id):
        done=threading.Event();outcome={}
        body={'model_name':model_id,'ctx_size':2048,'llamacpp_backend':'vulkan','llamacpp_args':LOAD_ARGUMENTS,'merge_args':False,'save_options':False}
        def query():
            try:outcome['response']=request_json(port,key,'/api/v1/load',body=body,timeout=120)
            except Exception:outcome['error']=True
            finally:done.set()
        self.guard.check()
        request=threading.Thread(target=query,daemon=True);self.requests.append(request);request.start()
        deadline=time.monotonic()+125
        while not done.wait(.25):
            self.guard.check()
            if time.monotonic()>=deadline:raise RuntimeError('The explicit model load exceeded its deadline.')
        self.guard.check()
        if outcome.get('error') or not isinstance(outcome.get('response'),dict) or outcome['response'].get('status')!='success':
            raise RuntimeError('The explicit bounded model load was not confirmed.')
        validate_loaded_health(read_json(port,key,'/api/v1/health'),model_id)
    def drain(self):
        for request in self.requests:request.join(timeout=3)
        return not any(request.is_alive() for request in self.requests)
