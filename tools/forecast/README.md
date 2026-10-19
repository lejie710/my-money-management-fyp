# Optional local Prophet forecasting

This folder contains the shared Flask/Prophet model contract and the optional local Windows execution path. The [deployable backend](../backend/README.md) is the primary route for a phone using the original forecasting service without a nearby Windows computer. The local route documented here uses explicit monthly inputs and bounded Windows model execution. It is connected through the authenticated local companion and the forecast panel's explicit Run local Prophet action. Importing these modules does not start a server or fit a model. No provider key or cloud account is needed.

The application also provides separate device-only recorded-expense baselines. Selecting a configured Prophet route does not start a fit until the user asks, and does not establish that Prophet is more accurate for their records.

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

The as-of month is excluded from both training and predictions. Targets therefore have leads two through seven relative to the final completed training month. The 120-month limit belongs to the Prophet contract and must be disclosed rather than silently truncating a longer wallet history. Only selected monthly expense totals belong in this request; raw transactions, titles, photos and account identities are unnecessary.

Recorded amounts use integer currency minor units, including whole yen for JPY. Prophet receives approximate floating-point model inputs. Its six finite, bounded outputs are rounded half away from zero to integer minor units. Negative estimates are preserved and explicitly flagged with `hasNegativePredictions` and `negativePredictionPolicy: preserve-and-label`; the forecast panel labels them as model output rather than possible recorded expense entries. Responses include model settings and no prediction intervals.

The model uses linear growth, at most 25 changepoints, prior scale 0.05 and seed 7. Daily, weekly and yearly seasonality, MCMC and uncertainty sampling are disabled. These are explicit initial settings, not tuned parameters or a forecast-quality guarantee. Month-start targets follow [Prophet's monthly-data guidance](https://facebook.github.io/prophet/docs/non-daily_data.html).

## Owned model execution

`WindowsProphetRunner(python, runtime_root, timeout_seconds=30)` is a callable engine for `forecast`. Supply the explicit environment's Python executable and an output directory inside this repository's `.runtime`. The runner loads the existing `scripts/companion/owned_process.py` boundary and starts `prophet_worker.py` only when called.

The worker is created hidden and suspended, assigned to an owned Windows Job before it runs, and given only its stdin, stdout and diagnostic-sink handles. Kill-on-close owns its native descendants. Cleanup uses exact owned handles, not executable names or a saved PID. The child's allowlisted environment contains required Windows/Python paths and owned temporary/cache locations; it does not inherit provider keys or the parent's full environment.

Input and accepted output are each limited to 64 KiB. A monotonic computation deadline covers input delivery and output collection. Timeout stops the owned Job; bounded cleanup confirmation can take additional time beyond the computation deadline. Unconfirmed cleanup blocks later runner calls. Completed temporary directories remain under `.runtime` for inspection; automatic retention cleanup is not implemented. The listening service uses a per-service hashed directory under `.runtime/forecast-fits` so long launcher run names do not push CmdStan output filenames past Windows path limits. Its fit-root path is limited to 120 UTF-16 code units, reserving room for worker and model-generated names; use a shorter checkout path if startup rejects that limit.

For direct Python use, add `tools/forecast` to the importing program's module path and pass a `WindowsProphetRunner` instance as `forecast`'s second argument. The raw `run_prophet` function is also available for controlled model evaluation, but it does not enforce process ownership or a hard deadline and must not be used as an unbounded service runner.

## Start through the owned companion

Create `.runtime/providers/prophet.json` with this local-only selection. The interpreter must be the environment where you installed the pinned requirements. Paths in this example are relative to the repository root, where the launch command is run.

```json
{
  "version": 1,
  "ocr": null,
  "assistant": null,
  "forecast": {
    "engine": "prophet",
    "python": ".runtime/forecast-venv/Scripts/python.exe"
  }
}
```

Validate the selection, then start a new owned run:

```powershell
python scripts/companion/run_companion.py --provider-config .runtime/providers/prophet.json --run-name prophet-demo-001 --check-config
python scripts/companion/run_companion.py --provider-config .runtime/providers/prophet.json --run-name prophet-demo-001
```

The owner starts the selected Python service and Node companion on loopback. A fresh private token protects the Python service. A different per-run companion token protects device requests. Neither token goes in an Expo environment variable, command argument, or public log. The Python service does not expose Flask's debugger. On Windows, its base interpreter starts with isolated/no-site flags, is assigned to the owner Job, and only then receives private startup configuration and loads the selected environment's packages.

Follow the [companion pairing guide](../../scripts/companion/README.md) to pair the exact debug emulator. Enable `EXPO_PUBLIC_LOCAL_COMPANION=1` before starting its Metro session, then open Wallet > Connections and recheck. In Reports > Open expense forecast, apply a valid date/category and choose Run local Prophet. The device calculation remains visible and works without the service. Starting the companion or opening the panel does not request a fit.

A version 2 connection advertises the exact local Prophet provider/version and its 120-month limit. Every request carries a binding to that run and provider. The Node route checks it before forwarding any monthly data, and the response echoes it. A changed connection, wallet owner, selected category/date, or relevant source data prevents a late response from appearing. Only currency, dates, and completed monthly totals are forwarded; transaction titles, notes, photos, and account details are not included.

Cancel stops waiting in the UI and sends a request-specific cancellation. The service signals that request's owned worker, terminates its Job in the worker cleanup path, and confirms completion before clearing the active slot. A cancelled request ID cannot start a later fit. If cleanup is uncertain, further fits are blocked until the owner is restarted. The computation limit is 30 seconds; bounded shutdown confirmation can take additional time. Neither cancellation nor a result writes the ledger.

Clear this exact run's device pairing before requesting owner shutdown, using the commands in the companion guide. The owner drains forecast requests, stops the local service, and records `forecastStopped`, `ownedProcessesStopped`, and connection/pairing cleanup in its ignored run summary. Do not terminate unrelated Python or Node processes by name.

## Route and verification scope

`forecast_service.create_app(token, runner)` remains available for controlled tests. Its authenticated loopback routes are `GET /health`, `POST /v1/forecast`, and `POST /v1/forecast/cancel`. It rejects browser-origin requests, duplicate/nonfinite JSON, oversized input, replayed IDs, and overlapping fits. Health confirms service readiness, not model accuracy. The raw synchronous `run_prophet` engine must not replace the owned runner in a listening service.

The [verification record](../../VERIFICATION.md) gives current results for the Python core, Flask test client and native Windows ownership/cancellation suites. The Node protocol, transport, route, and UI tests cover provider matching, explicit submission, cancellation, selected history, response validation, owner changes, and stale results. The actual combined owner-to-Node-to-Flask-to-Prophet path was exercised with synthetic history: a mismatched provider was rejected before fitting, a six-month result completed, cancellation was followed by another matching successful result, and owned shutdown was confirmed. These local results are separate from hosted CI and Android rendering checks; see [Verification](../../VERIFICATION.md) for the current native scope.

Prophet output remains separate from the device calculation. The ordinary screen's historical MAE belongs to its device baselines, not automatically to Prophet. Use the common-fold evaluation above before comparing quality. iOS and physical-device behavior remain unverified.

The portable backend reuses the same financial contract but has a separate Linux supervisor/container setup and an authenticated public gateway. Its gateway maps each accepted forecast to a server-generated private fit ID, so different accounts cannot cancel each other through a reused external request ID. Actual Windows backend execution is recorded separately from mocked Linux supervisor checks. Native Linux execution, container build and a hosted deployment remain unverified on the development machine; this Windows lock does not claim Linux wheel coverage.

The optional packages' authoritative sources are [Prophet on PyPI](https://pypi.org/project/prophet/) and [Flask documentation](https://flask.palletsprojects.com/). Setup installs dependencies locally; it does not deploy a cloud service.
