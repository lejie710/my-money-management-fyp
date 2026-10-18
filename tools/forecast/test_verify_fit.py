from copy import deepcopy
import unittest

from verify_fit import EvaluationBudget, check_fold, fold_request, synthetic_request


class EvaluationContractTests(unittest.TestCase):
    def test_synthetic_inputs_have_explicit_months_currency_and_values(self):
        trend = synthetic_request()
        constant = synthetic_request('constant-months')
        yen = synthetic_request('whole-yen')
        self.assertEqual(len(trend['history']), 18)
        self.assertEqual(trend['history'][-1], {'month': '2026-09', 'expenseMinor': 27000})
        self.assertEqual({row['expenseMinor'] for row in constant['history']}, {10000})
        self.assertEqual(yen['currency'], 'JPY')
        self.assertEqual(yen['history'][-1]['expenseMinor'], 270)
        self.assertEqual(trend['targetMonths'][0], '2026-11')

    def test_fold_excludes_gap_and_held_out_value_without_mutating_history(self):
        history = synthetic_request()['history']
        before = deepcopy(history)
        value = fold_request(history, 8)
        self.assertEqual(value['history'], history[:8])
        self.assertEqual(value['asOfDate'][:7], history[8]['month'])
        self.assertEqual(value['targetMonths'][0], history[9]['month'])
        value['history'][0]['expenseMinor'] = 1
        self.assertEqual(history, before)
        for count in [7, 17, True]:
            with self.assertRaises(RuntimeError):
                fold_request(history, count)

    def test_comparison_rejects_mismatched_target_lead_or_actual_value(self):
        history = synthetic_request()['history']
        row = {'trainingMonths': 8, 'trainingThroughMonth': history[7]['month'],
            'excludedGapMonth': history[8]['month'], 'targetMonth': history[9]['month'],
            'lead': 2, 'actualMinor': history[9]['expenseMinor']}
        self.assertEqual(check_fold(row, history)['history'], history[:8])
        for key, wrong in [('targetMonth', history[8]['month']), ('lead', 1), ('actualMinor', 1)]:
            with self.assertRaises(RuntimeError):
                check_fold({**row, key: wrong}, history)

    def test_total_budget_reduces_fit_timeout_and_reserves_cleanup(self):
        now = [100.0]
        budget = EvaluationBudget(180, lambda: now[0])
        self.assertEqual(budget.fit_timeout(), 30)
        now[0] = 250
        self.assertEqual(budget.fit_timeout(), 5)
        now[0] = 255
        with self.assertRaises(RuntimeError):
            budget.fit_timeout()
        now[0] = 280
        with self.assertRaises(RuntimeError):
            budget.remaining()


if __name__ == '__main__':
    unittest.main()
