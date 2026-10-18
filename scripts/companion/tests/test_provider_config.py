"""Pure provider selection and bounded local-file tests; no service starts."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from provider_config import validate_provider_config, legacy_selection, has_local_model, load_private_config, select_for_arguments, companion_environment


class ProviderConfiguration(unittest.TestCase):
    def config(self):
        return {'version': 1, 'ocr': {'engine': 'google-cloud-vision', 'apiKey': 'synthetic-vision-key'}, 'assistant': {'engine': 'openai', 'model': 'test-model', 'apiKey': 'synthetic-openai-key'}, 'forecast': {'engine': 'prophet', 'python': 'C:/example/python.exe'}}

    def test_windows_environment_names_keep_systemroot_and_trust_but_exclude_keys(self):
        for spelling in ['SYSTEMROOT', 'SystemRoot', 'systemroot']:
            source={spelling:'C:/Windows','Path':'C:/Tools','NODE_EXTRA_CA_CERTS':'C:/approved.pem','OPENAI_API_KEY':'synthetic-key','NODE_OPTIONS':'unrequested-hook'}
            result=companion_environment(source)
            self.assertEqual(result[spelling],source[spelling])
            self.assertEqual(result['Path'],'C:/Tools')
            self.assertEqual(result['NODE_EXTRA_CA_CERTS'],'C:/approved.pem')
            self.assertNotIn('OPENAI_API_KEY',result)
            self.assertNotIn('NODE_OPTIONS',result)
        with self.assertRaises(RuntimeError):
            companion_environment({'PATH':'C:/Tools'})

    def test_legacy_modes_never_select_cloud_or_forecast(self):
        self.assertFalse(has_local_model(legacy_selection('ocr')))
        self.assertTrue(has_local_model(legacy_selection('assistant')))
        self.assertEqual(legacy_selection('ocr')['secrets'], {'visionKey': None, 'openaiKey': None})
        self.assertIsNone(legacy_selection('assistant')['providers']['forecast'])
        self.assertEqual(select_for_arguments(SimpleNamespace(mode='ocr')), legacy_selection('ocr'))

    def test_public_descriptors_exclude_private_keys_and_paths(self):
        source = self.config()
        before = json.dumps(source)
        value = validate_provider_config(source)
        public = json.dumps(value['providers'])
        self.assertNotIn('synthetic-', public)
        self.assertNotIn('python.exe', public)
        self.assertEqual(value['providers']['ocr']['maxImageBytes'], 6291456)
        self.assertFalse(has_local_model(value))
        self.assertEqual(json.dumps(source), before)

    def test_missing_placeholder_credential_and_unknown_fields_fail(self):
        for key, bad in [('apiKey', ''), ('apiKey', 'bad\nkey-value'), ('model', ''), ('url', 'https://example.com')]:
            value = self.config()
            value['assistant'][key] = bad
            with self.assertRaisesRegex(RuntimeError, 'Provider configuration is invalid'):
                validate_provider_config(value)
        with self.assertRaises(RuntimeError):
            validate_provider_config({'version': 1, 'ocr': None, 'assistant': None, 'forecast': None})
        value = self.config()
        value['forecast']['python'] = ''
        with self.assertRaises(RuntimeError):
            validate_provider_config(value)

    def test_config_must_be_bounded_utf8_inside_ignored_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / '.runtime'
            runtime.mkdir()
            path = runtime / 'providers.json'
            path.write_text(json.dumps(self.config()), encoding='utf-8')
            self.assertEqual(load_private_config(path, root)['providers']['assistant']['engine'], 'openai')
            outside = root / 'outside.json'
            outside.write_text(json.dumps(self.config()), encoding='utf-8')
            with self.assertRaises(RuntimeError):
                load_private_config(outside, root)
            for invalid in ['x' * 8193, '{"version":1,"version":1}', '{', '\ufeff{}']:
                path.write_text(invalid, encoding='utf-8')
                with self.assertRaises(RuntimeError):
                    load_private_config(path, root)


if __name__ == '__main__':
    unittest.main()
