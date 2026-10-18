# Verification record

This record separates automated checks, actual Android behavior and unverified external services. All application data used for verification is fictional. Earlier implementation checkpoints are retained in [Earlier verification records](VERIFICATION_HISTORY.md); their sample defaults, test counts and unfinished-integration notes describe those earlier stages.

## Current integration checkpoint: 18 October 2026

The completed integrated source gate passed **1,023 JavaScript tests and TypeScript** on the current source, including the native upload repair, owner/preview recovery changes and optional-provider UI regressions. No tests failed, were cancelled or were skipped. The optional-helper Python gates passed **26 companion checks**, **19 Auth lifecycle checks** and **45 Prophet checks**. The Prophet suite includes owned-worker startup, cancellation, timeout, child cleanup, parent-crash handling and the new Windows path-budget regressions. These are local results, not hosted CI results.

The actual API 35 Android Firebase walkthrough completed the following checks with synthetic accounts and loopback Auth/Firestore/Storage emulators:

- An empty guest wallet saved an ordinary MYR12.50 expense. Registration opened a separate empty account wallet, and signing in alone did not copy or upload guest records.
- An explicitly previewed guest copy populated only the unchanged empty account wallet. The original guest wallet was preserved.
- Android exposed the SDK's unsupported Blob-from-ArrayBuffer upload path. After the byte-capable upload repair, the retained pending backup resumed under the **same operation ID**, completed and appeared in the backup list. Data-only restore into an explicitly empty account target and a fresh app-process restart preserved the expected financial record.
- A photo selected through Android Photo Picker was attached to the existing expense without changing its amount. Explicit photo backup uploaded and listed the completed snapshot and image.
- Restore rejected a populated account wallet without changing its saved bytes or photo. Signing out after an unconfirmed restore preview retired that account's preview/list in the guest UI; signing back in required a fresh list and preview.
- The exact photo backup restored under a fresh wallet incarnation and newly owned file reference. Its PNG matched all **43,031 original bytes** and its SHA-256, rendered natively, and still matched and rendered after a fresh Android process. Guest financial bytes remained unchanged.

The upload repair retains Firebase ID-token authentication, access rules, metadata verification and the pending-operation identity. The completed native checks demonstrate this isolated emulator workflow; they do not establish a hosted project's configuration, email delivery, real account permissions or billing behavior.

The initial native Prophet request exposed a Windows temporary-path problem: CmdStanPy failed while opening a 270-character output filename. The exact captured 18-month synthetic history succeeded through the actual owned worker at a shorter path and failed at equivalent service depth. The service now selects a short per-service fit workspace with an explicit path budget. A separately owned real Flask/Prophet service then processed the same input successfully under a longer launcher run name, matched the short-path predictions, left the input unchanged and confirmed service/Job shutdown. This is completed **host-side regression evidence**, not a completed Android Prophet retry.

The remaining native/publication checks are explicitly pending:

| Check | Current status |
| --- | --- |
| Android Prophet after the path repair | Pending a fully completed native retry and its request/result, displayed-row, cancellation and unchanged-data evidence; failed or incomplete attempts are not counted as passes |
| Android OpenAI and Google Vision integration | Pending the native walkthrough with injected upstream responses; offline adapter/route/client checks remain separate evidence |
| Final default-mode walkthrough | Pending the final ordinary local workflow check with optional connections unconfigured |
| Public screenshot gallery | Pending actual final captures, visual/privacy review and fictional-data disclosure; diagnostic frames are not the public gallery |

The optional integrations are implemented; these pending items describe the remaining verification and capture work. Live OpenAI/Vision and hosted Firebase checks remain outside the completed evidence even after an injected/emulated native walkthrough.

## Reproduce the source checks

From the repository root, using the Node version in `.node-version`:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run check
npm.cmd run test:python
```

The last command requires Python 3.12 or newer as `python`. The JavaScript gate includes application, companion and Auth-helper tests, followed by TypeScript. It uses synthetic inputs and injected native/provider effects. The Python helper checks do not install or fit Prophet.

Optional suites have separate prerequisites and commands:

- [Firebase emulator rules and SDK round trip](tools/firebase-backup/README.md): local Auth, Firestore and Storage, isolated demo project and enforced loopback-only verification.
- [Flask/Prophet checks and real-model evaluation](tools/forecast/README.md): pinned Windows/Python environment, owned model processes and invented monthly histories.
- [Android setup and walkthrough](docs/ANDROID_SETUP.md): installed project app, JDK17, Android SDK and the native development runtime.

The repository includes a Windows GitHub Actions source-check workflow. Its hosted execution remains unverified until the repository is published and a run completes.

## Native build baseline

A fresh Android project generated from this public source completed its x86_64 debug build on 18 October 2026 in 11 minutes 54 seconds, with 256 Gradle tasks. Android debug signature and 16 KiB ZIP alignment checks passed. The build used Node24.22.0, Expo58.0.14, JDK17 and existing Windows SDK/Gradle/Maven caches. This does not establish a clean-machine installation or an ARM/production build.

The API35 walkthrough verified the empty first launch, invalid-input handling, cancelled drafts, an exact expense balance, budgets, savings goal, restart persistence, larger text at font scale1.3, and actual native PDF generation. The installed APK was replaced with `install -r`; saved data was preserved. Current integration changes use this same native runtime, with no additional native dependency required by the upload repair.

## Interpretation and limits

- Hosted Firebase configuration, deployment, billing, real account permissions and reset-email delivery have not been verified. Emulator results do not establish a deployed project's security configuration.
- OpenAI and Google Vision provider contracts are exercised with injected upstream responses. No real provider credentials, requests or charges are part of these checks; output quality and a user's chosen model/account remain unverified.
- Prophet's comparison uses invented histories and identical historical folds. A good error figure on that series is not evidence of better prediction on real finances. Its model errors are separate from the device forecast's displayed historical baseline errors.
- No iOS, physical Android device, production signing, distributed APK, full screen-reader audit or clean-computer setup is claimed.
- Map/network availability and device power policies depend on the target environment. Earlier feature checks retain their own scope in the historical record.
- Local checks cannot establish that every future provider response or interrupted device write will succeed. The guides explain bounded inputs, stale-session rejection, pending-operation recovery and known setup requirements.
