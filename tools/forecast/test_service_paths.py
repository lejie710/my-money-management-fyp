"""Regression for CmdStan filenames beneath a long owned-service directory."""
from pathlib import Path
import unittest
from unittest.mock import patch
import service_main


class ServicePathTests(unittest.TestCase):
    def test_deep_run_names_do_not_lengthen_model_output_paths(self):
        service = service_main.APP_ROOT / '.runtime' / ('root-' + 'a' * 55) / 'runs' / ('run-' + 'b' * 50) / 'forecast-service'
        target = service_main.fit_runtime_root(service)
        self.assertEqual(target.parent, (service_main.APP_ROOT / '.runtime' / 'forecast-fits').resolve())
        self.assertLessEqual(len(str(target).encode('utf-16-le')) // 2, 120)
        output = target / ('run-' + 'c' * 32) / 'tmp' / 'tmp12345678' / 'prophet_model12345678' / 'prophet_model-20261018194113_0-stdout.txt'
        self.assertLess(len(str(output).encode('utf-16-le')) // 2, 260)

    def test_owner_namespace_is_stable_and_distinct_without_creating_files(self):
        service = service_main.APP_ROOT / '.runtime' / 'path-test-owner' / 'forecast-service'
        target = service_main.fit_runtime_root(service)
        self.assertEqual(target, service_main.fit_runtime_root(service / 'unused' / '..'))
        self.assertNotEqual(target, service_main.fit_runtime_root(service.with_name('other-service')))
        self.assertRegex(target.name, r'^[a-f0-9]{20}$')
        self.assertFalse(target.exists())

    def test_foreign_or_bare_runtime_directory_is_rejected(self):
        for directory in [service_main.APP_ROOT.parent / 'foreign-service', service_main.APP_ROOT / '.runtime']:
            with self.subTest(directory=directory):
                with self.assertRaises(ValueError):
                    service_main.fit_runtime_root(directory)

    def test_an_overlong_checkout_is_rejected_before_worker_start(self):
        long_root = service_main.APP_ROOT / ('checkout-' + 'x' * 121)
        with patch.object(service_main, 'APP_ROOT', long_root):
            with self.assertRaisesRegex(ValueError, 'shorter project checkout'):
                service_main.fit_runtime_root(long_root / '.runtime' / 'owned-service')


if __name__ == '__main__':
    unittest.main()
