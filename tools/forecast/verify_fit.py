"""Optional synthetic real-model evaluation; no server, cloud or app-store access."""
import argparse
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import time
import uuid

from forecast_service import create_app
from monthly_forecast import VERSION, forecast, month_label, month_number, validate_request
from windows_runner import APP_ROOT, WindowsProphetRunner

HERE = Path(__file__).resolve().parent
TOTAL_SECONDS = 180
SOURCE_FILES = [
    'tools/forecast/verify_fit.py', 'tools/forecast/monthly_forecast.py',
    'tools/forecast/forecast_service.py', 'tools/forecast/windows_runner.py',
    'tools/forecast/prophet_worker.py', 'tools/forecast/requirements-windows-py312.lock',
    'scripts/companion/owned_process.py', 'src/core/forecast.js',
    'src/core/model.js', 'src/core/reports.js',
]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, allow_nan=False, separators=(',', ':'))


class EvaluationBudget:
    def __init__(self, seconds=TOTAL_SECONDS, clock=time.monotonic):
        self.clock = clock
        self.started = clock()
        self.seconds = seconds

    def remaining(self):
        elapsed = self.clock() - self.started
        require(0 <= elapsed < self.seconds, 'The synthetic evaluation deadline was reached.')
        return self.seconds - elapsed

    def fit_timeout(self):
        # Reserve time for the existing runner's bounded cleanup confirmation.
        remaining = self.remaining()
        require(remaining > 26, 'Insufficient evaluation time remains for another owned fit.')
        return min(30, remaining - 25)


def synthetic_request(case='increasing-months'):
    require(case in {'increasing-months', 'constant-months', 'whole-yen'}, 'Unknown synthetic case.')
    first = month_number('2025-04')
    amounts = [10000 + index * 1000 for index in range(18)]
    if case == 'constant-months':
        amounts = [10000] * 18
    elif case == 'whole-yen':
        amounts = [100 + index * 10 for index in range(18)]
    return validate_request({
        'version': VERSION, 'requestId': 'synthetic_monthly_' + case.replace('-', '_'),
        'currency': 'JPY' if case == 'whole-yen' else 'MYR', 'asOfDate': '2026-10-18',
        'history': [{'month': month_label(first + index), 'expenseMinor': amount} for index, amount in enumerate(amounts)],
        'targetMonths': [month_label(month_number('2026-10') + offset) for offset in range(1, 7)],
    })


def fold_request(history, count):
    require(type(count) is int and 8 <= count <= len(history) - 2, 'Invalid common training prefix.')
    gap = month_number(history[count]['month'])
    return validate_request({
        'version': VERSION, 'requestId': f'synthetic_common_fold_{count:02}',
        'currency': 'MYR', 'asOfDate': month_label(gap) + '-18',
        'history': deepcopy(history[:count]),
        'targetMonths': [month_label(gap + offset) for offset in range(1, 7)],
    })


def check_fold(row, history):
    count = row.get('trainingMonths')
    value = fold_request(history, count)
    expected = {
        'trainingThroughMonth': history[count - 1]['month'],
        'excludedGapMonth': history[count]['month'],
        'targetMonth': history[count + 1]['month'], 'lead': 2,
        'actualMinor': history[count + 1]['expenseMinor'],
    }
    require(all(row.get(key) == item for key, item in expected.items()), 'Baseline fold dates, lead or held-out value disagree.')
    require(value['targetMonths'][0] == expected['targetMonth'], 'Prophet and baseline targets differ.')
    return value


def hashes():
    return {name: hashlib.sha256((APP_ROOT / name).read_bytes()).hexdigest() for name in SOURCE_FILES}


def locked_versions():
    versions = {}
    for line in (HERE / 'requirements-windows-py312.lock').read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        name, rest = line.split('==', 1)
        pinned = rest.split()[0]
        actual = importlib.metadata.version(name)
        require(actual == pinned, 'Installed forecast dependencies do not match the lock.')
        versions[name] = actual
    return versions


def node_baseline(node_argument, history, budget):
    found = node_argument or shutil.which('node')
    require(bool(found), 'Install the repository Node version or supply --node with its executable path.')
    node = Path(found).resolve(strict=True)
    require(node.is_file() and node.name.lower() == 'node.exe', 'Supply the installed Windows node.exe executable.')
    system = os.environ.get('SystemRoot') or os.environ.get('SYSTEMROOT')
    require(bool(system) and Path(system).is_dir(), 'Windows system directory is unavailable.')
    environment = {'SystemRoot': system, 'WINDIR': system, 'PATH': str(node.parent) + os.pathsep + str(Path(system) / 'System32')}

    def run(arguments, data=None):
        result = subprocess.run([str(node), *arguments], input=data, encoding='utf-8', capture_output=True,
            cwd=APP_ROOT, env=environment, timeout=min(10, budget.remaining()),
            creationflags=subprocess.CREATE_NO_WINDOW)
        budget.remaining()
        require(result.returncode == 0 and len(result.stdout) <= 1024 * 1024, 'The local baseline process did not return a bounded successful result.')
        return result.stdout

    version = run(['--version']).strip()
    pinned = (APP_ROOT / '.node-version').read_text(encoding='utf-8').strip().removeprefix('v')
    require(re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', version) is not None and version == 'v' + pinned, 'Node does not match the repository .node-version.')
    script = "const f=require('./src/core/forecast');let t='';process.stdin.on('data',c=>t+=c);process.stdin.on('end',()=>{const h=JSON.parse(t),before=JSON.stringify(h);const result=f.backtestExpenseHistory(h);process.stdout.write(JSON.stringify({result,unchanged:before===JSON.stringify(h)}));});"
    output = json.loads(run(['-e', script], canonical(history)))
    require(output.get('unchanged') is True, 'The baseline changed its input history.')
    result = output['result']
    require(result.get('lead') == 2 and {item['method'] for item in result['candidates']} == {'last-value', 'mean-three', 'damped-trend'}, 'Unexpected local baseline methods or lead.')
    return version, result


def evaluate(node_argument=None):
    require(os.name == 'nt', 'This owned-process evaluation requires Windows.')
    require(sys.version_info[:2] == (3, 12) and struct.calcsize('P') == 8, 'Use the locked Windows x86-64 Python 3.12 environment.')
    budget = EvaluationBudget()
    original_hashes = hashes()
    versions = locked_versions()
    data = synthetic_request()
    before = canonical(data)
    node_version, baseline = node_baseline(node_argument, data['history'], budget)
    parent = (APP_ROOT / '.runtime' / 'forecast-evaluation').resolve()
    parent.relative_to(APP_ROOT.resolve())
    directory = parent / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8])
    directory.mkdir(parents=True, exist_ok=False)
    bootstrap = directory / 'evaluation_worker.py'
    bootstrap_source = 'import sys,runpy\nsys.dont_write_bytecode=True\nrunpy.run_path(' + repr(str(HERE / 'prophet_worker.py')) + ',run_name="__main__")\n'
    bootstrap.write_text(bootstrap_source, encoding='utf-8')
    checks = []

    def engine(history, targets):
        unchanged = canonical({'history': history, 'targets': targets})
        runner = WindowsProphetRunner(sys.executable, directory / 'workers', timeout_seconds=budget.fit_timeout(), worker=bootstrap)
        result = runner(history, targets)
        budget.remaining()
        require(unchanged == canonical({'history': history, 'targets': targets}), 'Owned model changed its input.')
        require(runner.last_run['assignedBeforeResume'] and runner.last_run['stoppedConfirmed'], 'Owned model cleanup was not confirmed.')
        checks.append({'assignedBeforeResume': True, 'stoppedConfirmed': True, 'outputBytes': runner.last_run['outputBytes']})
        return result

    cases = []
    for label in ['increasing-months', 'constant-months', 'whole-yen']:
        value = synthetic_request(label)
        saved = canonical(value)
        result = forecast(value, engine)
        require(canonical(value) == saved, 'Forecast changed the synthetic request.')
        require([row['month'] for row in result['forecast']] == value['targetMonths'] and [row['lead'] for row in result['forecast']] == [2, 3, 4, 5, 6, 7], 'Forecast targets or leads disagree.')
        require(result['currency'] == value['currency'], 'Forecast currency changed.')
        if label == 'constant-months':
            require([row['predictedMinor'] for row in result['forecast']] == [10000] * 6, 'Constant synthetic history did not remain constant.')
        cases.append({'case': label, 'result': result})
    token = 'synthetic_local_evaluation_token_20261018'
    app = create_app(token, engine)
    with app.test_client() as client:
        response = client.post('/v1/forecast', json=data, headers={'Authorization': 'Bearer ' + token})
        require(response.status_code == 200 and response.get_json() == cases[0]['result'], 'Flask test client and repeated owned fit disagree.')

    common = [row for row in baseline['candidates'][0]['folds'] if row['trainingMonths'] >= 8]
    require([row['trainingMonths'] for row in common] == list(range(8, 17)), 'Expected nine common folds for the invented 18-month history.')
    folds = []
    for row in common:
        value = check_fold(row, data['history'])
        predicted = forecast(value, engine)['forecast'][0]['predictedMinor']
        folds.append({key: row[key] for key in ['trainingMonths', 'trainingThroughMonth', 'excludedGapMonth', 'targetMonth', 'lead', 'actualMinor']} | {'predictedMinor': predicted, 'absoluteErrorMinor': abs(predicted - row['actualMinor'])})
    comparison = [{'method': 'prophet', 'foldCount': 9, 'maeMinor': sum(row['absoluteErrorMinor'] for row in folds) / 9}]
    for candidate in baseline['candidates']:
        rows = [row for row in candidate['folds'] if row['trainingMonths'] >= 8]
        require([row['trainingMonths'] for row in rows] == list(range(8, 17)), 'Baseline common fold prefixes differ.')
        for row in rows:
            check_fold(row, data['history'])
        comparison.append({'method': candidate['method'], 'foldCount': 9, 'maeMinor': sum(row['absoluteErrorMinor'] for row in rows) / 9})
    require(canonical(data) == before and hashes() == original_hashes, 'Evaluation input or source files changed during execution.')
    budget.remaining()
    result = {
        'syntheticOnly': True, 'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'pythonVersion': sys.version.split()[0], 'nodeVersion': node_version,
        'installedPackageVersions': versions, 'sourceHashes': original_hashes,
        'evaluationWorkerSha256': hashlib.sha256(bootstrap_source.encode()).hexdigest(),
        'cases': cases, 'flaskTestClientWithOwnedModel': True, 'repeatIdentical': True,
        'unchangedInput': True, 'noListeningServer': True, 'noNetworkRequest': True,
        'commonFoldCount': 9, 'comparison': comparison, 'prophetFolds': folds,
        'baseline': baseline, 'ownedRuns': checks,
        'seconds': round(time.monotonic() - budget.started, 3),
        'limitations': ['Invented trend, constant and JPY cases only; no general accuracy claim.', 'No Android, companion pairing or listening service integration.', 'MAE uses identical prefixes, target dates and two-month lead; only prefixes of eight or more months are compared.', 'Computation is bounded; confirming owned cleanup may take additional time.'],
    }
    (directory / 'evidence.json').write_text(json.dumps(result, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    summary = {'syntheticCasesPassed': 3, 'flaskTestClientPassed': True, 'commonFolds': 9, 'ownedFits': len(checks), 'allOwnedProcessesStopped': all(row['stoppedConfirmed'] for row in checks), 'comparison': comparison, 'seconds': result['seconds'], 'evidence': (directory / 'evidence.json').relative_to(APP_ROOT).as_posix()}
    (directory / 'summary.json').write_text(json.dumps(summary, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', help='Explicit installed node.exe path; otherwise use Node on PATH.')
    options = parser.parse_args(argv)
    try:
        result = evaluate(options.node)
    except Exception:
        print('Synthetic evaluation did not complete successfully; check the locked environment and available runtime.', file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, allow_nan=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
