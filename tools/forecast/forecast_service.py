"""Authenticated local forecast routes; importing this module starts nothing."""
import hmac
import json
import re
import threading
import time
from flask import Flask, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge
from monthly_forecast import ForecastError, VERSION, forecast, validate_request

MAX_REQUEST_BYTES = 64 * 1024
REQUEST_ID = re.compile(r'[A-Za-z0-9_-]{16,96}')


def _no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate field')
        result[key] = value
    return result


def _invalid_constant(value):
    raise ValueError('nonfinite JSON')


def create_app(token, runner):
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', token):
        raise ValueError('Supply a private generated service token.')
    if not callable(runner):
        raise ValueError('Supply a time-bounded model runner.')
    app = Flask(__name__)
    app.config.update(MAX_CONTENT_LENGTH=MAX_REQUEST_BYTES, PROPAGATE_EXCEPTIONS=False)
    state = {'active': None, 'closed': False}
    lock = threading.Lock()
    remembered = {}

    def remember(identifier):
        now = time.monotonic()
        for old, until in list(remembered.items()):
            if until <= now:
                del remembered[old]
        if identifier not in remembered and len(remembered) >= 128:
            raise ForecastError('BUSY')
        remembered[identifier] = now + 180

    def authorize():
        if request.remote_addr not in {'127.0.0.1', '::1'} or 'Origin' in request.headers:
            return jsonify({'error': 'FORBIDDEN'}), 403
        auth = request.headers.get('Authorization', '')
        if not auth.isascii() or not hmac.compare_digest(auth, 'Bearer ' + token):
            return jsonify({'error': 'UNAUTHORIZED'}), 401
        return None

    def read_payload(maximum=MAX_REQUEST_BYTES):
        if request.mimetype != 'application/json' or request.headers.get('Content-Encoding'):
            raise ForecastError('BAD_REQUEST')
        raw = request.get_data(cache=False)
        if len(raw) > maximum:
            raise ForecastError('TOO_LARGE')
        return json.loads(raw.decode('utf-8'), object_pairs_hook=_no_duplicates, parse_constant=_invalid_constant)

    def failed(code):
        status = {'TOO_LARGE': 413, 'BUSY': 429, 'TIMEOUT': 504, 'CANCELLED': 499,
                  'MODEL_FAILED': 503, 'UNAVAILABLE': 503, 'CLEANUP_UNCONFIRMED': 503,
                  'INVALID_MODEL_RESPONSE': 502}.get(code, 400)
        return jsonify({'error': code}), status

    @app.after_request
    def private_response(response):
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    @app.errorhandler(RequestEntityTooLarge)
    def too_large(error):
        return failed('TOO_LARGE')

    @app.get('/health')
    def health():
        denied = authorize()
        if denied is not None:
            return denied
        if state['closed'] or getattr(runner, 'blocked', False):
            return failed('UNAVAILABLE')
        return jsonify({'version': 1, 'status': 'ready', 'engine': 'prophet', 'contractVersion': VERSION})

    @app.post('/v1/forecast')
    def predict():
        denied = authorize()
        if denied is not None:
            return denied
        active = None
        try:
            payload = validate_request(read_payload())
            identifier = payload['requestId']
            with lock:
                if state['closed'] or getattr(runner, 'blocked', False):
                    raise ForecastError('UNAVAILABLE')
                if state['active'] is not None:
                    raise ForecastError('BUSY')
                if remembered.get(identifier, 0) > time.monotonic():
                    raise ForecastError('CANCELLED')
                remember(identifier)
                active = {'id': identifier, 'done': threading.Event(), 'cancel': threading.Event(), 'cancelled': False}
                state['active'] = active
            def run_owned(history, targets):
                if active['cancel'].is_set():
                    raise ForecastError('CANCELLED')
                if callable(getattr(runner, 'run', None)):
                    return runner.run(history, targets, cancel_event=active['cancel'])
                return runner(history, targets)
            result = forecast(payload, run_owned)
            with lock:
                if active['cancelled'] or state['closed']:
                    raise ForecastError('CANCELLED')
            return jsonify(result)
        except ForecastError as error:
            return failed(error.code)
        except (ValueError, TypeError, UnicodeError, RecursionError):
            return failed('BAD_REQUEST')
        finally:
            if active is not None:
                with lock:
                    if state['active'] is active:
                        state['active'] = None
                    active['done'].set()

    @app.post('/v1/forecast/cancel')
    def cancel():
        denied = authorize()
        if denied is not None:
            return denied
        try:
            payload = read_payload(512)
            if not isinstance(payload, dict) or set(payload) != {'version', 'requestId'} or type(payload['version']) is not int or payload['version'] != 1 or not isinstance(payload['requestId'], str) or not REQUEST_ID.fullmatch(payload['requestId']):
                raise ForecastError('BAD_REQUEST')
            identifier = payload['requestId']
            with lock:
                remember(identifier)
                active = state['active']
                if active is not None and active['id'] == identifier:
                    active['cancelled'] = True
                    active['cancel'].set()
                    if not callable(getattr(runner, 'cancel', None)):
                        raise ForecastError('UNAVAILABLE')
                    runner.cancel()
                else:
                    active = None
            if active is not None and not active['done'].wait(25):
                raise ForecastError('CLEANUP_UNCONFIRMED')
            if getattr(runner, 'blocked', False):
                raise ForecastError('CLEANUP_UNCONFIRMED')
            return jsonify({'version': 1, 'requestId': identifier, 'cancelled': True, 'stopped': True})
        except ForecastError as error:
            return failed(error.code)
        except (ValueError, TypeError, UnicodeError, RecursionError):
            return failed('BAD_REQUEST')

    def close(timeout_seconds=25):
        with lock:
            state['closed'] = True
            active = state['active']
            if active is not None:
                active['cancelled'] = True
                active['cancel'].set()
                if callable(getattr(runner, 'cancel', None)):
                    runner.cancel()
        if active is not None and not active['done'].wait(timeout_seconds):
            return False
        closer = getattr(runner, 'close', None)
        return bool(closer(timeout_seconds)) if callable(closer) else active is None or active['done'].is_set()

    app.forecast_close = close
    return app
