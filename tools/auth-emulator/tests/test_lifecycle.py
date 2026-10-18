"""Portable source/lifecycle tests. No process, service, socket or account is started."""
import json
import shutil
import sys
import uuid
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
import auth_runtime as runtime
import run_auth
import control


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.base = runtime.APP_ROOT / '.runtime' / 'auth-tool-tests'
        self.base.mkdir(parents=True, exist_ok=True)
        self.root = self.base / ('case-' + uuid.uuid4().hex)
        self.root.mkdir()

    def tearDown(self):
        resolved = self.root.resolve()
        self.assertEqual(resolved.parent, self.base.resolve())
        shutil.rmtree(resolved)

    def snapshot(self, target, users=None):
        target = Path(target)
        (target / 'auth_export').mkdir(parents=True, exist_ok=True)
        (target / 'firebase-export-metadata.json').write_text(json.dumps({'version': runtime.CLI_VERSION,
            'auth': {'version': runtime.CLI_VERSION, 'path': 'auth_export'}}), encoding='utf-8')
        (target / 'auth_export/accounts.json').write_text(json.dumps({'users': users if users is not None else [
            {'localId': 'synthetic-a', 'email': 'a@example.test', 'displayName': 'Account A', 'passwordHash': 'synthetic-only'}]}), encoding='utf-8')
        (target / 'auth_export/config.json').write_text('{"signIn":{"allowDuplicateEmails":false}}', encoding='utf-8')

    def ports(self, pid=42):
        return [{'address': '127.0.0.1', 'port': value, 'pid': pid} for value in runtime.PORTS.values()]

    def request(self, port, route, body=None):
        if route == '/': return {'pid': 42, 'version': runtime.CLI_VERSION}
        if route == '/emulators': return {key: {'host': '127.0.0.1', 'port': value} for key, value in runtime.PORTS.items()}
        if route.endswith('/config'): return {'signIn': {}}
        if route == '/_admin/export': self.snapshot(body['path']); return {'message': 'OK'}
        raise AssertionError('Unexpected endpoint')

    def test_paths_and_run_names_cannot_escape_runtime(self):
        self.assertEqual(runtime.runtime_root(self.root), self.root.resolve())
        for value in ['', '../outside', 'Upper', 'a' * 65]:
            with self.assertRaises(RuntimeError): runtime.run_name(value)
        with self.assertRaises(RuntimeError): runtime.runtime_root(runtime.APP_ROOT / 'tools')

    def test_atomic_metadata_creation_collision_never_deletes_an_existing_file(self):
        target = self.root / 'status.json'
        temporary = self.root / ('status.json.' + 'a' * 32 + '.tmp')
        temporary.write_bytes(b'preserve-existing')
        with patch.object(runtime.uuid, 'uuid4', return_value=SimpleNamespace(hex='a' * 32)):
            with self.assertRaises(FileExistsError): runtime.atomic_json(target, {'stage': 'ready'})
        self.assertEqual(temporary.read_bytes(), b'preserve-existing')
        self.assertFalse(target.exists())

    def test_control_reader_observes_only_complete_atomically_published_request(self):
        directory = self.root / 'run'
        (directory / 'requests').mkdir(parents=True)
        (directory / 'responses').mkdir()
        original_link = runtime.os.link
        observed = []
        def publish(source, destination):
            self.assertEqual(list((directory / 'requests').glob('*.json')), [])
            value = runtime.read_json(source)
            self.assertEqual(value['action'], 'export')
            original_link(source, destination)
            visible = list((directory / 'requests').glob('*.json'))
            self.assertEqual(visible, [destination])
            observed.append(runtime.read_json(visible[0]))
            runtime.atomic_json(directory / 'responses' / destination.name, {'ok': True})
        with patch.object(control, 'verify_owner', return_value=(directory, {'launcher': {}})), patch.object(runtime.os, 'link', side_effect=publish):
            self.assertEqual(control.request_action(self.root, 'owned', 'export'), {'ok': True})
        self.assertEqual(len(observed), 1)
        self.assertEqual(list((directory / 'requests').glob('*.pending')), [])

    def test_exclusive_request_publication_preserves_existing_destination_and_temp(self):
        target = self.root / 'request.json'
        target.write_bytes(b'preserve-request')
        with self.assertRaises(FileExistsError): runtime.publish_json_exclusive(target, {'action': 'stop'})
        self.assertEqual(target.read_bytes(), b'preserve-request')
        temporary = target.with_name(target.name + '.' + 'a' * 32 + '.pending')
        temporary.write_bytes(b'preserve-temp')
        with patch.object(runtime.uuid, 'uuid4', return_value=SimpleNamespace(hex='a' * 32)):
            with self.assertRaises(FileExistsError): runtime.publish_json_exclusive(target, {})
        self.assertEqual(temporary.read_bytes(), b'preserve-temp')

    def test_existing_or_external_listener_is_never_adopted(self):
        with self.assertRaises(RuntimeError): runtime.verify_ports(self.ports())
        for change in [{'pid': 99}, {'address': '0.0.0.0'}, {'address': '::'}]:
            rows = self.ports(); rows[0].update(change)
            with self.assertRaises(RuntimeError): runtime.verify_ports(rows, 42, True)
        runtime.verify_ports(self.ports(), 42, True)
        with self.assertRaises(RuntimeError): runtime.verify_ports(self.ports()[:1], 42, True)

    def test_port_query_is_fixed_read_only_command_without_script_policy_changes(self):
        def execute(arguments, **options):
            self.assertEqual(arguments[-2:], ['-Command', runtime.PORT_QUERY])
            self.assertNotIn('-File', arguments)
            self.assertNotIn('-ExecutionPolicy', arguments)
            self.assertNotIn('-EncodedCommand', arguments)
            self.assertIn('Get-NetTCPConnection -State Listen', arguments[-1])
            self.assertEqual(options['timeout'], 15)
            return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps(self.ports()))
        with patch.object(runtime.subprocess, 'run', side_effect=execute):
            self.assertEqual(runtime.scan_ports(), self.ports())
        with patch.object(runtime.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stderr='', stdout='{}')):
            with self.assertRaisesRegex(RuntimeError, 'snapshot'): runtime.scan_ports()

    def test_ready_requires_exact_pid_version_and_three_loopback_endpoints(self):
        runtime.verify_ready(42, self.request)
        for replacement in [{'pid': 99, 'version': runtime.CLI_VERSION}, {'pid': 42, 'version': 'other'}]:
            with self.assertRaises(RuntimeError): runtime.verify_ready(42, lambda port, route: replacement if route == '/' else self.request(port, route))
        def wrong(port, route):
            return {**self.request(port, route), 'ui': {'host': '127.0.0.1', 'port': 4000}} if route == '/emulators' else self.request(port, route)
        with self.assertRaises(RuntimeError): runtime.verify_ready(42, wrong)

    def test_http_disables_proxies_and_rejects_redirects_before_reading_body(self):
        with self.assertRaises(RuntimeError): runtime.NoRedirect().redirect_request(None)
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def geturl(self): return 'https://example.test'
            def read(self, count): raise AssertionError('Do not read redirected data')
        def opener(*handlers):
            self.assertEqual(handlers[0].proxies, {})
            self.assertIsInstance(handlers[1], runtime.NoRedirect)
            return SimpleNamespace(open=lambda *args, **kwargs: Response())
        with patch.object(runtime.urllib.request, 'build_opener', side_effect=opener):
            with self.assertRaises(RuntimeError): runtime.local_json(9099, '/test')
        with self.assertRaises(RuntimeError): runtime.local_json(8081, '/test')

    def test_fresh_verified_export_promotes_pointer_only_after_integrity_confirmation(self):
        identifier = runtime.export_owned(self.root, 'snapshot-one', 42, ports=self.ports, request=self.request)
        self.assertEqual(identifier, 'snapshot-one')
        destination = runtime.import_directory(self.root)
        self.assertEqual(destination, self.root / 'exports/snapshot-one')
        integrity = runtime.verify_export(destination)
        self.assertEqual(integrity['userCount'], 1)
        self.assertEqual(len(integrity['files']), 3)
        self.assertNotIn('synthetic-a', json.dumps(integrity))
        with self.assertRaises(FileExistsError): runtime.export_owned(self.root, identifier, 42, ports=self.ports, request=self.request)

    def test_failed_or_malformed_export_preserves_previous_pointer_and_partial_files(self):
        runtime.export_owned(self.root, 'snapshot-good', 42, ports=self.ports, request=self.request)
        before = (self.root / 'last-export.json').read_bytes()
        def broken(port, route, body=None):
            if body is not None:
                (Path(body['path']) / 'partial.json').write_text('{}')
                raise RuntimeError('Synthetic interrupted export')
            return self.request(port, route)
        with self.assertRaises(RuntimeError): runtime.export_owned(self.root, 'snapshot-failed', 42, ports=self.ports, request=broken)
        self.assertEqual((self.root / 'last-export.json').read_bytes(), before)
        self.assertTrue((self.root / 'exports/snapshot-failed/partial.json').is_file())

    def test_missing_users_array_never_promotes_an_apparently_empty_export(self):
        runtime.export_owned(self.root, 'snapshot-good', 42, ports=self.ports, request=self.request)
        before = (self.root / 'last-export.json').read_bytes()
        def malformed(port, route, body=None):
            if body is not None:
                self.snapshot(body['path'])
                (Path(body['path']) / 'auth_export/accounts.json').write_text('{}', encoding='utf-8')
                return {'message': 'OK'}
            return self.request(port, route)
        with self.assertRaisesRegex(RuntimeError, 'account list'):
            runtime.export_owned(self.root, 'snapshot-missing-users', 42, ports=self.ports, request=malformed)
        self.assertEqual((self.root / 'last-export.json').read_bytes(), before)

    def test_import_checks_explicit_empty_users_and_rejects_missing_or_malformed_lists(self):
        directory = self.root / 'snapshot'; self.snapshot(directory, [])
        runtime.verify_imported(directory, lambda *args: {'users': []})
        for value in [{}, {'users': None}, {'users': {}}, {'users': [{'localId': 'a'}, {'localId': 'a'}]}, {'users': [{'localId': 'a', 'emailVerified': 'false'}]}]:
            with self.assertRaises(RuntimeError): runtime.verify_imported(directory, lambda *args: value)
        (directory / 'auth_export/accounts.json').write_text('{}', encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError, 'account list'):
            runtime.verify_imported(directory, lambda *args: {'users': []})

    def test_import_refuses_changed_or_unrecognized_export_without_fresh_fallback(self):
        runtime.export_owned(self.root, 'snapshot-good', 42, ports=self.ports, request=self.request)
        file = self.root / 'exports/snapshot-good/auth_export/accounts.json'
        file.write_text('{"users":[]}', encoding='utf-8')
        with self.assertRaises(RuntimeError): runtime.import_directory(self.root)
        self.assertEqual(file.read_text(), '{"users":[]}')
        (self.root / 'last-export.json').write_text('{broken')
        with self.assertRaises(RuntimeError): runtime.import_directory(self.root)

    def test_imported_ids_and_profiles_are_checked_without_password_or_user_values_in_error(self):
        directory = self.root / 'snapshot'; self.snapshot(directory)
        expected = runtime.read_json(directory / 'auth_export/accounts.json')
        runtime.verify_imported(directory, lambda *args: expected)
        with self.assertRaisesRegex(RuntimeError, 'IDs/profile fields'):
            runtime.verify_imported(directory, lambda *args: {'users': [{'localId': 'different'}]})

    def session(self, exporter=None, graceful=True, stopped=True, remaining=None):
        events = []
        class Child:
            pid = 42
            returncode = None
            def __init__(self): self.stdin = self
            def poll(self): return self.returncode
            def write(self, value): events.append(('stdin', value))
            def flush(self): pass
            def close(self): pass
            def wait(self, timeout):
                events.append(('wait', timeout)); self.returncode = 0 if graceful else 1
        def export(*args): events.append(('export',)); return 'snapshot-confirmed'
        job = SimpleNamespace(stop=lambda: events.append(('owned-job-stop',)) or stopped)
        value = run_auth.AuthSession(self.root, self.root, Child(), job,
                                     ports=lambda: remaining or [], exporter=exporter or export)
        return value, events

    def test_export_failure_keeps_service_alive_and_never_sends_stop_or_kills(self):
        def broken(*args): raise RuntimeError('Unknown export outcome')
        session, events = self.session(exporter=broken)
        with self.assertRaises(RuntimeError): session.action('stop', 'a' * 32)
        self.assertEqual(events, [])
        self.assertFalse(session.stopped)

    def test_export_only_does_not_stop_running_service(self):
        session, events = self.session()
        result = session.action('export', 'b' * 32)
        self.assertTrue(result['ok']); self.assertFalse(result['stopped'])
        self.assertEqual(events, [('export',)])

    def test_stop_orders_verified_export_before_graceful_child_stop_and_owned_job_drain(self):
        session, events = self.session()
        result = session.action('stop', 'c' * 32)
        self.assertTrue(result['ok']); self.assertTrue(result['stopped']); self.assertTrue(result['graceful'])
        self.assertEqual(events, [('export',), ('stdin', b'stop\n'), ('wait', 30), ('owned-job-stop',)])

    def test_failed_graceful_stop_or_changed_ports_never_claim_a_clean_shutdown(self):
        for options in [{'graceful': False}, {'stopped': False}, {'remaining': self.ports(99)}]:
            session, events = self.session(**options)
            result = session.action('stop', 'd' * 32)
            self.assertFalse(result['ok'])
            self.assertEqual(result['exportId'], 'snapshot-confirmed')
            self.assertEqual(events.count(('owned-job-stop',)), 1)

    def test_control_requires_exact_owner_record_live_identities_and_loopback_ports(self):
        directory = self.root / 'runs/owned'; directory.mkdir(parents=True)
        owner = {'version': 1, 'runId': 'owned', 'projectId': runtime.PROJECT, 'cliVersion': runtime.CLI_VERSION,
                 'launcher': {'pid': 1}, 'child': {'pid': 42}}
        runtime.atomic_json(directory / 'owner.json', owner)
        runtime.atomic_json(self.root / 'owner-lock.json', {'version': 1, 'runId': 'owned', 'launcher': owner['launcher']})
        with patch.object(control, 'verify_identity') as verify, patch.object(control, 'scan_ports', return_value=self.ports()):
            actual, _ = control.verify_owner(self.root, 'owned')
            self.assertEqual(actual, directory); self.assertEqual(verify.call_count, 2)
        with patch.object(control, 'verify_identity', side_effect=RuntimeError('PID reused')), patch.object(control, 'scan_ports', return_value=self.ports()):
            with self.assertRaises(RuntimeError): control.verify_owner(self.root, 'owned')


if __name__ == '__main__': unittest.main()
