# Local Windows companion

This development helper supplies receipt OCR and, optionally, a local financial explanation model to the Android emulator app. It uses one authenticated loopback HTTP service. The app sends only the image it explicitly recognizes or the financial facts and question it explicitly asks about. The helper cannot write a ledger. A Windows host is required; this is not phone-side inference, cloud synchronization, or a standalone mobile distribution.

OCR is the default mode and does not import the model adapter, inspect model files, or require Lemonade. It uses the installed Windows English OCR component. Assistant mode requires the exact prepared local assets below. No script downloads a package, installs a backend, changes a driver, selects a cloud fallback, or starts a service merely because it is imported.

## Prerequisites and source layout

Use Windows x64, CPython 3.12 or newer, and Node.js 24.12 or newer. The checked development Node version is 24.22.0. Python code uses only its standard library; the host Node service uses only Node builtins and this repository's dependency-free financial modules. No `pip install` or second npm project is required for the companion.

The public source layout is:

```text
app/
  scripts/project-app-launch.cjs       existing installed-debug-package validator
  scripts/companion/
    run_companion.py                  explicit owner and hidden-child lifecycle
    control.py                       verify PID + creation time; request orderly stop
    pair-android.cjs                  explicit emulator pairing and clearing
    assets.py / prepare_assets.py     bounded offline asset preparation/verification
    assets.lock.json                  pinned official sources and hashes
    owned_process.py                 exact owned handles and Windows Job Object
    lemond_launcher.py                reference-derived private server launcher
    model_bootstrap.py                bounded stdin gate before model descendants start
    child.cjs                        one shared public companion server
    ocr/                             OCR route and bounded Windows worker
    assistant/                       optional route and private upstream adapter
    tests/                           injected lifecycle and pairing checks
  src/core/receipt.js                 shared pure receipt validation/parser
  src/assistant/grounding.js          shared explicit fact selection and response checks
  src/assistant/protocol.js           shared narrow request protocol
  .runtime/companion/                 ignored local assets, tokens and owned-run state
```

The receipt and assistant modules also use the existing `src/core` model/report/health helpers and `src/attachments/imageHeader`. They do not import private probe folders, personal toolchain configuration, saved credentials or test evidence. Preserve this repository layout when copying the helper. Keep `.runtime/` and `__pycache__/` ignored; no model, archive, generated connection, raw receipt or runtime log belongs in a commit.

## Start OCR without a model

From `app`, explicitly run:

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

`--runtime-root`, `--package-dir` and `--model-file` permit explicit locations beneath this app's ignored `.runtime` directory. Moving files does not bypass hashes or the exact offline configuration checks. The launcher re-verifies package/backend bytes against the pinned archives, checks the model hash, requires at least 6 GiB (6,442,450,944 bytes) of available physical memory before model startup, and checks the actual runtime catalog. This is a conservative availability check, not a guarantee that the model fits alongside every other workload. It samples available memory once per second and stops only its owned run after two consecutive samples below 1 GiB (1,073,741,824 bytes), or if the memory measurement fails. There is no automatic restart after that stop. OCR-only mode does not require or load a model and does not apply this model memory floor.

Model startup explicitly calls the local `/load` endpoint with `save_options:false`, `merge_args:false`, Vulkan, 2,048 context tokens and `--threads 4 --batch-size 128 --ubatch-size 128 --parallel 1 --cache-ram 0 --cache-type-k f16 --cache-type-v f16`. The prompt cache is disabled; the existing f16 key/value precision is preserved. Before exposing the shared service, the owner confirms the actual loaded model, live Vulkan executable, recipe context size and each unique effective launch flag from health. It does not rely on an environment variable or a profile setting alone. A healthy server or loaded model is not proof of answer quality. Failed or unsupported model output leaves deterministic financial facts usable.

## Pair the explicit Android debug emulator

The device connection filename is **`files/companion-connection.json`** in the installed app's private data directory. The native client resolves it with its own document/files directory; it must not use external storage or put the token in Metro/public environment variables. The pairing file is outside every financial ledger and account profile.

The client contract is exactly `{version:1,runId,url,token}`. Validate the entire shape, a bounded lowercase runId, a43–128-character URL-safe token and exactly `http://127.0.0.1:8787/v1/recognize`. It is enabled only by an explicit local-development configuration, reads no other path, exposes no token in UI/logs, and does not start a request on file load. Both receipt and assistant clients derive their endpoints from this same object. A changed run/config invalidates existing request sessions. Missing/invalid data is unavailable, never a cloud fallback.

With the named helper still running and the project's debug APK installed on the owned emulator:

```powershell
node scripts/companion/pair-android.cjs pair --adb "C:\path\to\adb.exe" --python "C:\path\to\python.exe" --serial emulator-5556 --run-name receipts-001
```

The command verifies the live launcher and companion PID/creation-time/executable records, the explicit emulator, and this project's installed debuggable package. It creates only `tcp:8787` → the current host port using `--no-rebind`; an existing unowned mapping is refused. It sends the connection bytes through stdin to an exclusively created per-run temporary file under verified `run-as com.lejie710.mymoneymanagement` private files, never through command arguments, logs or shared storage. Exact readback precedes an atomic no-clobber rename to the known final filename. A fixed non-secret creation marker distinguishes an owned partial copy from an unconfirmed target. `pairing.json` records strict run/mapping/temporary-file ownership without a token. The command does not start an emulator, install an APK, open the app, or touch Metro/Auth mappings.

## Clear pairing, then stop

Use the same explicit run, emulator and tool paths:

```powershell
node scripts/companion/pair-android.cjs clear --adb "C:\path\to\adb.exe" --python "C:\path\to\python.exe" --serial emulator-5556 --run-name receipts-001
python scripts/companion/control.py stop --run-name receipts-001
```

Clear removes only the matching final connection, a proven-owned per-run temporary file, and that run's verified 8787 mapping. If the file or mapping now belongs to another run, it refuses. A partial stdin delivery does not become the app's final configuration and can be deliberately cleared when creation was confirmed. If creation itself is uncertain, the temporary target and recovery metadata are retained for inspection. Stop requires that pairing was cleared and verifies live PID creation times before writing only the run's STOP marker. It never terminates a process by a saved PID or broad process name.

The launcher first asks its child to drain routes and close. Both the Node companion and a small model bootstrap wait for private stdin until their exact process handles are assigned to the run's Windows Job Object. Only then can the bootstrap start Lemond, so subsequent model children inherit that job. A failed model startup must confirm the old job stopped before the same root-visible owner opens a fresh job for another bounded attempt. This follows the documented [Windows child-job inheritance](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject) and [extended job-limit structure](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information). Health/catalog/load requests disable proxies, reject redirects and require the exact final loopback URL. Check the run's `summary.json` for process stop, request-thread drain and connection/pairing cleanup. Unconfirmed cleanup retains metadata.

Pairing also saves its exact connection in ignored private `pairing-connection.json` before changing device state. If a failure or memory guard has already stopped the companion, repeat the same `pair-android.cjs clear` command: only this clear action may use the completed exact-run summary (`ownedProcessesStopped:true`, no unconfirmed owned PIDs) and matching saved pairing proof. It still verifies the selected running debug emulator, exact private bytes and owned reverse mapping before removing them. It does not kill or inspect a reused PID. New pairing always requires live PID/start-time ownership. Missing, uncertain or conflicting post-stop evidence is retained for explicit inspection. No broad process, file or mapping cleanup is performed.

## Checks and limits

```powershell
python scripts/companion/tests/test_helpers.py
node scripts/companion/tests/transport-and-pairing.test.cjs
```

The 35 injected checks (21 Python and 14 Node) cover OCR operation without model dependencies, explicit private profile creation, pinned archive integrity, unsafe archive paths, bootstrap assignment before credentials, confirmed cleanup before startup retry, proxy/redirect rejection, live PID identity checks, shared public/private token separation, connection-file ownership, stdin/atomic pairing, malformed ownership records, refusal of unowned mappings, and deliberate cleanup after failed delivery or a confirmed owned stop. They also verify the nonpersistent model-load payload, actual live Vulkan/context/flag checks and the memory guard. They mock processes, native APIs and ADB; they do not launch an OCR engine, model or emulator. The receipt/assistant pure and transport suites remain separate checks.

The frozen public layout was separately exercised with a real Windows OCR-only run on loopback port 8787: the owned launcher and Node stdin gate started successfully; the public client/parser recognized both synthetic receipts and returned an empty result for the blank image; authentication and browser-origin boundaries returned the expected failures. Verified control stop completed, the connection was removed, no OCR jobs remained and the port became available again. No model or Android pairing was used in that run.

The subsequent public integration gates are complete for the recorded Android development paths. Receipt review used real private pairing and Windows OCR, saved only on explicit confirmation, retained the requested photo across restart and cleared owned temporary images. Assistant mode verified the actual loaded Vulkan model, served a question to the Android app and displayed a correct explanation with cited balance facts. Native Cancel and close/reopen were exercised; the ten-record wallet remained byte-identical. The public assistant run stopped all owned processes, drained request threads and cleared its connection/pairing without a failed or unconfirmed outcome. See [Verification](../../VERIFICATION.md), [Receipt capture](../../docs/RECEIPT_CAPTURE.md) and [Financial assistant](../../docs/FINANCIAL_ASSISTANT.md) for the exact evidence and debug-modal repair.

The separate final private model evaluation passed its bounded 18-response fixture after retained failed iterations; it does not establish general financial accuracy. Native account switching during an assistant request, full keyboard/large-text coverage, simultaneous OCR/inference stress, physical devices and iOS remain unverified. Model response checks catch specific known defects. The helper never treats a health check as an inference test or an accepted generated explanation as a verified financial conclusion.
