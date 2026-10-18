"""Verify a running owner, or request its orderly stop. Never kills a process by a saved PID."""
import argparse
import json
from assets import runtime_root
from run_companion import run_directory
from owned_process import verify_identity


def verify_run(root,run_id):
    directory=run_directory(runtime_root(root),run_id)
    if directory.is_symlink():
        raise RuntimeError('A run directory cannot be a link.')
    value=json.loads((directory/'owner.json').read_text(encoding='utf-8'))
    connection=json.loads((directory/'connection.json').read_text(encoding='utf-8'))
    if value.get('version')!=1 or value.get('runId')!=run_id or connection.get('runId')!=run_id or connection.get('pid')!=value.get('companion',{}).get('pid'):
        raise RuntimeError('Runtime ownership records do not match.')
    verify_identity(value['launcher']);verify_identity(value['companion'])
    return directory,value,connection


def verify_stopped_run(root,run_id):
    """Read only: accept a completed exact-owner shutdown, never operate on a saved PID."""
    directory=run_directory(runtime_root(root),run_id)
    if directory.is_symlink():raise RuntimeError('A run directory cannot be a link.')
    value=json.loads((directory/'owner.json').read_text(encoding='utf-8'))
    summary=json.loads((directory/'summary.json').read_text(encoding='utf-8'))
    connection=json.loads((directory/'pairing-connection.json').read_text(encoding='utf-8'))
    if value.get('version')!=1 or value.get('runId')!=run_id or summary.get('version')!=1 or summary.get('runId')!=run_id or summary.get('ownedProcessesStopped') is not True or summary.get('unconfirmedOwnedPids')!=[] or connection.get('runId')!=run_id or type(connection.get('pid')) is not int or connection['pid']!=value.get('companion',{}).get('pid'):
        raise RuntimeError('Completed owned shutdown and pairing proof could not be confirmed.')
    return directory,value,connection


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['verify','verify-stopped','stop'])
    parser.add_argument('--run-name',required=True)
    parser.add_argument('--runtime-root')
    args=parser.parse_args()
    try:
        directory,value,connection=(verify_stopped_run if args.action=='verify-stopped' else verify_run)(args.runtime_root,args.run_name)
        if args.action=='stop':
            if (directory/'pairing.json').exists():
                raise RuntimeError('Clear the exact Android pairing before requesting stop.')
            with (directory/'STOP').open('x',encoding='utf-8') as file:file.write('stop\n')
            print('Stop requested for the verified owner. Check its final summary for confirmed cleanup.')
        else:
            print(json.dumps({'valid':True,'stopped':args.action=='verify-stopped','runId':args.run_name,'companionPid':value['companion']['pid']}))
        return 0
    except Exception:
        print('Owned run verification failed. Existing processes, connection data and device mappings were left unchanged.')
        return 1


if __name__=='__main__':
    raise SystemExit(main())
