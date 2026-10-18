"""Request an export or graceful stop from the verified running owner; never kills by saved PID."""
import argparse
import json
import time
import uuid
from auth_runtime import runtime_root, run_name, inside, read_json, publish_json_exclusive, scan_ports, verify_ports, PROJECT, CLI_VERSION
from owned_process import verify_identity


def verify_owner(root, name):
    root = runtime_root(root)
    directory = inside(root / 'runs' / run_name(name), root)
    owner = read_json(directory / 'owner.json', 65536)
    lock = read_json(root / 'owner-lock.json', 65536)
    if owner.get('version') != 1 or owner.get('runId') != name or owner.get('projectId') != PROJECT or owner.get('cliVersion') != CLI_VERSION or lock != {'version': 1, 'runId': name, 'launcher': owner.get('launcher')}:
        raise RuntimeError('Run ownership does not match.')
    verify_identity(owner['launcher']); verify_identity(owner['child'])
    verify_ports(scan_ports(), owner['child']['pid'], require_all=True)
    return directory, owner


def request_action(root, name, action):
    if action not in ('export', 'stop'):
        raise RuntimeError('Use export or stop.')
    directory, owner = verify_owner(root, name)
    identifier = uuid.uuid4().hex
    request = directory / 'requests' / (identifier + '.json')
    publish_json_exclusive(request, {'version': 1, 'runId': name, 'requestId': identifier, 'action': action})
    deadline = time.monotonic() + 120
    response = directory / 'responses' / (identifier + '.json')
    while time.monotonic() < deadline:
        if response.exists():
            return read_json(response, 65536)
        verify_identity(owner['launcher'])
        time.sleep(.2)
    raise RuntimeError('The requested outcome remains unconfirmed; no action was replayed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['export', 'stop'])
    parser.add_argument('--run-name', required=True)
    parser.add_argument('--runtime-root')
    args = parser.parse_args()
    try:
        result = request_action(args.runtime_root, args.run_name, args.action)
        print(json.dumps({'action': args.action, 'confirmed': result.get('ok') is True,
                          'stopped': result.get('stopped') is True, 'exportId': result.get('exportId')}))
        return 0 if result.get('ok') is True else 1
    except Exception:
        print('The owned local Auth action could not be confirmed. No unrelated process was stopped and no request was automatically replayed.')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
