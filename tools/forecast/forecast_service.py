"""Flask route foundation. No listening socket or model startup on import.

The supplied runner must enforce process ownership and a hard computation
deadline. The raw synchronous Prophet engine is intentionally not a default.
"""

import hmac
import json
import re
from threading import BoundedSemaphore

from flask import Flask, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge
from monthly_forecast import ForecastError, forecast

MAX_REQUEST_BYTES = 64 * 1024


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
    capacity = BoundedSemaphore(1)

    @app.after_request
    def private_response(response):
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    @app.errorhandler(RequestEntityTooLarge)
    def too_large(error):
        return jsonify({'error': 'TOO_LARGE'}), 413

    @app.post('/v1/forecast')
    def predict():
        if request.remote_addr not in {'127.0.0.1', '::1'} or request.headers.get('Origin'):
            return jsonify({'error': 'FORBIDDEN'}), 403
        auth = request.headers.get('Authorization', '')
        if not auth.isascii() or not hmac.compare_digest(auth, 'Bearer ' + token):
            return jsonify({'error': 'UNAUTHORIZED'}), 401
        if request.mimetype != 'application/json' or request.headers.get('Content-Encoding'):
            return jsonify({'error': 'BAD_REQUEST'}), 400
        if not capacity.acquire(blocking=False):
            return jsonify({'error': 'BUSY'}), 429
        try:
            raw = request.get_data(cache=False)
            if len(raw) > MAX_REQUEST_BYTES:
                return jsonify({'error': 'TOO_LARGE'}), 413
            try:
                payload = json.loads(raw.decode('utf-8'), object_pairs_hook=_no_duplicates, parse_constant=_invalid_constant)
                result = forecast(payload, runner)
            except ForecastError as error:
                status = 503 if error.code in {'MODEL_FAILED', 'INVALID_MODEL_RESPONSE'} else 400
                return jsonify({'error': error.code}), status
            except (ValueError, TypeError, UnicodeError, RecursionError):
                return jsonify({'error': 'BAD_REQUEST'}), 400
            return jsonify(result)
        finally:
            capacity.release()

    return app
