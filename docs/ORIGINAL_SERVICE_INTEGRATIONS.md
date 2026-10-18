# Original service integrations and implementation plan

The original FYP explored Firebase accounts and cloud records, OpenAI explanations, Google Cloud Vision receipt recognition, and a Flask/Prophet forecasting service. These remain useful extension options for this project. The restored application currently demonstrates the financial workflows with device-local records and optional local services; it does not yet restore those hosted integrations.

This document separates existing implementation from planned work. It is an integration plan, not a set of credentials that enables finished cloud features. The original submission, old service configuration, and unused assets are not part of the public application. No access to an original account or project is needed to study or run the local version.

The repository now includes independently reviewed, offline-tested server adapters for [OpenAI](../scripts/companion/assistant/OPENAI.md) and [Google Vision](../scripts/companion/ocr/GOOGLE_VISION.md). They are not imported by the running companion, advertised by pairing, or accepted by the current mobile response validators. Their presence preserves useful provider integration code; it does not make the app configuration-ready for either provider.

## Current capability and original direction

| Area | Original submission approach | Implemented in this repository | Work required for the original service option |
| --- | --- | --- | --- |
| Accounts | Firebase email/password registration, sign-in, profile updates, and password-reset email | Optional Firebase Auth emulator, guarded session restoration, local profiles, separate account/guest wallets, and a local reset inbox | A separately configured hosted Auth adapter, provider-specific session isolation, real reset-email handling, and an explicit setup/verification guide |
| Financial records | Firestore collections for users, wallets, transactions, categories, budgets, loans, achievements, and alerts | Validated device-local ledger with exact minor-unit amounts, migrations, and owner-scoped storage | Firestore schema, access rules, synchronization semantics, conflict/retry handling, migration tooling, and emulator tests |
| Photos | Firebase Storage uploads with download URLs saved in transaction records | Validated app-owned local attachments and conservative cleanup | Owner-scoped cloud object paths and rules, opt-in upload/download, durable references, and recovery for partial uploads and deletions |
| Explanations | Direct mobile requests to OpenAI Chat Completions with financial context | Read-only local model through the Windows companion; inactive OpenAI adapter with selected-facts validation and bounded transport | Companion configuration/routes, provider-aware pairing and mobile response contracts, destination disclosure, usage controls, and separate evaluation |
| Receipt recognition | Direct mobile requests to Google Cloud Vision text detection | Windows OCR through the companion; inactive Vision adapter with bounded transport and normalized text/geometry | Provider-aware companion/mobile contracts, image-limit messaging, cloud-processing disclosure, and separate evaluation |
| Forecasting | Flask endpoint fitting Prophet to submitted values | Six-month device calculation comparing three transparent methods against earlier months | An optional Flask/Prophet service with explicit monthly semantics, validated inputs/outputs, evaluation against the existing baselines, and separate UI provider/result state |

The original Firebase Functions directory contained a starter scaffold rather than an implemented proxy for these services. Archived screen code establishes the intended integrations, not a tested backend or a deployment-ready security model. The restored account, receipt, assistant, and forecast guides describe the currently working paths:

- [Account access](ACCOUNT_ACCESS.md)
- [Transaction details and photos](TRANSACTION_CONTEXT.md)
- [Receipt capture](RECEIPT_CAPTURE.md)
- [Financial assistant](FINANCIAL_ASSISTANT.md)
- [Monthly forecast](MONTHLY_FORECAST.md)

## Keep optional services explicit

The ordinary wallet, transaction editor, budgets, reports, simulator, loan calculator, and device forecast must continue to work without a cloud account or paid API. Cloud storage, hosted explanations, and hosted recognition should be separate opt-in choices. Signing in must not silently upload a guest wallet or existing photos.

The current flags `EXPO_PUBLIC_LOCAL_AUTH_EMULATOR=1` and `EXPO_PUBLIC_LOCAL_COMPANION=1` enable their documented local development paths. They do not select hosted Firebase, OpenAI, or Vision. Adding Firebase-style environment variables to the current application will not implement cloud synchronization. Changing the companion URL will not work: its connection and transport validators deliberately accept only the paired local endpoint, and assistant responses identify the expected local provider.

Future configuration should select an explicit capability and provider, validate all required settings before activation, and otherwise leave that capability unavailable with a useful explanation. Do not automatically switch from a failed local service to a paid provider. Do not put a configuration form for private provider keys inside the mobile application.

OpenAI and Vision can reuse the paired Windows companion as their gateway. Android would keep its existing private local connection, and only the Windows process would contact the selected provider. This path does not require cloud ledger storage or a new public backend deployment. It still requires explicit provider metadata, per-run authorization, mobile validation changes and a visible destination before each request.

| Proposed configuration boundary | Values it may contain | Values it must not contain |
| --- | --- | --- |
| Mobile public configuration | Enabled capabilities, non-secret Firebase client configuration for a deliberately selected project, and the application's backend origin | OpenAI keys, Google service-account credentials, privileged Firebase credentials, or reusable backend administrator tokens |
| Private backend configuration | Provider credentials, approved model identifier, request limits, project/service bindings, and permitted upstream endpoints | Copied original accounts, credentials committed to source, or real user data used as a setup example |
| Runtime session | Short-lived authenticated application session and bounded requests tied to its owner | A provider key substituted for user authorization or an unverified user ID supplied by a client |

These are proposed boundaries, not additional environment variables supported by the current code. Firebase client configuration is not a substitute for authentication and access rules. Anything named `EXPO_PUBLIC_*` can be included in the mobile bundle; an environment file does not turn a bundled value into a secret.

## Firebase Auth, Firestore, and Storage

The existing account coordinator already pauses financial operations during identity changes and restores each confirmed owner separately. Preserve that behavior when adding hosted Auth. The current [Firebase adapter](../src/accounts/firebaseAdapter.js) is intentionally tied to the local emulator and should remain an independently testable option.

Required implementation work:

1. Add a hosted Auth adapter behind the account interface, with explicit initialization and separate persistence from the emulator. Validate the intended Firebase project before restoring its session. Replace emulator-only reset-inbox behavior with hosted reset-email states; do not treat successful request submission as proof that an email arrived.
2. Extend identity/storage ownership to include provider and project identity as well as user ID. The present [identity module](../src/accounts/identity.js) supports the single local Firebase environment. Reusing a UID from another project must not expose an existing wallet, attachment, reminder, or export session.
3. Define the Firestore representation of the current ledger: schema version, currency, integer minor-unit amounts, calendar dates, category references, budgets, goal, wallet identity, and relevant milestone evidence. The old floating-point transaction fields and mixed date representations are not an automatic import format.
4. Define explicit synchronization behavior before writing it. Separate pending local changes from confirmed remote writes, use stable operation IDs and revision checks, and preserve uncertain outcomes for reconciliation. A timeout must not become a second transaction. Concurrent edits must not silently overwrite each other or merge conflicting monetary values by accident.
5. Add Firestore and Storage access rules that enforce the authenticated owner on reads and writes, along with allowed fields and bounded values. A filtered client query is not an access-control rule. Several archived screens used broad collection reads; copying those screens does not establish account isolation.
6. Add cloud-photo lifecycle handling separately from local files. Require explicit upload consent, scope object paths to the confirmed owner, and keep enough reference state to recover an upload that succeeded before its transaction write failed. Do not replace the existing validated local-photo reference with an arbitrary download URL.
7. Make importing a device wallet into a cloud account a deliberate, previewable operation. Export or preserve source records, detect repeated imports, validate every record, and report unsupported data. Do not connect to an old project to obtain migration fixtures.

Start verification with synthetic users in the Auth, Firestore, and Storage emulators. Test owner A versus owner B, unauthenticated access, forged ownership fields, equal UIDs in separate provider/project scopes, interrupted session changes, offline edits, concurrent updates, duplicate delivery, deletion recovery, missing objects, invalid schemas, and retained guest data. Passing client tests alone does not prove the access rules work.

## OpenAI explanations

Preserve the original OpenAI option through a server-side adapter. The archived mobile screen called the provider directly and assembled broad user/profile/transaction context. The restored [grounding module](../src/assistant/grounding.js) instead prepares selected calculated facts, and the [session gate](../src/assistant/sessionGate.js) prevents an old response appearing under a different owner. Those boundaries should remain.

Required implementation work:

1. Connect the implemented server adapter to an explicitly configured, authenticated companion route. Keep the credential in the Windows process, validate the private application session and request size before dispatch, and advertise only non-secret provider/model metadata. A configurable model must be deliberately selected and support the adapter's structured-output contract; the archived model name is not a current compatibility guarantee.
2. Reuse the selected-facts request contract while making provider identity explicit. Adapt the [assistant protocol](../src/assistant/protocol.js) and [client](../src/assistant/client.js) through deliberate versioned contracts; do not bypass their local-provider checks or impersonate the local model in a cloud response.
3. Show which selected facts and question will leave the device, then send only after Ask. Exclude unselected transactions, receipt images, raw OCR, person/place details, and account profile information. Generated text remains separate from calculated amounts and cannot write the ledger.
4. Bound input/output, response time, concurrency, and per-user usage. Preserve request IDs and cancellation/stale-response protection. A network timeout or UI cancellation does not prove that a provider stopped computation or avoided charging; do not retry automatically on that assumption.
5. Map unavailable service, rejected credentials, rate limits, invalid responses, incomplete output, and provider refusal to useful states that retain the calculated facts. Keep provider payloads and credentials out of public logs.

Use injected responses to test request minimization, authorization, malformed output, stale-owner rejection, cancellation, rate limiting, and unchanged saved bytes. Run the existing financial-question cases against the selected hosted model only after separate live-service authorization. A correct response to one question or an HTTP health check is not an answer-quality evaluation.

## Google Cloud Vision receipt recognition

Keep the existing image-selection and review flow. The Vision option should replace only the recognition provider behind a server route, not bypass confirmation or save provider guesses directly to the ledger.

Required implementation work:

1. Connect the implemented server adapter to the authenticated companion route, accepting a supported image only after an explicit recognition request and cloud-processing disclosure. Keep the credential in the Windows process. The adapter's 6 MiB raw-image limit must also be enforced and explained in the mobile flow; the existing local provider permits a different limit. Do not place a provider key in a mobile URL or public environment variable.
2. Normalize Vision words, lines, bounding geometry, image dimensions, and language information into the shape validated by [the receipt module](../src/core/receipt.js). Add an explicit provider identifier through a reviewed contract change where required. Missing, partial, or unsupported OCR geometry must be handled rather than fabricated.
3. Retain alternatives for ambiguous totals, dates, and currencies. The user selects a category, checks the suggestions, and confirms an ordinary expense. Recognition and optional photo retention remain distinct decisions.
4. Bound temporary image retention, decode/processing sizes, request time, concurrency, and usage. Define cleanup after success, failure, cancellation, and uncertain shutdown. Do not copy the archived raw-image, receipt-field, upload-URL, or provider-error logging.

Use invented receipt images for empty results, multiple totals, ambiguous dates, different currency precision, oversized files, unsupported formats, provider errors, and cancellation. Verify that failed recognition never creates an expense and that one explicit confirmation creates one expense. Measure Vision parsing quality separately from the existing Windows OCR evidence; the same parser does not establish equal provider results.

## Flask and Prophet forecasts

Preserve Prophet as an optional forecasting method alongside the existing device calculation. The archived service fitted submitted values and requested 180 future daily periods, while the mobile screen supplied monthly totals and rendered month labels. It also returned history with predictions. That combination must be corrected before calling the result a six-month forecast.

Required implementation work:

1. Define one versioned request with currency, selected expense category, as-of date, completed-month series, and requested forecast months. Validate ordering, duplicates, missing calendar months, finite nonnegative values, input size, and sufficient history. Exclude income, debt payments, the partial month, and future records consistently with the current feature.
2. Pin compatible Python, Flask, pandas, and Prophet dependencies in a reproducible optional service. Start with a loopback development service; disable Flask's debug server behavior in any shared deployment. Add explicit authentication, allowed origins where relevant, request limits, and fixed diagnostic messages before exposing an endpoint.
3. Fit monthly data at explicit monthly intervals and return only the requested future month rows. Keep history and the excluded partial month separate. The current device feature skips the partial as-of month, so its six displayed projections have leads two through seven from the last completed training month; any comparison must use those same target months.
4. Convert between integer minor units and model input deliberately. Preserve whole-yen behavior, reject nonfinite responses, and document rounding and treatment of negative predictions. Do not silently clamp forecasts or relabel prediction intervals as guaranteed spending ranges.
5. Show Prophet as a distinct method with its own parameters and evaluation. Compare it with the existing last-value, trailing-mean, and damped-trend baselines on the same historical targets, without training on target-period data. Report the evaluated horizon and dates. Historical error does not establish future accuracy.

Tests should cover month-end/year-boundary handling, zero months, insufficient history, duplicate dates, gaps, future-data leakage, six correctly aligned outputs, interval ordering when available, currency rounding, timeout, malformed responses, and no changes to saved records. Run an actual pinned Prophet fit on synthetic data before marking the option implemented. A stubbed response or installation success does not satisfy that gate.

## Delivery sequence and completion evidence

| Stage | Deliverable | Evidence needed before calling it complete |
| --- | --- | --- |
| 1. Contracts and configuration | Explicit provider modes, disabled defaults, owner/project identity, request/response schemas, and placeholder-only setup examples | Configuration rejection tests; ordinary local workflows still run with no provider credentials |
| 2. Firebase accounts and records | Hosted Auth adapter, Firestore rules/schema/synchronization, optional Storage ownership | Emulator isolation and recovery tests; documented migration boundaries; separately authorized hosted checks if hosted support is claimed |
| 3. Provider gateway | Authenticated application backend with server-only credentials and bounded requests | Rejected unauthenticated requests, request minimization, redacted failures, limits, and no secret values in the mobile bundle or repository |
| 4. OpenAI and Vision adapters | Independently selectable explanation and OCR providers using the restored review/session safeguards | Contract tests plus separately authorized synthetic live evaluations; actual provider and model/version recorded |
| 5. Prophet service | Optional monthly forecasting endpoint and clearly labelled result comparison | Reproducible installation, actual fit, calendar/rounding tests, matched historical evaluation, and unchanged ledger |
| 6. Android integration | Documented setup and actual device/emulator workflows for the enabled options | Successful request, unavailable service, cancellation, owner change, restart, and privacy checks for each enabled provider |

Source implementation, deployment, live-provider verification, and public publication are separate steps. This plan creates no cloud project, enables no billing, uses no original credentials, and makes no paid request. Anyone enabling a hosted option must supply their own deliberately configured services and approve its data transfer and spending limits. iOS remains deferred; Android evidence must not be presented as iOS verification.

## Worked scope check

A visitor clones the project with no cloud configuration. They should still be able to add an expense, inspect budgets and reports, use the simulator and loan calculator, and obtain an eligible device forecast. Hosted Auth, synchronization, OpenAI, and Vision must remain unavailable until their implementations and explicit setup are complete. The documented local Auth/OCR/model options remain separate choices.

If the visitor later enables hosted OpenAI but leaves cloud storage off, asking about a report should transmit only the selected facts and question through the authenticated backend. It must not upload the wallet, enable Vision, migrate the account, or save the answer as a transaction. This is the boundary each future integration should preserve.
