"""Explicit private provider selection. Importing this module performs no IO."""
import json
from pathlib import Path
import re

APP_ROOT = Path(__file__).resolve().parents[2]
MAX_CONFIG_BYTES = 8192
LOCAL_MODEL_ID = 'Qwen3-4B-Instruct-2507-GGUF'


def fail():
    raise RuntimeError('Provider configuration is invalid. Check the private configuration and setup guide.')


def exact(value, names):
    return isinstance(value, dict) and set(value) == set(names)


def credential(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,512}', value):
        fail()
    return value


def validate_provider_config(value):
    if not exact(value, {'version', 'ocr', 'assistant', 'forecast'}) or type(value['version']) is not int or value['version'] != 1:
        fail()
    providers = {'ocr': None, 'assistant': None, 'forecast': None}
    secrets = {'visionKey': None, 'openaiKey': None}
    python = None
    ocr, assistant, forecast = value['ocr'], value['assistant'], value['forecast']
    if ocr is not None:
        if exact(ocr, {'engine'}) and ocr['engine'] == 'windows-media-ocr':
            providers['ocr'] = {'engine': 'windows-media-ocr', 'processing': 'local', 'maxImageBytes': 10485760}
        elif exact(ocr, {'engine', 'apiKey'}) and ocr['engine'] == 'google-cloud-vision':
            secrets['visionKey'] = credential(ocr['apiKey'])
            providers['ocr'] = {'engine': 'google-cloud-vision', 'processing': 'cloud', 'maxImageBytes': 6291456}
        else:
            fail()
    if assistant is not None:
        if exact(assistant, {'engine'}) and assistant['engine'] == 'lemonade':
            providers['assistant'] = {'engine': 'lemonade', 'processing': 'local', 'model': LOCAL_MODEL_ID}
        elif exact(assistant, {'engine', 'model', 'apiKey'}) and assistant['engine'] == 'openai':
            if not isinstance(assistant['model'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}', assistant['model']):
                fail()
            secrets['openaiKey'] = credential(assistant['apiKey'])
            providers['assistant'] = {'engine': 'openai', 'processing': 'cloud', 'model': assistant['model']}
        else:
            fail()
    if forecast is not None:
        if not exact(forecast, {'engine', 'python'}) or forecast['engine'] != 'prophet' or not isinstance(forecast['python'], str) or not forecast['python'] or len(forecast['python']) > 1024 or any(ord(c) < 32 for c in forecast['python']):
            fail()
        python = forecast['python']
        providers['forecast'] = {'engine': 'prophet', 'processing': 'local', 'version': 'recorded-expense-prophet-v1', 'maxHistoryMonths': 120}
    if all(item is None for item in providers.values()):
        fail()
    return {'providers': providers, 'secrets': secrets, 'forecastPython': python}


def legacy_selection(mode='ocr'):
    if mode not in ('ocr', 'assistant'):
        fail()
    return validate_provider_config({'version': 1, 'ocr': {'engine': 'windows-media-ocr'}, 'assistant': {'engine': 'lemonade'} if mode == 'assistant' else None, 'forecast': None})


def load_private_config(file, app_root=APP_ROOT):
    try:
        path = Path(file).resolve(strict=True)
        allowed = (Path(app_root) / '.runtime').resolve()
        path.relative_to(allowed)
        if path == allowed or not path.is_file() or not 1 <= path.stat().st_size <= MAX_CONFIG_BYTES:
            fail()
        raw = path.read_bytes()
        if not 1 <= len(raw) <= MAX_CONFIG_BYTES:
            fail()
        def pairs(rows):
            result = {}
            for key, value in rows:
                if key in result:
                    fail()
                result[key] = value
            return result
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs)
        return validate_provider_config(value)
    except (OSError, ValueError, TypeError, UnicodeError):
        fail()


def has_local_model(selection):
    return (selection['providers']['assistant'] or {}).get('engine') == 'lemonade'


def select_for_arguments(args):
    file = getattr(args, 'provider_config', None)
    if file:
        return load_private_config(file)
    return legacy_selection(getattr(args, 'mode', None) or 'ocr')

def companion_environment(source):
    # Windows environment names are case-insensitive; os.environ normally
    # exposes SYSTEMROOT even when the parent used SystemRoot.
    allowed = {'SYSTEMROOT','WINDIR','PATH','TEMP','TMP','APPDATA','LOCALAPPDATA','USERPROFILE','HOME','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR'}
    result = {name: value for name, value in source.items() if name.upper() in allowed}
    if not any(name.upper() == 'SYSTEMROOT' for name in result):
        raise RuntimeError('Windows system directory is unavailable.')
    return result
