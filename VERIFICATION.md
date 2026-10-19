# Verification record

This record separates automated checks, actual Android behavior and unverified external services. All application data used for verification is fictional. Earlier implementation checkpoints are retained in [Earlier verification records](VERIFICATION_HISTORY.md); their sample defaults, test counts and unfinished-integration notes describe those earlier stages.

## Current completion checks: 19 October 2026

The current integrated `npm.cmd run check` passed **1,212 JavaScript tests and TypeScript** on 19 October 2026. All 1,212 tests passed, with zero failures, cancellations or skips. The command includes application, companion, Auth-helper and backend suites. Coverage includes everyday Firebase records and operation recovery, owner/session retirement, transaction/budget/goal drafts, saved assistant history, provider-specific context defaults, local/cloud storage disclosures and the exact Docker build-context file policy. These are local source checks, not hosted CI or live-provider verification.

The current optional-helper Python gate passed **26 companion checks**, **19 Auth lifecycle checks** and **6 backend supervisor checks**. The backend supervisor suite uses mocked Linux process/resource effects on Windows; it does not establish native Linux execution. The earlier **45-check Prophet suite** remains recorded at its restoration checkpoint below and was not rerun as part of this `test:python` gate.

| Integration evidence               | Completed scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actual local Firebase emulators    | **11/11 checks passed** against isolated Auth, Firestore and Storage. The actual SDK exercised everyday saves, second-client hydration, server revision conflicts, same-operation replay and coexistence with manual backups. Rules checks covered matching atomic operation receipts, monotonically increasing revisions, owner isolation and immutable content-addressed photo objects. The guarded everyday round trip made 17 requests to its three loopback emulator endpoints, with no blocked outbound attempt.             |
| Loopback assistant backend         | The actual gateway, mobile client and OpenAI adapter used an injected upstream response with explicit demo authentication. Two answers were accepted, cancellation was followed by retry, the synthetic ledger remained unchanged and the owned listener stopped. **No live OpenAI request** was made.                                                                                                                                                                                                                             |
| Real Windows Flask/Prophet backend | The hosted HTTP protocol ran over loopback with explicit demo authentication and an actual private Flask/Prophet worker. Missing authentication and another owner's binding were rejected. A fit used 18 synthetic completed months; a newly assigned worker was observed before cancellation, its stop was confirmed, and a subsequent fit reproduced the same six predictions. Input stayed unchanged and both owned services stopped. **No live cloud service** was called.                                                     |
| Local Qwen context budget          | The cached model's exact offline tokenizer measured the current shared prompt/template. Full default summaries required 1,866 prompt tokens against the adapter's 1,504-token allowance. The local categories-only default used 1,016; a representative three-exchange follow-up used 1,347. This establishes those prompt-budget cases, not a new inference or a guarantee that every long question/history fits. Extra selections remain explicit; oversized requests are rejected without silently truncating facts or history. |
| Container boundary                 | Source tests passed for the literal file allowlist and required runtime import closure. Docker image build and actual Linux/container execution remain unverified.                                                                                                                                                                                                                                                                                                                                                                 |

The current Android integration walkthrough and refreshed gallery are **still in progress**. An earlier appearance check for this change already recorded empty first launch, Dark Wallet/Activity rendering, hidden home balance retained after process restart, and open text retained across explicit and system appearance changes. Broader everyday-cloud, offline-save/draft, saved-conversation and current-gallery acceptance must be recorded separately when those native checks finish. The restoration walkthroughs and screenshots below retain their original scope; they do not establish every newly added flow.

## Earlier restoration checkpoint: 18-19 October 2026

The restoration-checkpoint integrated source gate passed **1,045 JavaScript tests and TypeScript** on 19 October 2026, including the native upload repair, owner/preview recovery changes, optional-provider UI regressions, explicit unavailable-session recovery and the photo-count wording correction. No tests failed, were cancelled or were skipped. The optional-helper Python gates passed **26 companion checks**, **19 Auth lifecycle checks** and **45 Prophet checks**. The Prophet suite includes owned-worker startup, cancellation, timeout, child cleanup, parent-crash handling and the new Windows path-budget regressions. These are local results, not hosted CI results.

The actual API 35 Android Firebase walkthrough completed the following checks with synthetic accounts and loopback Auth/Firestore/Storage emulators:

- An empty guest wallet saved an ordinary MYR12.50 expense. Registration opened a separate empty account wallet, and signing in alone did not copy or upload guest records.
- An explicitly previewed guest copy populated only the unchanged empty account wallet. The original guest wallet was preserved.
- Android exposed the SDK's unsupported Blob-from-ArrayBuffer upload path. After the byte-capable upload repair, the retained pending backup resumed under the **same operation ID**, completed and appeared in the backup list. Data-only restore into an explicitly empty account target and a fresh app-process restart preserved the expected financial record.
- A photo selected through Android Photo Picker was attached to the existing expense without changing its amount. Explicit photo backup uploaded and listed the completed snapshot and image.
- Restore rejected a populated account wallet without changing its saved bytes or photo. Signing out after an unconfirmed restore preview retired that account's preview/list in the guest UI; signing back in required a fresh list and preview.
- The exact photo backup restored under a fresh wallet incarnation and newly owned file reference. Its PNG matched all **43,031 original bytes** and its SHA-256, rendered natively, and still matched and rendered after a fresh Android process. Guest financial bytes remained unchanged.

The upload repair retains Firebase ID-token authentication, access rules, metadata verification and the pending-operation identity. The completed native checks demonstrate this isolated emulator workflow; they do not establish a hosted project's configuration, email delivery, real account permissions or billing behavior.

A later startup check reproduced a saved sign-in whose server account no longer existed. A separate probe using the actual React Native Firebase Auth SDK and local emulator observed `USER_NOT_FOUND` across fresh initializations while the guard retained the original opaque session bytes. The explicit recovery removed exactly one scoped Auth record, left that running adapter blocked, and allowed a fresh process to confirm guest identity. Its ten requests stayed on the local Auth endpoint with no blocked outbound attempt; it did not contact a hosted account service.

The actual Android recovery walkthrough then confirmed that cancelling the recovery choice preserved the exact saved Auth bytes. Explicit confirmation removed only the unavailable saved sign-in and confirmed its absence. Financial access remained gated in that process. After restart, the app opened the existing guest wallet at **-MYR12.50**; the retained 277-transaction account wallet and one-transaction guest wallet remained byte-identical. The action does not reset or reassign account wallets, recreate the deleted server account, or provide a general repair for malformed/unreadable storage. Unknown session bytes and unconfirmed storage outcomes remain fail-closed; a fresh process must confirm the next identity and wallet before access resumes.

The initial native Prophet request exposed a Windows temporary-path problem: CmdStanPy failed while opening a 270-character output filename. The exact captured 18-month synthetic history succeeded through the actual owned worker at a shorter path and failed at equivalent service depth. The service now selects a short per-service fit workspace with an explicit path budget. A separately owned real Flask/Prophet service then processed the same input successfully under a longer launcher run name, matched the short-path predictions, left the input unchanged and confirmed service/Job shutdown. A subsequent API 35 Android run sent the same 18 completed months through the real service, matched all six displayed forecast values to its response, and retained account and guest financial bytes. A bound cancellation acknowledgement was followed by another successful fit. That native acknowledgement alone does not prove worker interruption; the separate owned-worker lifecycle checks cover interruption and cleanup.

The restoration native walkthroughs completed the following checks:

| Check                      | Completed scope                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows OCR                | The actual Android picker submitted the approved cafe receipt to the real Windows OCR engine. Title, date and MYR suggestions were reviewed; a total that was not auto-filled was entered manually from the image. Cancelling review preserved account, guest and photo bytes. This is a synthetic workflow check, not a general accuracy assessment.                                                     |
| Local Qwen assistant       | A real Qwen3-4B-Instruct-2507-GGUF response through Lemonade on Vulkan matched the selected October category amounts, percentages, expenses, debt payments and outflow. The answer and citations passed independent semantic and visual review; account, guest and photo bytes remained unchanged.                                                                                                        |
| OpenAI integration         | The native screen disclosed the selected provider before submission, displayed the injected answer and provenance, and completed cancellation followed by retry. Account and guest bytes stayed unchanged. External provider networking was blocked; this did not contact live OpenAI.                                                                                                                    |
| Google Vision integration  | The native picker and injected recognition response produced editable suggestions without saving. Explicit review and confirmation then added exactly one MYR12.50 expense, retained all prior records and the guest wallet, and did not redispatch recognition or retain a photo. External provider networking was blocked.                                                                              |
| Ordinary unconfigured mode | A separate fresh namespace opened an empty local wallet without sample labels or configured-service shortcuts. All four primary screens and Connections were checked. An ordinary MYR12.34 expense survived a fresh Android process with identical saved bytes. The original test configuration was then restored and reopened. The device network remained enabled; this was not an airplane-mode check. |
| Public feature gallery     | Twelve main views and three supplementary views passed visual and privacy review. Fourteen unaltered 720 x 1560 Android frames and one faithful rendering of an app-exported PDF page cover the selected workflows. The same fictional 277-record MYR wallet was preserved across the read-only walkthroughs.                                                                                             |

At that restoration checkpoint, the Firebase rules gate also passed seven checks against the actual local emulators. A guarded SDK round trip verified wallet/photo upload, list, download and same-ID retry with native-incompatible Blob construction forbidden. These results complement the completed Android workflow above.

The optional integrations are implemented. Emulated Firebase and injected OpenAI/Vision checks establish the documented local integration behavior; they do not establish live credentials, provider response quality, account entitlements or billing outcomes.

## Verified feature gallery: 18–19 October 2026

The [README gallery](README.md#screenshots) contains twelve main views: Activity, transaction photo and note, category budgets, savings goal, expense-category reports, the what-if simulator, loan calculator, local Prophet forecast, Windows receipt review, local Qwen assistant, manual backup preview and the exported report. The [UI guide](docs/UI_DESIGN.md#native-android-gallery) adds Wallet, period balances and the device forecast. All fifteen selections passed visual and privacy review. Phone screenshots retain their original pixels; the report image is a faithful rendering of the first page of the app's two-page PDF.

The views use fictional records in the same 277-transaction MYR wallet. Each read-only walkthrough preserved account and guest financial bytes, wallet ownership and the saved receipt photo. The simulator reduces October expenses by RM500, producing RM1,901.70 net change and RM24,177.70 calculated closing balance without saving transactions. The main report frame shows four of seven expense categories; its percentages use all RM2,778.30 of October expenses.

The receipt walkthrough submitted the exact approved image to the real Windows OCR engine. The title, 13 October 2026 and MYR suggestions matched the receipt, but the parser did not auto-fill a total and retained its warnings. RM12.50 was entered through the native review field after checking the image. Confirmation remained unchecked, Save remained disabled, and cancelling preserved financial and photo bytes. This demonstrates manual review of an incomplete suggestion; it does not claim automatic total detection or general OCR accuracy. The Firebase-emulator gallery view stops at a preview with one selected photo and is cancelled without uploading; the separate backup/restore walkthrough above establishes those operations.

The assistant view comes from a real local Qwen response through Lemonade using its Vulkan backend. Only base period facts and the optional expense-category group were selected. The question, “Explain my expenses.”, produced an answer citing Bills & utilities at RM1,227.60 and 44.19%, Food & beverages at RM517.80 and 18.64%, and Shopping at RM357.90 and 12.88%. It correctly distinguished RM2,778.30 expenses from RM400.00 debt payments and RM3,178.30 total outflow. The actual native request, provider response, displayed answer and cited facts were compared, and the response passed independent semantic review. This verified answer does not establish that future model explanations will be correct.

The Prophet view uses an as-of date of 18 October 2026 and the actual 18 completed expense months through September. October's partial expenses are excluded from training. All six displayed outputs matched the bound native response, including provider provenance. The separate device projection remains labelled beside each estimate:

| Future month  | Local Prophet estimate | Device estimate |
| ------------- | ---------------------- | --------------- |
| November 2026 | RM2,691.42             | RM2,644.00      |
| December 2026 | RM2,694.18             | RM2,644.00      |
| January 2027  | RM2,697.04             | RM2,644.00      |
| February 2027 | RM2,699.90             | RM2,644.00      |
| March 2027    | RM2,702.48             | RM2,644.00      |
| April 2027    | RM2,705.34             | RM2,644.00      |

These values demonstrate the completed request and display flow on fictional data, not real-world predictive accuracy. Neither method changes the saved ledger.

The Android app generated a genuine two-page October report PDF. Both pages passed visual review, with 23 period transactions, RM4,580.00 income, RM2,778.30 expenses, RM400.00 debt payments and RM1,401.70 net change. Opening and closing balances reconcile to RM22,276.00 and RM23,677.70. The gallery's page-one rendering is identified as exported document output. PDF generation and extraction preserved the financial and managed-photo bytes.

## Reproduce the source checks

From the repository root, using the Node version in `.node-version`:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run check
npm.cmd run test:python
```

The last command requires Python 3.12 or newer as `python`. The JavaScript gate includes application, companion, Auth-helper and backend tests, followed by TypeScript. It uses synthetic inputs, isolated loopback fixtures and injected native/provider effects. The Python command includes companion, Auth lifecycle and backend supervisor suites; it does not install or fit Prophet.

Optional suites have separate prerequisites and commands:

- [Firebase emulator rules and SDK round trip](tools/firebase-backup/README.md): local Auth, Firestore and Storage, isolated demo project and enforced loopback-only verification.
- [Deployable backend loopback checks](tools/backend/README.md): an injected OpenAI response and a separate actual local Flask/Prophet fit; neither establishes live hosted-provider access.
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
- Native Linux/container execution, a built Docker image and public backend deployment remain unverified. Mocked Linux supervisor checks and real Windows execution have separate scopes.
- No iOS, physical Android device, production signing, distributed APK, full screen-reader audit or clean-computer setup is claimed.
- Map/network availability and device power policies depend on the target environment. Earlier feature checks retain their own scope in the historical record.
- Local checks cannot establish that every future provider response or interrupted device write will succeed. The guides explain bounded inputs, stale-session rejection, pending-operation recovery and known setup requirements.
