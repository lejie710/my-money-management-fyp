"""Private integration foundation: bounded monthly Prophet request/response.

No service starts and no model loads on import. The future companion must run
the model in an owned, time-bounded subprocess before accepting remote work.
"""

from copy import deepcopy
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
import math
import re

VERSION = 'recorded-expense-prophet-v1'
CURRENCIES = {'MYR', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CNY'}
MAX_EXPENSE_MINOR = 999999999 * 10000
MAX_HISTORY_MONTHS = 120
MIN_HISTORY_MONTHS = 8
MIN_ACTIVE_MONTHS = 3
MODEL_SETTINGS = {
    'growth': 'linear',
    'yearly_seasonality': False,
    'weekly_seasonality': False,
    'daily_seasonality': False,
    'uncertainty_samples': 0,
    'mcmc_samples': 0,
    'n_changepoints': 25,
    'changepoint_prior_scale': 0.05,
}


class ForecastError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def exact_keys(value, expected):
    return isinstance(value, dict) and set(value) == set(expected)


def month_number(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}', value):
        raise ForecastError('BAD_REQUEST')
    year, month = map(int, value.split('-'))
    if not 1900 <= year <= 2100 or not 1 <= month <= 12:
        raise ForecastError('BAD_REQUEST')
    return year * 12 + month - 1


def month_label(value):
    year, index = divmod(value, 12)
    if not 1900 <= year <= 2100:
        raise ForecastError('BAD_REQUEST')
    return f'{year:04}-{index + 1:02}'


def validate_request(value):
    if not exact_keys(value, {'version', 'requestId', 'currency', 'asOfDate', 'history', 'targetMonths'}):
        raise ForecastError('BAD_REQUEST')
    if value['version'] != VERSION or not isinstance(value['currency'], str) or value['currency'] not in CURRENCIES:
        raise ForecastError('BAD_REQUEST')
    if not isinstance(value['requestId'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,96}', value['requestId']):
        raise ForecastError('BAD_REQUEST')
    as_of = value['asOfDate']
    if not isinstance(as_of, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', as_of):
        raise ForecastError('BAD_REQUEST')
    try:
        parsed = date.fromisoformat(as_of)
    except ValueError:
        raise ForecastError('BAD_REQUEST') from None
    if not 1900 <= parsed.year <= 2100:
        raise ForecastError('BAD_REQUEST')
    as_of_month = month_number(as_of[:7])
    history = value['history']
    if not isinstance(history, list) or not MIN_HISTORY_MONTHS <= len(history) <= MAX_HISTORY_MONTHS:
        raise ForecastError('INSUFFICIENT_OR_EXCESS_HISTORY')
    previous = None
    active = 0
    for row in history:
        if not exact_keys(row, {'month', 'expenseMinor'}):
            raise ForecastError('BAD_REQUEST')
        current = month_number(row['month'])
        amount = row['expenseMinor']
        if type(amount) is not int or not 0 <= amount <= MAX_EXPENSE_MINOR:
            raise ForecastError('BAD_REQUEST')
        if previous is not None and current != previous + 1:
            raise ForecastError('BAD_REQUEST')
        previous = current
        active += int(amount > 0)
    if previous != as_of_month - 1:
        raise ForecastError('BAD_REQUEST')
    if history[0]['expenseMinor'] == 0:
        raise ForecastError('BAD_REQUEST')
    if active < MIN_ACTIVE_MONTHS:
        raise ForecastError('INSUFFICIENT_ACTIVE_HISTORY')
    expected_targets = [month_label(as_of_month + offset) for offset in range(1, 7)]
    if value['targetMonths'] != expected_targets:
        raise ForecastError('BAD_REQUEST')
    return deepcopy(value)


def run_prophet(history, target_months):
    """Fit only supplied history and predict exactly six month-start targets."""
    import pandas as pd
    from prophet import Prophet
    training = pd.DataFrame({
        'ds': [row['month'] + '-01' for row in history],
        'y': [float(row['expenseMinor']) for row in history],
    })
    targets = pd.DataFrame({'ds': [month + '-01' for month in target_months]})
    model = Prophet(**MODEL_SETTINGS)
    model.fit(training, seed=7)
    predictions = model.predict(targets)
    return [
        {'month': row.ds.strftime('%Y-%m'), 'estimateMinor': float(row.yhat)}
        for row in predictions.itertuples()
    ]


def forecast(value, engine=run_prophet):
    request = validate_request(value)
    try:
        result = engine(deepcopy(request['history']), list(request['targetMonths']))
    except Exception:
        raise ForecastError('MODEL_FAILED') from None
    if not isinstance(result, list) or len(result) != 6:
        raise ForecastError('INVALID_MODEL_RESPONSE')
    output = []
    for offset, row in enumerate(result):
        if not exact_keys(row, {'month', 'estimateMinor'}) or row['month'] != request['targetMonths'][offset]:
            raise ForecastError('INVALID_MODEL_RESPONSE')
        estimate = row['estimateMinor']
        if type(estimate) not in (float, int) or abs(estimate) > MAX_EXPENSE_MINOR or not math.isfinite(estimate):
            raise ForecastError('INVALID_MODEL_RESPONSE')
        rounded = int(Decimal(str(estimate)).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
        output.append({'month': row['month'], 'lead': offset + 2, 'predictedMinor': rounded})
    return {
        'version': VERSION,
        'requestId': request['requestId'],
        'provider': 'prophet',
        'currency': request['currency'],
        'asOfDate': request['asOfDate'],
        'trainingThroughMonth': request['history'][-1]['month'],
        'trainingMonths': len(request['history']),
        'predictionUnit': 'currency-minor-unit',
        'rounding': 'half-away-from-zero',
        'negativePredictionPolicy': 'preserve-and-label',
        'hasNegativePredictions': any(row['predictedMinor'] < 0 for row in output),
        'intervals': None,
        'settings': deepcopy(MODEL_SETTINGS),
        'forecast': output,
    }
