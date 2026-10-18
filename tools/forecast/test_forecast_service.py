import json
import threading
import unittest
from forecast_service import MAX_REQUEST_BYTES, create_app
from test_monthly_forecast import request, fake_engine

TOKEN = 'fictional_token_for_offline_tests_123456'


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        def runner(history, targets):
            self.calls.append((history, targets))
            return fake_engine(history, targets)
        self.app = create_app(TOKEN, runner)
        self.client = self.app.test_client()

    def post(self, **options):
        options.setdefault('headers', {'Authorization': 'Bearer ' + TOKEN})
        options.setdefault('json', request())
        return self.client.post('/v1/forecast', **options)

    def test_explicit_authenticated_request_and_private_response(self):
        self.assertEqual(self.calls, [])
        result = self.post()
        self.assertEqual(result.status_code, 200)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(result.headers['Cache-Control'], 'no-store')
        self.assertEqual(len(result.get_json()['forecast']), 6)

    def test_missing_wrong_and_nonascii_credentials_never_run_model(self):
        for headers in [{}, {'Authorization': 'Bearer wrong'}, {'Authorization': 'Bearer café'}]:
            self.assertEqual(self.post(headers=headers).status_code, 401)
        self.assertEqual(self.calls, [])

    def test_browser_origin_or_nonloopback_refused(self):
        result = self.post(headers={'Authorization': 'Bearer ' + TOKEN, 'Origin': 'https://example.com'})
        self.assertEqual(result.status_code, 403)
        self.assertEqual(self.post(environ_overrides={'REMOTE_ADDR': '192.0.2.1'}).status_code, 403)
        self.assertEqual(self.calls, [])

    def test_size_and_encoding_refused(self):
        for raw, content_type, extra, status in [
            ('x' * (MAX_REQUEST_BYTES + 1), 'application/json', {}, 413),
            ('{}', 'text/plain', {}, 400),
            ('{}', 'application/json', {'Content-Encoding': 'gzip'}, 400),
        ]:
            result = self.client.post('/v1/forecast', data=raw, content_type=content_type, headers={'Authorization': 'Bearer ' + TOKEN, **extra})
            self.assertEqual(result.status_code, status)
        self.assertEqual(self.calls, [])

    def test_invalid_json_duplicate_keys_and_nonfinite_are_rejected(self):
        for raw in ['{', '{"version":1,"version":2}', '{"x":NaN}', b'\xff', 'null']:
            result = self.client.post('/v1/forecast', data=raw, content_type='application/json', headers={'Authorization': 'Bearer ' + TOKEN})
            self.assertEqual(result.status_code, 400)
        self.assertEqual(self.calls, [])

    def test_invalid_request_and_provider_failure_release_capacity(self):
        data = request()
        data['currency'] = []
        self.assertEqual(self.post(json=data).status_code, 400)
        self.assertEqual(self.post().status_code, 200)
        def failed(history, targets):
            raise RuntimeError('private model output')
        app = create_app(TOKEN, failed)
        for _ in range(2):
            result = app.test_client().post('/v1/forecast', json=request(), headers={'Authorization': 'Bearer ' + TOKEN})
            self.assertEqual(result.status_code, 503)
            self.assertEqual(result.get_json(), {'error': 'MODEL_FAILED'})

    def test_second_request_is_busy_while_owned_request_runs(self):
        entered, release = threading.Event(), threading.Event()
        def held(history, targets):
            entered.set()
            if not release.wait(2):
                raise RuntimeError('test failed to release')
            return fake_engine(history, targets)
        app = create_app(TOKEN, held)
        results = []
        def first():
            results.append(app.test_client().post('/v1/forecast', json=request(), headers={'Authorization': 'Bearer ' + TOKEN}).status_code)
        worker = threading.Thread(target=first)
        worker.start()
        try:
            self.assertTrue(entered.wait(1))
            result = app.test_client().post('/v1/forecast', json=request(), headers={'Authorization': 'Bearer ' + TOKEN})
            self.assertEqual(result.status_code, 429)
        finally:
            release.set()
            worker.join(3)
        self.assertEqual(results, [200])


if __name__ == '__main__':
    unittest.main()
