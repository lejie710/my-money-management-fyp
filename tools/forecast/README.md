# Monthly Prophet forecasting foundation

This standalone Python foundation preserves the project's Flask/Prophet approach with explicit monthly inputs and bounded Windows model execution. It is **not connected to the Android forecast panel or paired companion**. Importing these modules does not start a server or fit a model. No provider key or cloud account is needed.

The application continues to use its existing local recorded-expense baselines. This folder does not select Prophet automatically or establish that it is more accurate for a user's records.

## Windows Python 3.12 setup

Use Windows x86-64 and Python 3.12. The lock records the exact versions and wheel hashes for this platform, including Prophet 1.5.0 and Flask 3.1.3. It is not a cross-platform dependency lock.

From the repository root, the following commands create an isolated environment and download only the locked wheels from PyPI:

```powershell
py -3.12 -m venv .runtime/forecast-venv
& ./.runtime/forecast-venv/Scripts/python.exe -m pip install --require-hashes --only-binary=:all: --index-url https://pypi.org/simple -r tools/forecast/requirements-windows-py312.lock
& ./.runtime/forecast-venv/Scripts/python.exe -m unittest discover -s tools/forecast -p "test_*.py" -v
```

The source and Flask tests use injected model results and Flask's in-process test client. The Windows runner tests create their own hidden synthetic workers under `.runtime/forecast-tests`; they exercise process ownership and cleanup without starting a listening service. Those runner tests require Windows. A successful unit suite does not by itself establish a real Prophet fit, application integration or hosted CI success.

## Optional real-model evaluation

After the locked environment is installed, run this separate synthetic evaluation from the repository root:

```powershell
& ./.runtime/forecast-venv/Scripts/python.exe -B tools/forecast/verify_fit.py
```

Node must match `.node-version`. If it is not on PATH, append `--node "C:/path/to/node.exe"` using the installed executable's actual path. The script checks the Node version and all installed forecast package versions before evaluation. It installs nothing and needs no provider key.

The evaluation fits invented increasing, constant and JPY monthly histories, repeats the increasing case through Flask's in-process test client, and compares Prophet with the actual `src/core/forecast.js` methods. All methods use the same nine training prefixes, excluded gap months, target dates and two-month prediction lead. Prefixes shorter than Prophet's eight-month minimum are excluded from every method's reported comparison. Mean absolute error on this synthetic trend does not establish accuracy for real financial records.

Every model call uses the Windows owned-process runner with a computation deadline of at most 30 seconds. A 180-second evaluation budget reserves 25 seconds for cleanup before starting another fit and refuses work when that allowance cannot be maintained. Confirming owned-process cleanup can take additional time beyond a fit's computation deadline. Node subprocesses also have deadlines. The script checks input immutability, response targets, process cleanup and unchanged source hashes before reporting success.

Each run keeps its temporary workers and human-readable `summary.json` / `evidence.json` under a separate ignored `.runtime/forecast-evaluation` directory. Evidence includes package versions, source hashes, model settings, predictions, common-fold results and cleanup confirmations. No listening server starts, and no Android data is read or written. This evaluation is an optional local command, not an automatically executed import or a hosted CI result.

## Request and response

`monthly_forecast.forecast(payload, engine)` accepts exactly:

- `version`: `recorded-expense-prophet-v1`.
- `requestId`: an opaque 16–96 character identifier using letters, digits, `_` or `-`.
- `currency` and a valid `asOfDate`.
- `history`: 8–120 consecutive `{month, expenseMinor}` rows, with at least three active months, beginning with the first positive expense and ending immediately before the as-of month. Later zero months remain present.
- `targetMonths`: exactly the six calendar months following the as-of month.

The as-of month is excluded from both training and predictions. Targets therefore have leads two through seven relative to the final completed training month. The 120-month limit belongs to this optional provider and must be disclosed rather than silently truncating a longer wallet history. Only selected monthly expense totals belong in this request; raw transactions, titles, photos and account identities are unnecessary.

Recorded amounts use integer currency minor units, including whole yen for JPY. Prophet receives approximate floating-point model inputs. Its six finite, bounded outputs are rounded half away from zero to integer minor units. Negative estimates are preserved and explicitly flagged with `hasNegativePredictions` and `negativePredictionPolicy: preserve-and-label`; a future UI must explain them. Responses include model settings and no prediction intervals.

The model uses linear growth, at most 25 changepoints, prior scale 0.05 and seed 7. Daily, weekly and yearly seasonality, MCMC and uncertainty sampling are disabled. These are explicit initial settings, not tuned parameters or a forecast-quality guarantee. Month-start targets follow [Prophet's monthly-data guidance](https://facebook.github.io/prophet/docs/non-daily_data.html).

## Owned model execution

`WindowsProphetRunner(python, runtime_root, timeout_seconds=30)` is a callable engine for `forecast`. Supply the explicit environment's Python executable and an output directory inside this repository's `.runtime`. The runner loads the existing `scripts/companion/owned_process.py` boundary and starts `prophet_worker.py` only when called.

The worker is created hidden and suspended, assigned to an owned Windows Job before it runs, and given only its stdin, stdout and diagnostic-sink handles. Kill-on-close owns its native descendants. Cleanup uses exact owned handles, not executable names or a saved PID. The child's allowlisted environment contains required Windows/Python paths and owned temporary/cache locations; it does not inherit provider keys or the parent's full environment.

Input and accepted output are each limited to 64 KiB. A monotonic computation deadline covers input delivery and output collection. Timeout stops the owned Job; bounded cleanup confirmation can take additional time beyond the computation deadline. Unconfirmed cleanup blocks later runner calls. Completed temporary directories remain under `.runtime` for inspection; automatic retention cleanup is not implemented.

For direct Python use, add `tools/forecast` to the importing program's module path and pass a `WindowsProphetRunner` instance as `forecast`'s second argument. The raw `run_prophet` function is also available for controlled model evaluation, but it does not enforce process ownership or a hard deadline and must not be used as an unbounded service runner.

## Flask factory and remaining integration

`forecast_service.create_app(token, runner)` returns a Flask application. It requires an explicit private generated token and callable bounded runner; it neither starts a listener nor selects a default runner. Its `POST /v1/forecast` route requires loopback callers without a browser Origin, authenticates before decoding, limits JSON to 64 KiB, rejects duplicate/nonfinite values and allows one outstanding model call. Responses use generic errors and `Cache-Control: no-store`.

There is no service-launch command in this folder. Before enabling application access, implement and verify:

1. An owned loopback service lifecycle, private pairing metadata and authenticated companion routing, without exposing a debug server.
2. Explicit provider selection and monthly-series consent, with the local result retained when an optional request fails.
3. Mobile owner/category/context binding, stale-response rejection, cancellation, restart and owner-switch tests. Model requests must never mutate the financial store.
4. UI disclosure of the history limit, negative estimates and absence of prediction intervals, followed by an Android walkthrough.
5. A fair comparison using identical historical target dates and leads before making accuracy claims.

The optional packages' authoritative sources are [Prophet on PyPI](https://pypi.org/project/prophet/) and [Flask documentation](https://flask.palletsprojects.com/). Setup installs dependencies locally; it does not deploy a cloud service.
