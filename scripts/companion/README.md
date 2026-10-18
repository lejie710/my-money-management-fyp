# Windows companion and optional providers

The companion connects the Android development app to explicitly selected receipt, assistant and forecast services through one authenticated loopback connection. The app sends a receipt image only after recognition is requested, selected calculated facts only after a question is asked, and completed monthly expense totals only after Prophet is requested. None of these services can write the financial ledger.

The existing `--mode ocr` and `--mode assistant` commands still work. OCR remains the default when neither mode nor a provider file is supplied. A private provider file allows independent selection of Windows OCR or Google Cloud Vision, Lemonade/Qwen or OpenAI, and optional local Prophet. An unavailable service never switches to another provider automatically.

| Capability            | Local option                                          | Optional alternative                   | Data sent after the explicit action                                                      |
| --------------------- | ----------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| Receipt recognition   | Windows `en-US` OCR                                   | Google Cloud Vision                    | One selected image; 10 MiB maximum locally, 6 MiB with Vision                            |
| Financial explanation | Pinned Lemonade/Qwen model on Windows                 | OpenAI with an explicitly chosen model | Visible calculated facts and the current question; no earlier conversation or raw ledger |
| Monthly forecast      | The app's device calculation always remains available | Prophet running on Windows             | Selected completed monthly expense totals, currency and dates                            |

OpenAI and Vision process their selected inputs in the cloud and may incur provider charges. Their keys stay on the host. Prophet is local and needs no provider key. Firebase authentication and deliberate cloud backup are a separate integration; they are not routed through this helper. This companion targets an owned Android debug emulator, not standalone phone-side inference or a production Internet service.

## Prerequisites and source layout

Use Windows x64, CPython 3.12 or newer for the owner, and the repository's Node 24 version (`.node-version`, currently 24.22.0). Local OCR and the OpenAI/Vision host adapters use Python's standard library, Node builtins and this repository's pure modules; they need no separate npm project. Optional Prophet requires the locked Windows x64/Python 3.12 environment below. These helper prerequisites are separate from the app's npm dependencies and [Android build setup](../../docs/ANDROID_SETUP.md). Prophet does not use Java; Android builds and Firebase emulator tooling have their own prerequisites.

```text
<repository>/
  scripts/project-app-launch.cjs       installed-debug-package validator
  scripts/companion/
    run_companion.py                  explicit owner and hidden-child lifecycle
    provider_config.py                bounded private provider selection
    control.py                       verify identity; request orderly stop
    pair-android.cjs                  explicit emulator pairing and clearing
    assets.py / prepare_assets.py     bounded offline asset preparation/verification
    assets.lock.json                  pinned official sources and hashes
    owned_process.py                 exact owned handles and Windows Job Object
    lemond_launcher.py                private local model-server launcher
    model_bootstrap.py                stdin gate before model descendants start
    child.cjs                        one shared companion server
    ocr/                             Windows/Vision workers and receipt route
    assistant/                       Lemonade/OpenAI adapters and explanation route
    forecast/                        adapter to the owned local Prophet service
    tests/                           lifecycle, selection and pairing checks
  src/core/receipt.js                 pure receipt validation and review parser
  src/assistant/                     selected facts, transport and response checks
  src/companion/providerContract.js   validated non-secret capability descriptors
  src/forecast/                      selected-month request and response validation
  tools/forecast/                    locked Prophet environment and owned worker/service
  .runtime/companion/                 ignored assets, tokens and owned-run state
```

The helper uses the existing pure financial modules and image-header validator. It does not import private probe folders, personal toolchain configuration or saved credentials. Preserve this repository layout. Keep `.runtime/` and `__pycache__/` ignored; model files, archives, generated connections, raw receipts and runtime logs do not belong in commits.

## Start OCR without a model

From the repository root, explicitly run:

```powershell
python scripts/companion/run_companion.py --mode ocr --run-name receipts-001
```

Add `--node "C:\path\to\node.exe"` if the desired Node executable is not on PATH. The owner remains running until an orderly stop is requested. Its Node/PowerShell children are hidden. A new run name is required; an existing run is never overwritten or adopted. The service binds `127.0.0.1` on an available host port and creates `.runtime/companion/runs/receipts-001/connection.json` with a fresh per-run Bearer token. Console stages do not print that token.

The Windows OCR engine must have its `en-US` language component available. Missing OCR, unsupported images, timeouts and unavailable ownership state are failures with fixed messages. No fallback invents recognized fields. Receipt jobs contain owned copies, not gallery originals; a worker is not declared drained until its native process closes. An unconfirmed close retains its temporary job and blocks further OCR rather than guessing that cleanup succeeded.

## Prepare the optional assistant from pinned local assets

Download assets deliberately from these official project/model sources, then pass the resulting local files to the preparation command. The helper does not perform those downloads.

| Asset                                     | Source                                                                                                                                                                  |         Bytes | SHA256                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------: | ------------------------------------------------------------------ |
| Embeddable Lemonade2026.42.1, Windows x64 | [Official release archive](https://github.com/lemonade-sdk/lemonade/releases/download/v2026.42.1/lemonade-embeddable-2026.42.1-windows-x64.zip)                         |     5,407,306 | `6bc9b9f301aa8235f2e6a2a51d75f0ba0f9cb3580e65ff0ea4fc6752ef3a8f3f` |
| llama.cpp b11393, Vulkan Windows x64      | [Official backend archive](https://github.com/ggml-org/llama.cpp/releases/download/b11393/llama-b11393-bin-win-vulkan-x64.zip)                                          |    33,279,911 | `b68b17780f4736b733a128022749d40e4030a40a12b5c388f63a4e354adc62b1` |
| Qwen3-4B-Instruct-2507 Q4_K_M             | [Pinned model revision](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/a06e946bb6b655725eafa393f4a9745d460374c9/Qwen3-4B-Instruct-2507-Q4_K_M.gguf) | 2,497,281,120 | `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597` |

The model revision is `a06e946bb6b655725eafa393f4a9745d460374c9`; its repositories identify Apache2.0 licensing. The complete Lemonade package, resources and included license are preserved, as are backend archive license files. The inspected Lemonade executables were unsigned; the digest and official source establish the checked bytes, not an Authenticode signature. Binaries are not included in source control.

```powershell
python scripts/companion/prepare_assets.py --lemonade-archive "C:\downloads\lemonade-embeddable-2026.42.1-windows-x64.zip" --vulkan-archive "C:\downloads\llama-b11393-bin-win-vulkan-x64.zip" --model-file "C:\downloads\Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
python scripts/companion/run_companion.py --mode assistant --run-name assistant-001
```

Preparation validates byte counts and hashes, audits archive paths/duplicates/symlinks/expanded bounds, and creates a fresh private package. Source downloads are retained. A failed partial destination is retained for explicit inspection instead of being overwritten. The model is copied to its exact pinned cache layout; the full package is preserved. The generated config binds loopback, disables telemetry/broadcast/model updates/downloads/cloud providers/system backends, selects Vulkan, and uses 2,048 context tokens with one loaded model. Host requests use 160 output tokens, four CPU helper threads, temperature 0, seed 7 and a 120-second deadline. CPU fallback is not enabled by this package because its inference path has not passed the same gate.

`--runtime-root`, `--package-dir` and `--model-file` permit explicit locations beneath this app's ignored `.runtime` directory. Moving files does not bypass hashes or the exact offline configuration checks. The launcher re-verifies package/backend bytes against the pinned archives, checks the model hash, requires at least 6 GiB (6,442,450,944 bytes) of available physical memory before model startup, and checks the actual runtime catalog. This is a conservative availability check, not a guarantee that the model fits alongside every other workload. It samples available memory once per second and stops only its owned run after two consecutive samples below 1 GiB (1,073,741,824 bytes), or if the memory measurement fails. There is no automatic restart after that stop. OCR-only mode does not require or load a model and does not apply this model memory floor. OpenAI-only assistant selection likewise does not prepare or load Lemonade assets; its optional OCR selection remains independent.

Model startup explicitly calls the local `/load` endpoint with `save_options:false`, `merge_args:false`, Vulkan, 2,048 context tokens and `--threads 4 --batch-size 128 --ubatch-size 128 --parallel 1 --cache-ram 0 --cache-type-k f16 --cache-type-v f16`. The prompt cache is disabled; the existing f16 key/value precision is preserved. Before exposing the shared service, the owner confirms the actual loaded model, live Vulkan executable, recipe context size and each unique effective launch flag from health. It does not rely on an environment variable or a profile setting alone. A healthy server or loaded model is not proof of answer quality. Failed or unsupported model output leaves deterministic financial facts usable.

## Select optional providers with a private JSON file

Create `.runtime/provider-config.json` inside this checkout. The loader resolves its path and requires it to remain under the repository's ignored `.runtime` directory. The file must be UTF-8 JSON, at most 8 KiB, with exactly the documented fields. Unknown fields, duplicate keys, unsupported providers and an all-disabled selection are rejected.

The smallest configuration reproduces OCR-only mode:

```json
{
  "version": 1,
  "ocr": { "engine": "windows-media-ocr" },
  "assistant": null,
  "forecast": null
}
```

Each capability is independent:

| Field       | Supported value                                                                                        | Prerequisite                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `ocr`       | `null`, `{ "engine": "windows-media-ocr" }`, or `{ "engine": "google-cloud-vision", "apiKey": "..." }` | Windows English OCR, or your own enabled Vision service and server credential      |
| `assistant` | `null`, `{ "engine": "lemonade" }`, or `{ "engine": "openai", "model": "...", "apiKey": "..." }`       | Pinned local assets, or your own OpenAI credential and a compatible explicit model |
| `forecast`  | `null` or `{ "engine": "prophet", "python": "C:/path/to/environment/Scripts/python.exe" }`             | The locked Prophet environment below                                               |

This cloud example is intentionally incomplete. Fill the empty keys and model with your own inputs in the ignored private file, or set an unwanted capability to `null`. Empty values fail validation; they do not activate a demonstration response. The repository creates no provider account or key and chooses no default OpenAI model.

```json
{
  "version": 1,
  "ocr": { "engine": "google-cloud-vision", "apiKey": "" },
  "assistant": { "engine": "openai", "model": "", "apiKey": "" },
  "forecast": null
}
```

Use an OpenAI model supporting the adapter's Chat Completions Structured Outputs contract. Model availability, account entitlement, quotas and billing belong to your provider configuration. See the [OpenAI contract](assistant/OPENAI.md) and [Vision contract](ocr/GOOGLE_VISION.md). There is no configurable upstream URL or automatic cloud fallback.

**OpenAI/Vision API keys belong only in the ignored private file and the helper's stdin/memory.** Do not put them in source, commits, shell environment variables, process arguments, Expo public configuration, pairing files, logs or ledgers. The phone receives its own per-run companion token and non-secret descriptors, never provider API keys or private upstream service keys.

Validate the private file before starting processes:

```powershell
python scripts/companion/run_companion.py --provider-config .runtime/provider-config.json --run-name providers-001 --check-config
```

`--run-name` is required even with `--check-config`. This check prints only derived non-secret provider descriptors. It makes no provider request, starts no process and creates no run directory. It validates configuration shape, not live credentials, model availability or installed Prophet packages.

Start the same selection explicitly and keep the owner command running in its terminal:

```powershell
python scripts/companion/run_companion.py --provider-config .runtime/provider-config.json --run-name providers-001
```

Add `--node "C:/path/to/node.exe"` when Node is not on PATH. Do not combine `--mode` and `--provider-config`; the launcher rejects that ambiguity. Provider keys travel to the owned Node child through bounded stdin, not arguments or inherited provider-key environment variables. The owner remains in the foreground and its children are hidden. Importing a module or checking configuration starts no service.

A running selection is fixed. After changing provider, model or credential settings, clear its Android pairing, stop the exact run, then start a fresh run name and pair again. Do not edit generated connection files or reuse another run's token. `--runtime-root` changes the owned runtime location only beneath `.runtime`; choose a child directory such as `.runtime/companion-alt`. It does not permit a provider file outside `.runtime`.

### Add local Prophet

From the repository root, create its separate environment and install only the locked wheels from PyPI. These commands download dependencies; the companion itself does not install them:

```powershell
py -3.12 -m venv .runtime/forecast-venv
& ./.runtime/forecast-venv/Scripts/python.exe -m pip install --require-hashes --only-binary=:all: --index-url https://pypi.org/simple -r tools/forecast/requirements-windows-py312.lock
```

Set `forecast` in the private JSON file to the explicit absolute interpreter path. Replace the example with the actual checkout location; forward slashes avoid JSON backslash escaping:

```json
{ "engine": "prophet", "python": "C:/path/to/repository/.runtime/forecast-venv/Scripts/python.exe" }
```

This object is the `forecast` field value, not a whole configuration. It can be combined with any supported OCR/assistant selection; either can be `null`. The owner starts a private loopback Prophet service, authenticates its health response and includes it in the owned lifecycle. A ready service has not fitted a model. The Android app invokes it only after **Run local Prophet**.

Prophet accepts 8-120 consecutive completed months with expenses in at least three months. It excludes the partial as-of month and predicts the following six calendar months. Longer history is not silently truncated. The device result remains available when the optional service is absent or fails. Unconfirmed worker cleanup blocks reuse until the owned companion is recovered. See [Prophet setup and evaluation](../../tools/forecast/README.md) for its lock, reproducible synthetic evaluation, model settings and limits. No Java installation is required for Prophet.

## Pair the explicit Android debug emulator

The device connection filename is **`files/companion-connection.json`** in the installed app's private data directory. The native client resolves it from its own files directory. The token belongs outside every ledger/account profile and never goes into shared storage or Metro/public environment variables.

New runs emit `{version:2,runId,url,token,providers}`. The `providers` field contains only validated descriptors: engine, local/cloud processing, selected model or protocol version, and fixed limits. The app accepts exactly `http://127.0.0.1:8787/v1/recognize`, a bounded run ID and a 43-128-character private companion token. Legacy `{version:1,runId,url,token}` files remain local-only and cannot opt into cloud providers. The private selection file's version 1 and the generated pairing protocol's version 2 are different schemas.

Version 2 requests carry the canonical run/capability/provider binding in `x-mymoney-provider`. The server rejects mismatches before forwarding data; successful responses echo `providerBinding` for the client to verify. Clients are constructed only for declared capabilities. Rechecking or replacing the connection retires old requests and results. Reading configuration triggers no inference, recognition or forecast request.

Enable optional development connections before starting a new Metro process, following the [Android setup guide](../../docs/ANDROID_SETUP.md):

```powershell
$env:EXPO_PUBLIC_LOCAL_COMPANION = '1'
```

This flag enables local pairing and contains no provider key. With the named helper still running and the project's debug APK installed on the owned emulator, use the exact run, serial and installed tool paths:

```powershell
node scripts/companion/pair-android.cjs pair --adb "C:/path/to/adb.exe" --python "C:/path/to/python.exe" --serial emulator-5556 --run-name receipts-001
```

Use `providers-001` instead of `receipts-001` when that is the run you started. After pairing, open **Wallet > Tools > Connections**, choose **Recheck connection**, and reopen the intended tool. The UI identifies the cloud destination and outgoing data before the explicit action. Receipt confirmation remains separate from recognition; Prophet remains separate from the device calculation.

Pairing verifies the live launcher and companion PID/creation-time/executable records, the explicit emulator and this project's installed debuggable package. It creates only a `tcp:8787` reverse mapping to the current host port using `--no-rebind`; an existing unowned mapping is refused. Connection bytes travel through stdin into an exclusively created per-run temporary file under verified `run-as com.lejie710.mymoneymanagement`, never through arguments, logs or shared storage. Exact readback precedes an atomic no-clobber rename to the known final filename.

A fixed non-secret creation marker distinguishes an owned partial copy from an unconfirmed target. `pairing.json` records strict run/mapping/temporary-file ownership without a token. The command does not start an emulator, install an APK, open the app or touch Metro/Auth mappings.

## Clear pairing, then stop

Use a second terminal while the owner remains running. Use the same explicit run, emulator and tool paths; replace `receipts-001` with `providers-001` or your actual run name when appropriate:

```powershell
node scripts/companion/pair-android.cjs clear --adb "C:\path\to\adb.exe" --python "C:\path\to\python.exe" --serial emulator-5556 --run-name receipts-001
python scripts/companion/control.py stop --run-name receipts-001
```

Clear removes only the matching final connection, a proven-owned per-run temporary file, and that run's verified 8787 mapping. If the file or mapping now belongs to another run, it refuses. A partial stdin delivery does not become the app's final configuration and can be deliberately cleared when creation was confirmed. If creation itself is uncertain, the temporary target and recovery metadata are retained for inspection. Stop requires that pairing was cleared and verifies live PID creation times before writing only the run's STOP marker. It never terminates a process by a saved PID or broad process name.

The launcher first asks its Node child to cancel/drain routes and close, then stops the owned Prophet service when selected, and finally confirms the remaining owned processes stopped. Both the Node companion and a small model bootstrap wait for private stdin until their exact process handles are assigned to the run's Windows Job Object. Only then can the bootstrap start Lemond, so subsequent model children inherit that job. A failed model startup must confirm the old job stopped before the same root-visible owner opens a fresh job for another bounded attempt. This follows the documented [Windows child-job inheritance](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject) and [extended job-limit structure](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information). Health/catalog/load requests disable proxies, reject redirects and require the exact final loopback URL. Check the run's `summary.json` for confirmed process stop, request-thread drain and connection/pairing cleanup, plus `forecastStopped` when Prophet was selected. Unconfirmed cleanup retains metadata.

Pairing also saves its exact connection in ignored private `pairing-connection.json` before changing device state. If a failure or memory guard has already stopped the companion, repeat the same `pair-android.cjs clear` command: only this clear action may use the completed exact-run summary (`ownedProcessesStopped:true`, no unconfirmed owned PIDs) and matching saved pairing proof. It still verifies the selected running debug emulator, exact private bytes and owned reverse mapping before removing them. It does not kill or inspect a reused PID. New pairing always requires live PID/start-time ownership. Missing, uncertain or conflicting post-stop evidence is retained for explicit inspection. No broad process, file or mapping cleanup is performed.

## Checks and limits

These checks use injected processes/factories or synthetic loopback fixtures and need no cloud account:

```powershell
python -m unittest discover -s scripts/companion/tests -p "test_*.py" -v
node --test --test-concurrency=2 scripts/companion/tests/transport-and-pairing.test.cjs scripts/companion/tests/provider-selection.test.cjs tests/provider-contract.test.cjs tests/provider-connection-v2.test.cjs
node --test --test-concurrency=2 scripts/companion/tests/openai-adapter.test.cjs scripts/companion/tests/google-vision-worker.test.cjs tests/provider-integration.test.cjs tests/provider-disclosure-ui.test.cjs
```

They cover local defaults, explicit selection, key exclusion from pairing, provider binding before forwarding, unknown/disabled capabilities, immutable selected inputs, cancellation and failure mapping. Ownership tests retain the original bootstrap, archive, identity, pairing and cleanup assertions. Adapter tests inject upstream responses. Some integration suites start an owned loopback HTTP fixture; they do not start a real model, OCR engine, Android emulator or paid provider request.

The optional Prophet suite uses its installed environment and includes actual hidden Windows worker lifecycle tests:

```powershell
& ./.runtime/forecast-venv/Scripts/python.exe -B -m unittest discover -s tools/forecast -p "test_*.py" -v
```

Recorded local-provider gates include real Windows OCR on synthetic receipts, Android review with explicit expense/photo confirmation and restart, and local Lemonade inference with cited balance facts. Native cancellation and close/reopen were exercised; the recorded wallet stayed unchanged during assistant requests. These historical gates are described in [Verification](../../VERIFICATION.md), [Receipt capture](../../docs/RECEIPT_CAPTURE.md) and [Financial assistant](../../docs/FINANCIAL_ASSISTANT.md).

Current optional OpenAI/Vision contracts are exercised with injected upstream responses. That establishes request/response, review, disclosure and ownership behavior; it does not establish live authentication, billing, model compatibility or recognition quality. Any native run using an injected provider remains fixture evidence and must be identified as such. No real OpenAI/Vision call is claimed by this guide.

Real local Prophet fits and matched synthetic comparisons are separate from mocked contract tests. A forecast estimate, successful health check or accepted explanation is not a verified financial conclusion. The local model's bounded 18-response evaluation likewise does not establish general answer accuracy. Broader questions, simultaneous OCR/inference stress, full large-text coverage, physical devices and iOS require their own evidence. This helper does not deploy an Internet service or distribute a standalone mobile backend.
