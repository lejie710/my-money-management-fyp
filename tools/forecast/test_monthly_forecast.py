from copy import deepcopy
import json
import unittest

from monthly_forecast import ForecastError, MAX_EXPENSE_MINOR, VERSION, forecast, month_label, month_number, validate_request


def request():
    start = month_number('2025-04')
    return {
        'version': VERSION,
        'requestId': 'monthly_reference_20261018',
        'currency': 'MYR',
        'asOfDate': '2026-10-18',
        'history': [{'month': month_label(start + i), 'expenseMinor': 10000 + i * 1000} for i in range(18)],
        'targetMonths': ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04'],
    }


def fake_engine(history, targets):
    return [{'month': month, 'estimateMinor': 28000.5 + i} for i, month in enumerate(targets)]


class MonthlyTests(unittest.TestCase):
    def assert_error(self, value, code='BAD_REQUEST', engine=fake_engine):
        with self.assertRaises(ForecastError) as error:
            forecast(value, engine)
        self.assertEqual(error.exception.code, code)

    def test_exact_month_targets_leads_and_input_preserved(self):
        data = request()
        before = json.dumps(data, sort_keys=True)
        seen = []
        def engine(history, targets):
            seen.append((deepcopy(history), targets[:]))
            history[0]['expenseMinor'] = 1
            return fake_engine(history, targets)
        result = forecast(data, engine)
        self.assertEqual(json.dumps(data, sort_keys=True), before)
        self.assertEqual(seen[0][0][-1]['month'], '2026-09')
        self.assertEqual(seen[0][1], data['targetMonths'])
        self.assertEqual([row['lead'] for row in result['forecast']], [2, 3, 4, 5, 6, 7])
        self.assertEqual(result['forecast'][0]['predictedMinor'], 28001)
        self.assertIsNone(result['intervals'])

    def test_missing_unknown_and_untrusted_fields(self):
        for field in request():
            data = request()
            del data[field]
            self.assert_error(data)
        data = request()
        data['transactions'] = []
        self.assert_error(data)

    def test_date_currency_and_request_identity(self):
        for field, value in [('asOfDate', '2026-02-30'), ('asOfDate', '2026-1-01'), ('asOfDate', '2101-01-01'), ('currency', 'BTC'), ('currency', []), ('requestId', '../bad'), ('version', 1)]:
            with self.subTest(field=field, value=value):
                data = request()
                data[field] = value
                self.assert_error(data)

    def test_boolean_fraction_nonfinite_negative_and_excessive_amount(self):
        for amount in [True, 1.2, float('inf'), float('nan'), -1, MAX_EXPENSE_MINOR + 1, '100']:
            data = request()
            data['history'][0]['expenseMinor'] = amount
            self.assert_error(data)

    def test_duplicates_gaps_order_and_partial_month_are_rejected(self):
        for index, month in [(1, '2025-04'), (1, '2025-06'), (0, '2025-05'), (-1, '2026-10'), (-1, '2026-08')]:
            data = request()
            data['history'][index]['month'] = month
            self.assert_error(data)

    def test_short_inactive_and_oversized_history(self):
        for count in [0, 7, 121]:
            data = request()
            data['history'] = data['history'][:count] if count < 18 else data['history'] * 7
            self.assert_error(data, 'INSUFFICIENT_OR_EXCESS_HISTORY')
        data = request()
        for row in data['history'][2:]:
            row['expenseMinor'] = 0
        self.assert_error(data, 'INSUFFICIENT_ACTIVE_HISTORY')

    def test_target_count_order_gap_history_and_partial_are_rejected(self):
        for targets in [[], ['2026-10'] + request()['targetMonths'][:5], request()['targetMonths'][::-1], request()['targetMonths'][:5]]:
            data = request()
            data['targetMonths'] = targets
            self.assert_error(data)

    def test_zero_months_preserved_when_activity_threshold_is_met(self):
        data = request()
        for row in data['history'][3:]:
            row['expenseMinor'] = 0
        validated = validate_request(data)
        self.assertEqual(validated['history'][-1]['expenseMinor'], 0)

    def test_unicode_month_digits_and_artificial_leading_months_are_rejected(self):
        data = request()
        data['history'][0]['month'] = '٢٠٢٥-٠٤'
        self.assert_error(data)
        data = request()
        data['history'][0]['expenseMinor'] = 0
        self.assert_error(data)

    def test_year_boundary_and_leap_date(self):
        data = request()
        data['asOfDate'] = '2024-02-29'
        start = month_number('2022-08')
        data['history'] = [{'month': month_label(start + i), 'expenseMinor': 100} for i in range(18)]
        data['targetMonths'] = ['2024-03', '2024-04', '2024-05', '2024-06', '2024-07', '2024-08']
        self.assertEqual(forecast(data, fake_engine)['trainingThroughMonth'], '2024-01')

    def test_jpy_keeps_minor_units_and_negative_predictions_are_not_clamped(self):
        data = request()
        data['currency'] = 'JPY'
        result = forecast(data, lambda history, targets: [{'month': m, 'estimateMinor': -12.5} for m in targets])
        self.assertEqual(result['forecast'][0]['predictedMinor'], -13)
        self.assertTrue(result['hasNegativePredictions'])
        self.assertEqual(result['currency'], 'JPY')

    def test_invalid_model_output(self):
        for value in [float('inf'), float('nan'), True, '100', MAX_EXPENSE_MINOR + 1]:
            self.assert_error(request(), 'INVALID_MODEL_RESPONSE', lambda h, t: [{'month': m, 'estimateMinor': value} for m in t])
        self.assert_error(request(), 'INVALID_MODEL_RESPONSE', lambda h, t: [])
        self.assert_error(request(), 'INVALID_MODEL_RESPONSE', lambda h, t: list(reversed(fake_engine(h, t))))

    def test_provider_error_is_sanitized(self):
        def failed(h, t):
            raise RuntimeError('private input and internal location')
        with self.assertRaises(ForecastError) as error:
            forecast(request(), failed)
        self.assertEqual(str(error.exception), 'MODEL_FAILED')
        self.assertIsNone(error.exception.__cause__)


if __name__ == '__main__':
    unittest.main()
