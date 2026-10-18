# My Money Management

My Money Management is a personal finance app I originally developed for my 2024 final-year project. I have since refined its financial calculations, data recovery and mobile interface, with expense tracking, budgeting, reports, receipt recognition and forecasting.

The ordinary app starts with an **empty device-local wallet**. You can record income, expenses and debt payments without signing in or running a separate service. Existing saved wallets and earlier supported data are preserved when reopening or migrating; a change to the first-launch default does not replace them.

## Screenshots

Everyday tracking, planning and analysis, followed by optional connected tools. All financial records shown are fictional; a fresh installation starts with an empty wallet.

### Record and plan

| Activity                                                                                                                           | Transaction details                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a href="docs/images/activity.png"><img src="docs/images/activity.png" alt="Wallet balance and recorded activity" width="320"></a> | <a href="docs/images/transaction-details.png"><img src="docs/images/transaction-details.png" alt="A transaction with its selected photo and details" width="320"></a> |
| Review the wallet balance and recorded income, expenses and debt payments.                                                         | Keep a receipt photo and optional details with an ordinary transaction.                                                                                               |

| Category budgets                                                                                                                         | Savings goal                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| <a href="docs/images/plan.png"><img src="docs/images/plan.png" alt="Category budget with spending and remaining amount" width="320"></a> | <a href="docs/images/goal.png"><img src="docs/images/goal.png" alt="Savings goal progress from the recorded wallet balance" width="320"></a> |
| Compare category spending with its own budget, dates and remaining amount.                                                               | Follow progress toward a savings target using the recorded wallet balance.                                                                   |

### Understand and explore

| Reports                                                                                                                                                         | What-if simulator                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| <a href="docs/images/reports.png"><img src="docs/images/reports.png" alt="Recorded expenses and category shares for the applied report period" width="320"></a> | <a href="docs/images/simulator.png"><img src="docs/images/simulator.png" alt="Hypothetical cash-flow scenario and illustrative score" width="320"></a> |
| The leading four of seven October expense categories. Shares use the full RM2,778.30 expense total.                                                             | Explore how RM500 less in October expenses changes the calculated result, without changing saved records.                                              |

| Loan calculator                                                                                                                    | Expense forecast                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| <a href="docs/images/loan.png"><img src="docs/images/loan.png" alt="Loan payment calculation with applied inputs" width="320"></a> | <a href="docs/images/forecast.png"><img src="docs/images/forecast.png" alt="Local Prophet comparison for completed monthly expense history" width="320"></a> |
| Calculate fixed-rate payments, interest and repayment totals from explicit inputs.                                                 | Six local Prophet estimates trained on 18 completed expense months through September 2026, shown beside the device method.                                   |

### Capture, explain and preserve

| Receipt review                                                                                                                                                                | Financial assistant                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| <a href="docs/images/receipt.png"><img src="docs/images/receipt.png" alt="Windows OCR receipt review with a manually entered total and recognition warnings" width="320"></a> | <a href="docs/images/assistant.png"><img src="docs/images/assistant.png" alt="Local-model explanation of selected report facts" width="320"></a> |
| Windows OCR suggested the title, date and currency. No total was auto-filled; RM12.50 was entered manually after checking the receipt.                                        | Ask the local model about selected calculated facts; its answer cannot change finances.                                                          |

| Backup preview                                                                                                                                                            | Exported report                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| <a href="docs/images/cloud-backup.png"><img src="docs/images/cloud-backup.png" alt="Manual Firebase backup preview including the selected receipt photo" width="320"></a> | <a href="docs/images/report-export.png"><img src="docs/images/report-export.png" alt="First page of a two-page PDF report generated by the Android app" width="320"></a> |
| Preview the wallet and selected receipt photo before a manual backup. This local-emulator preview was cancelled without uploading.                                        | First page of the two-page October report exported by the Android app and rendered locally for readability.                                                              |

The connected tools use Windows OCR, a local Qwen model and local Prophet. The backup preview uses Firebase emulators. The exported report is a rendered PDF page; the other views are native Android captures. Open an image for its full resolution. The [UI guide](docs/UI_DESIGN.md#native-android-gallery) includes Wallet, period balances and the device forecast; [Verification](VERIFICATION.md) records the completed checks and limits.

## What works where

| Capability                   | Current implementation                                                                                                    | Requirements and boundaries                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Everyday finances            | Transactions, eight currencies, categories, calendar budgets, one savings goal and reconciled reports                     | Device-local records and exact minor-unit amounts; no account or server required                                             |
| Calculators and projections  | Illustrative cash-flow score, what-if simulator, loan repayment schedule and six-month recorded-expense forecast          | Calculations run on the device; estimates do not change saved finances                                                       |
| Native tools                 | Achievements, reminders, transaction photos, selected contact/place labels, PDF export and transaction-summary QR         | Installed project app and relevant permissions; map tiles/address lookup need network/provider availability                  |
| Optional accounts and backup | Firebase sign-in, separate account wallets, explicit guest-wallet copying, and manual backup/restore with optional photos | Configure your own Firebase project or the documented local emulators; ordinary edits stay on the device                     |
| Receipt recognition          | Windows OCR or Google Cloud Vision, followed by editable suggestions and explicit expense confirmation                    | A paired companion; cloud recognition requires explicit selection and your own host-side key; manual entry remains available |
| Financial assistant          | Local-model or OpenAI explanations of selected calculated report facts                                                    | A paired companion and the chosen provider's prerequisites; read-only responses do not change finances                       |
| Optional Prophet forecast    | Flask/Prophet evaluates completed monthly expense history and returns an alternative projection                           | Explicit paired Windows service with its own Python environment; the device forecast remains available                       |

[Original service integrations](docs/ORIGINAL_SERVICE_INTEGRATIONS.md) explains how Firebase, OpenAI, Google Vision and Flask/Prophet fit alongside the local experience. Each option requires deliberate configuration. No original account, API key or paid service is needed for the ordinary wallet. Hosted Firebase and live OpenAI/Vision calls remain unverified; the verification record separates local, emulated and injected-provider checks.

## Find your way around

- **Activity:** add and review transactions, with an all-date balance distinct from the selected month's activity.
- **Plan:** manage category budgets and a savings target without moving or reserving money.
- **Reports:** inspect applied-period balances, export a PDF, simulate changes and explore an eligible expense forecast.
- **Wallet > Connections (under Tools):** discover optional accounts, cloud backup, receipt recognition, the financial assistant and Prophet setup. Receipt review and manual entry remain reachable without a companion. Choose a report before opening the assistant, so it uses the report's applied dates.

Configured services add useful shortcuts to the relevant screens. A configured connection means its settings are present; availability is checked when the feature is requested. The main header stays focused on the wallet and shows meaningful action or recovery feedback without a permanent readiness message.

The [UI guide](docs/UI_DESIGN.md) describes the Apple-inspired grouping, platform fonts, readable amounts and keyboard-aware sheets, with additional native screens. [Verification](VERIFICATION.md) records the completed local and optional-service walkthroughs and their limits.

## Run the Android app

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

- [Firebase account and manual-backup setup](tools/firebase-backup/README.md)
- [Standalone local Auth emulator](tools/auth-emulator/README.md), when cloud backup is not configured
- [Windows companion and provider selection](scripts/companion/README.md)
- [Flask/Prophet service and local verification](tools/forecast/README.md)

## Source checks

Run the application, companion and Auth-helper JavaScript suites, then check TypeScript:

```powershell
npm.cmd run check
```

With Python 3.12 or newer available as `python`, run `npm.cmd run test:python` for the two optional-helper Python suites. These checks use synthetic data and injected native/provider effects. They do not replace actual Android rendering, persistence, permissions, PDF/QR output, OCR or model verification. Hosted CI has not been verified for this repository.

The optional Flask/Prophet service and Firebase emulator checks have separate prerequisites and verification commands in their guides. It is not installed or tested by the default JavaScript gate or `test:python` command.

## Feature guides

| Topic                               | Read more                                                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Money, dates and persistence        | [Wallet and ledger](docs/WALLET_LEDGER.md), [Budgets and goals](docs/BUDGETS_AND_GOALS.md)                                                                                                    |
| Reports and calculations            | [Financial reports](docs/FINANCIAL_REPORTS.md), [Score and simulator](docs/HEALTH_AND_SIMULATOR.md), [Loan calculator](docs/LOAN_CALCULATOR.md), [Monthly forecast](docs/MONTHLY_FORECAST.md) |
| Device features and sharing         | [Achievements and reminders](docs/ACHIEVEMENTS_AND_REMINDERS.md), [Transaction details](docs/TRANSACTION_CONTEXT.md), [PDF and QR](docs/PDF_AND_QR.md)                                        |
| Optional account and model features | [Account access](docs/ACCOUNT_ACCESS.md), [Receipt capture](docs/RECEIPT_CAPTURE.md), [Financial assistant](docs/FINANCIAL_ASSISTANT.md)                                                      |

## Scope and data

The project has not been verified as a production financial service. The score is illustrative, forecast error describes a bounded historical comparison, and generated explanations can be wrong. See the feature guides for the exact assumptions and [Dependency notes](DEPENDENCY_NOTES.md) for compatibility and audit history.

Keep real records, credentials, connection tokens, emulator exports, model files and generated runtime data out of source control. Financial records remain on the device until you explicitly confirm a cloud backup. A backup can include selected photo attachments; Auth-emulator exports alone do not back up wallets or photos. Assistant and receipt actions disclose their selected local or cloud provider before sending the chosen facts or image. The original submission archive and report are not included in this repository.

Developed with assistance from AI tools.

Project code is available under the [MIT license](LICENSE); preserve the [third-party notices](THIRD_PARTY_NOTICES.md) when reusing it.
