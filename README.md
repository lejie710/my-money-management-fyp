# My Money Management

A React Native money-management project rebuilt from a 2024 final-year project, with an emphasis on clear financial calculations, recoverable local data and readable mobile interfaces. It is intended as an Android educational reference for students studying a complete application.

The ordinary app starts with an **empty device-local wallet**. You can record income, expenses and debt payments without signing in or running a separate service. Existing saved wallets and earlier supported data are preserved when reopening or migrating; a change to the first-launch default does not replace them.

## What works where

| Capability                  | Current implementation                                                                                            | Requirements and boundaries                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Everyday finances           | Transactions, eight currencies, categories, calendar budgets, one savings goal and reconciled reports             | Device-local records and exact minor-unit amounts; no account or server required                             |
| Calculators and projections | Illustrative cash-flow score, what-if simulator, loan repayment schedule and six-month recorded-expense forecast  | Calculations run on the device; estimates do not change saved finances                                       |
| Native tools                | Achievements, reminders, transaction photos, selected contact/place labels, PDF export and transaction-summary QR | Installed project app and relevant permissions; map tiles/address lookup need network/provider availability  |
| Optional accounts           | Registration, sign-in, profile and local password reset through a Windows Firebase Auth emulator                  | Separate device-local wallets per account; no delivered reset email or cloud financial synchronization       |
| Receipt recognition         | Windows OCR, editable suggestions and explicit expense confirmation                                               | A paired Windows companion; manual entry remains available                                                   |
| Financial assistant         | A Windows-hosted local model explains selected calculated report facts                                            | Prepared local model assets and a paired companion; read-only, with no cloud fallback                        |
| Original service options    | Hosted Firebase, Firestore/Storage, OpenAI, Google Cloud Vision and Flask/Prophet                                 | **Planned implementation work**, not features that become available by adding keys or changing configuration |

[Original service integrations](docs/ORIGINAL_SERVICE_INTEGRATIONS.md) records the original provider direction, the current local alternatives and the contracts, backend work and verification still required. No original account, API key or paid service is needed for the current local wallet.

## Find your way around

- **Activity:** add and review transactions, with an all-date balance distinct from the selected month's activity.
- **Plan:** manage category budgets and a savings target without moving or reserving money.
- **Reports:** inspect applied-period balances, export a PDF, simulate changes and explore an eligible expense forecast.
- **Wallet → Tools → Connections:** discover optional accounts, receipt recognition and the financial assistant. Receipt review and manual entry remain reachable without a companion. Choose a report before opening the assistant, so it uses the report's applied dates.

Configured services add useful shortcuts to the relevant screens. A configured connection means its settings are present; availability is checked when the feature is requested. The main header stays focused on the wallet and shows meaningful action or recovery feedback without a permanent readiness message.

The [UI guide](docs/UI_DESIGN.md) describes the Apple-inspired grouping, platform fonts, readable amounts and keyboard-aware sheets. The current local workflow has passed an Android walkthrough. **The screenshot gallery is pending completion of the required optional integrations.** Gallery screenshots will use fictional records with their illustrative purpose disclosed.

## Run and study the Android app

Start with [Android setup](docs/ANDROID_SETUP.md) for the supported Windows toolchain, Android project generation, native build/install steps and first launch. The development baseline uses Node 24.22.0, JDK 17 and Expo SDK 58; dependencies are pinned in `package-lock.json`.

From this repository's root, install the pinned dependencies:

```powershell
npm.cmd ci --ignore-scripts
```

After following the native build/install guide, launch the installed debug app:

```powershell
npm.cmd run android -- --project-app
```

The tracked launcher expects the configured `FYP_API35` emulator and Metro on port 8081. It verifies the installed app and this checkout before opening it. New project-app emulator starts skip VM snapshots while retaining installed apps and userdata; an already-running emulator is reused. Keep Metro running while using the debug app.

Expo Go can preview a subset of the app, but it does not provide all required native capabilities, including the project's PDF repair. It also has separate saved data from the installed app. Do not uninstall an app or clear its storage to switch preview modes.

A freshly generated Android project from this source completed its debug build and an API 35 emulator walkthrough on 18 October 2026, including persistence and native PDF generation. This used an existing Windows toolchain and dependency caches; it does not establish setup on a clean computer. See [Verification](VERIFICATION.md) for the exact checks and limits. No production APK is distributed here, and iOS work is deferred.

For a practical reading path, start with [Architecture](docs/ARCHITECTURE.md). It follows one expense from the editor through validation, confirmed storage and calculated reports, with a worked exercise.

Optional services have separate setup guides:

- [Local Auth emulator](tools/auth-emulator/README.md)
- [Windows OCR and local-model companion](scripts/companion/README.md)

## Source checks

Run the application, companion and Auth-helper JavaScript suites, then check TypeScript:

```powershell
npm.cmd run check
```

With Python 3.12 or newer available as `python`, run `npm.cmd run test:python` for the two optional-helper Python suites. These checks use synthetic data and injected native/provider effects. They do not replace actual Android rendering, persistence, permissions, PDF/QR output, OCR or model verification. Hosted CI has not been verified for this repository.

## Feature guides

| Topic                               | Read more                                                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Money, dates and persistence        | [Wallet and ledger](docs/WALLET_LEDGER.md), [Budgets and goals](docs/BUDGETS_AND_GOALS.md)                                                                                                    |
| Reports and calculations            | [Financial reports](docs/FINANCIAL_REPORTS.md), [Score and simulator](docs/HEALTH_AND_SIMULATOR.md), [Loan calculator](docs/LOAN_CALCULATOR.md), [Monthly forecast](docs/MONTHLY_FORECAST.md) |
| Device features and sharing         | [Achievements and reminders](docs/ACHIEVEMENTS_AND_REMINDERS.md), [Transaction details](docs/TRANSACTION_CONTEXT.md), [PDF and QR](docs/PDF_AND_QR.md)                                        |
| Optional account and model features | [Account access](docs/ACCOUNT_ACCESS.md), [Receipt capture](docs/RECEIPT_CAPTURE.md), [Financial assistant](docs/FINANCIAL_ASSISTANT.md)                                                      |

## Scope and data

This is an educational development project, not a verified production financial service. The score is illustrative, forecast error describes a bounded historical comparison, and generated explanations can be wrong. See the feature guides for the exact assumptions and [Dependency notes](DEPENDENCY_NOTES.md) for compatibility and audit history.

Keep real records, credentials, connection tokens, emulator exports, model files and generated runtime data out of source control. The current financial stores remain on the device; optional Auth exports do not back up those wallets or photos. The original submission archive and report are not included in this repository.

Developed with assistance from AI tools.

Project code is available under the [MIT license](LICENSE); preserve the [third-party notices](THIRD_PARTY_NOTICES.md) when reusing it.
