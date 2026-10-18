"""Windows handles for processes created by this launcher. No process work occurs on import."""
import ctypes
import os
import time
from ctypes import wintypes


class BasicLimits(ctypes.Structure):
    _fields_=[('process_time',ctypes.c_int64),('job_time',ctypes.c_int64),('flags',wintypes.DWORD),
              ('min_working',ctypes.c_size_t),('max_working',ctypes.c_size_t),('active_limit',wintypes.DWORD),
              ('affinity',ctypes.c_size_t),('priority',wintypes.DWORD),('scheduling',wintypes.DWORD)]


class IoCounters(ctypes.Structure):
    _fields_=[(name,ctypes.c_ulonglong) for name in ['read_ops','write_ops','other_ops','read_bytes','write_bytes','other_bytes']]


class ExtendedLimits(ctypes.Structure):
    _fields_=[('basic',BasicLimits),('io',IoCounters),('process_memory',ctypes.c_size_t),
              ('job_memory',ctypes.c_size_t),('peak_process',ctypes.c_size_t),('peak_job',ctypes.c_size_t)]


class Accounting(ctypes.Structure):
    _fields_=[(name,ctypes.c_int64) for name in ['user','kernel','period_user','period_kernel']]+[
        (name,wintypes.DWORD) for name in ['faults','total_processes','active_processes','terminated_processes']]


def kernel():
    if os.name!='nt':
        raise RuntimeError('This companion currently supports Windows only.')
    api=ctypes.WinDLL('kernel32',use_last_error=True)
    api.CloseHandle.argtypes=[wintypes.HANDLE]
    return api


def process_identity(pid):
    api=kernel()
    api.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD]
    api.OpenProcess.restype=wintypes.HANDLE
    api.GetProcessTimes.argtypes=[wintypes.HANDLE]+[ctypes.POINTER(wintypes.FILETIME)]*4
    api.QueryFullProcessImageNameW.argtypes=[wintypes.HANDLE,wintypes.DWORD,wintypes.LPWSTR,ctypes.POINTER(wintypes.DWORD)]
    handle=api.OpenProcess(0x1000|0x100000,False,int(pid))
    if not handle:
        raise RuntimeError('Owned process is unavailable.')
    try:
        times=[wintypes.FILETIME() for _ in range(4)]
        buffer=ctypes.create_unicode_buffer(32768);size=wintypes.DWORD(len(buffer))
        if not api.GetProcessTimes(handle,*[ctypes.byref(value) for value in times]) or not api.QueryFullProcessImageNameW(handle,0,buffer,ctypes.byref(size)):
            raise RuntimeError('Owned process identity could not be read.')
        created=(times[0].dwHighDateTime<<32)|times[0].dwLowDateTime
        return {'pid':int(pid),'createdFileTime':str(created),'executable':buffer.value}
    finally:
        api.CloseHandle(handle)


def verify_identity(record):
    actual=process_identity(record['pid'])
    if actual['createdFileTime']!=record.get('createdFileTime') or os.path.normcase(actual['executable'])!=os.path.normcase(record.get('executable','')):
        raise RuntimeError('Saved PID now belongs to a different process.')
    return actual


class OwnedJob:
    """Assign exact Popen handles before Node receives configuration or any model API request."""
    def __init__(self):
        self.api=kernel()
        self.spawned=[]
        self.stopped_confirmed=False
        self.api.CreateJobObjectW.argtypes=[ctypes.c_void_p,wintypes.LPCWSTR]
        self.api.CreateJobObjectW.restype=wintypes.HANDLE
        self.api.SetInformationJobObject.argtypes=[wintypes.HANDLE,ctypes.c_int,ctypes.c_void_p,wintypes.DWORD]
        self.api.AssignProcessToJobObject.argtypes=[wintypes.HANDLE,wintypes.HANDLE]
        self.api.TerminateJobObject.argtypes=[wintypes.HANDLE,wintypes.UINT]
        self.api.QueryInformationJobObject.argtypes=[wintypes.HANDLE,ctypes.c_int,ctypes.c_void_p,wintypes.DWORD,ctypes.c_void_p]
        self.handle=self.api.CreateJobObjectW(None,None)
        if not self.handle:
            raise RuntimeError('An isolated child process job could not be created.')
        limits=ExtendedLimits();limits.basic.flags=0x2000
        if not self.api.SetInformationJobObject(self.handle,9,ctypes.byref(limits),ctypes.sizeof(limits)):
            self.api.CloseHandle(self.handle);self.handle=None
            raise RuntimeError('Child ownership limits could not be installed.')

    def assign(self,process):
        # CPython on Windows retains the exact CreateProcess handle in Popen;
        # using it avoids opening a later process merely because its PID was reused.
        self.spawned.append(process)
        if process.poll() is not None or not self.api.AssignProcessToJobObject(self.handle,int(process._handle)):
            try:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=10)
            except Exception:
                pass  # Retain the exact Popen handle for stop() and report uncertainty if needed.
            raise RuntimeError('The new child could not be assigned to this run; it was not allowed to start work.')

    def active_count(self):
        info=Accounting()
        if not self.api.QueryInformationJobObject(self.handle,1,ctypes.byref(info),ctypes.sizeof(info),None):
            raise RuntimeError('Owned child completion could not be confirmed.')
        return info.active_processes

    def reopen_after_confirmed_stop(self):
        if self.handle or not self.stopped_confirmed or any(process.poll() is None for process in self.spawned):
            raise RuntimeError('A new startup attempt cannot replace unconfirmed owned work.')
        self.__init__()

    def stop(self):
        if not self.handle:
            return getattr(self,'stopped_confirmed',False)
        confirmed=True
        try:
            if not self.api.TerminateJobObject(self.handle,1):
                confirmed=False
            deadline=time.monotonic()+10
            while self.active_count() and time.monotonic()<deadline:
                time.sleep(.05)
            confirmed=confirmed and self.active_count()==0
        except Exception:
            confirmed=False
        finally:
            self.api.CloseHandle(self.handle);self.handle=None
        for process in self.spawned:
            try:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=10)
            except Exception:
                confirmed=False
        self.stopped_confirmed=confirmed
        return confirmed


def available_memory():
    class Status(ctypes.Structure):
        _fields_=[('length',wintypes.DWORD),('load',wintypes.DWORD)]+[(name,ctypes.c_ulonglong) for name in ['total','available','page_total','page_available','virtual_total','virtual_available','extended']]
    api=kernel();value=Status();value.length=ctypes.sizeof(value)
    if not api.GlobalMemoryStatusEx(ctypes.byref(value)):
        raise RuntimeError('Available memory could not be checked.')
    return value.available
