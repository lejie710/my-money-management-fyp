# My Money Management

My Money Management is an Android personal finance app built with React Native and Expo. I first developed it for my 2024 final-year project, then revisited it in 2026 to improve the calculations, data recovery and mobile interface. It includes expense tracking, budgets, reports, receipt recognition and forecasting.

The optional connected features use Firebase, OpenAI, Google Cloud Vision and Flask/Prophet, which were also part of the original project. Firebase stores account records and attached photos. A separate backend handles assistant, receipt-recognition and forecast requests. For the hosted route, use your own Firebase project and private server configuration.

A fresh installation opens an empty guest wallet on the device. Transactions, budgets, reports and device calculations work without an account or server. Signing in opens a separate account wallet. Copying guest records requires a preview and confirmation, and existing supported device wallets are kept.

Browse the [screenshots](#screenshots), follow an expense through the [architecture](docs/ARCHITECTURE.md), read the [verification record](VERIFICATION.md), or use [Android setup](docs/ANDROID_SETUP.md) to run the development app.

This is a portfolio and development project. Native walkthroughs used an Android emulator. A production APK is not distributed here, and public backend deployment and live OpenAI/Google Vision calls have not been verified. Setup requirements and testing limits are listed below.

## Screenshots

The screenshots use fictional financial records; a fresh installation starts empty. They show real Android screens and the first page of an app-generated report. Captions identify the service used for each connected feature.

### Record and plan

| Activity                                                                                                                           | Transaction details                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a href="docs/images/activity.png"><img src="docs/images/activity.png" alt="Wallet balance and recorded activity" width="320"></a> | <a href="docs/images/transaction-details.png"><img src="docs/images/transaction-details.png" alt="A transaction with its selected photo and details" width="320"></a> |
| View the all-date wallet balance and select October 2026 activity, containing 23 recorded entries.                                 | Keep a receipt photo and optional details with an ordinary transaction.                                                                                               |

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

| Receipt review                                                                                                                                                                | Financial assistant                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a href="docs/images/receipt.png"><img src="docs/images/receipt.png" alt="Windows OCR receipt review with a manually entered total and recognition warnings" width="320"></a> | <a href="docs/images/assistant.png"><img src="docs/images/assistant.png" alt="OpenAI assistant question form before submission" width="320"></a> |
| Windows OCR suggested the title, date and currency. No total was auto-filled; RM12.50 was entered manually after checking the receipt.                                        | Review the applied dates and selected financial summaries before asking OpenAI. The question form is shown before submission; no generated answer is displayed.                 |

| Backup preview                                                                                                                                                            | Exported report                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a href="docs/images/cloud-backup.png"><img src="docs/images/cloud-backup.png" alt="Manual Firebase backup preview including the selected receipt photo" width="320"></a> | <a href="docs/images/report-export.png"><img src="docs/images/report-export.png" alt="First page of a three-page Android-exported report covering April 2025 to October 2026" width="320"></a> |
| Preview the wallet and selected receipt photo before confirming a separate recovery backup. This view uses local Firebase emulators.                                      | First of three pages of the app-exported report for April 2025 through October 2026, covering 277 transactions and 19 monthly rows. Rendered locally for readability.                          |

The captions distinguish local Windows OCR and Prophet runs from the OpenAI form before submission and the Firebase-emulator preview. Eleven images are native Android captures; the report image is a faithful rendering of the exported PDF page. Click an image for full resolution. The [UI guide](docs/UI_DESIGN.md#native-android-gallery) has three more views from an earlier checkpoint, and [Verification](VERIFICATION.md) records the checks behind them.

## What works where

| Capability                   | Implementation                                                                                                                                            | Setup and limits                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Guest finances               | Transactions, eight currencies, categories, calendar budgets, one savings goal and reconciled reports                                                     | Device-local records with exact minor-unit amounts; no account or server required                                                             |
| Firebase account wallet      | Auth, everyday Firestore records, account-owned Storage attachments, confirmed device-wallet copying and manual backups                                  | Use your own Firebase project. Saves need server confirmation. Offline viewing uses the last confirmed copy; offline edits are not merged automatically |
| Financial assistant          | OpenAI explains selected summaries and suggests budgeting/saving changes; dates and comparisons are editable, and conversation history stays on the device | Configure the authenticated backend and a compatible model. The assistant cannot make financial changes                                      |
| Receipt recognition          | Google Cloud Vision supplies editable suggestions; the user reviews the image, amount, date, currency and category before saving                          | Explicit recognition request through the configured backend; photo retention is a separate choice                                             |
| Prophet forecast             | Flask/Prophet projects six future expense months from completed monthly totals                                                                            | Configured backend with its Python environment; a separate device calculation remains available offline                                       |
| Calculators and native tools | Illustrative cash-flow score, what-if simulator, loan schedule, achievements, reminders, photos, selected contact/place labels, PDF export and QR sharing | Installed project app and relevant permissions; map tiles/address lookup need network/provider availability                                   |
| Display and unfinished work  | System/Light/Dark appearance, Activity balance visibility, retained transaction/budget/goal drafts                                                        | Device-local preferences and drafts. Hiding the home balance does not hide transaction amounts or reports                                     |
| Optional local service route | Qwen through Lemonade, Windows OCR, the Auth-only emulator and local Prophet                                                                              | The paired Windows companion requires a debug build and Android emulator. Configure the route before starting/reloading the bundle; hosted failure never selects it automatically |

[Original service integrations](docs/ORIGINAL_SERVICE_INTEGRATIONS.md) explains how the architecture differs from the original implementation. Follow [Backend setup](tools/backend/README.md) to run the service independently of a nearby Windows computer. Windows Prophet runs are recorded separately from the device calculations. Live OpenAI/Vision calls, public deployment and native Linux/container execution remain unverified.

## Find your way around

- **Activity:** add and review transactions. The balance includes all dates, while the activity list can show one month. Show/Hide affects only the top balance.
- **Plan:** manage category budgets and a savings target. These plans do not move or reserve money. Unfinished transaction, budget and goal forms can be resumed from device-local drafts.
- **Reports:** review balances for the selected period, export a PDF, try a scenario or view an eligible expense forecast.
- **Wallet:** change the wallet settings, choose System, Light or Dark appearance, and open tools. **Wallet > Connections** (under Tools) contains Account, Cloud wallet, Cloud backup, receipt recognition, the assistant and forecasts. Open a report before using the assistant; its dates can then be reviewed or changed.

Configuring a service adds shortcuts to the relevant screens. The app checks availability when you request the feature. The header shows the wallet, action results and recovery messages rather than a permanent connection-readiness message.

The [UI guide](docs/UI_DESIGN.md) covers the Apple-inspired grouping, platform fonts, amount display and keyboard-aware sheets, with more native screens. [Verification](VERIFICATION.md) records the local and optional-service walkthroughs and their limits.

## Run the Android app

[Android setup](docs/ANDROID_SETUP.md) covers the Windows toolchain, project generation, native build, installation and first launch. The recorded environment uses Node 24.22.0, JDK 17 and Expo SDK 58. Dependencies are pinned in `package-lock.json`.

Install the pinned dependencies from the repository root:

```powershell
npm.cmd ci --ignore-scripts
```

After building and installing the debug app, launch it with:

```powershell
npm.cmd run android -- --project-app
```

The launcher expects the configured `FYP_API35` emulator and Metro on port 8081. It checks the installed app and checkout before launch. It reuses a running emulator; new project-app emulator starts skip VM snapshots but keep installed apps and userdata. Keep Metro running while you use the debug app.

Expo Go previews only part of the app and lacks native capabilities such as the project's PDF repair. Its saved data is separate from the installed app. Do not uninstall the app or clear its storage to switch preview modes.

On 18 October 2026, a newly generated Android project from this source passed a debug build and an API 35 emulator walkthrough covering persistence and native PDF generation. The check used an existing Windows toolchain and dependency caches. Setup on a clean computer is unverified; iOS work is deferred. See [Verification](VERIFICATION.md) for the check details and limits.

[Architecture](docs/ARCHITECTURE.md) follows one expense from the editor through validation and confirmed storage into reports, with a worked exercise.

Hosted Firebase Storage requires a billing plan. The [Firebase guide](tools/firebase-backup/README.md) explains the requirement and the separate local demo-emulator setup. Cloning this repository does not enable hosted services or incur their usage charges.

Optional service setup:

- [Firebase accounts, everyday cloud records and backup setup](tools/firebase-backup/README.md)
- [Deployable OpenAI, Vision and Prophet backend](tools/backend/README.md)
- [Standalone local Auth emulator](tools/auth-emulator/README.md), when cloud backup is not configured
- [Windows companion and provider selection](scripts/companion/README.md)
- [Flask/Prophet service and local verification](tools/forecast/README.md)

## Source checks

Run the application, companion, Auth-helper and backend JavaScript suites, then check TypeScript:

```powershell
npm.cmd run check
```

With Python 3.12 or newer available as `python`, run `npm.cmd run test:python` for the companion, Auth-lifecycle and backend-supervisor suites. They use synthetic data and simulated native/provider effects. Android rendering, persistence, permissions, PDF/QR output, OCR and model behavior need separate checks. Hosted CI is unverified.

Firebase emulator checks and real Flask/Prophet fits have their own prerequisites and commands; neither runs in the default source checks. Backend JavaScript tests are included in `check`. To run them separately:

```powershell
node --test --test-concurrency=1 "tools/backend/tests/*.test.cjs"
```

The checks recorded on 19 and 20 October 2026 include 1,224 JavaScript tests and TypeScript at the receipt correction, and 51 optional Python checks at the completion checkpoint. Firebase-emulator and native Android results are recorded separately. [Verification](VERIFICATION.md) lists the source revisions, completed workflows and remaining limits for those runs.

## Feature guides

| Topic                               | Read more                                                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Money, dates and persistence        | [Wallet and ledger](docs/WALLET_LEDGER.md), [Budgets and goals](docs/BUDGETS_AND_GOALS.md)                                                                                                    |
| Reports and calculations            | [Financial reports](docs/FINANCIAL_REPORTS.md), [Score and simulator](docs/HEALTH_AND_SIMULATOR.md), [Loan calculator](docs/LOAN_CALCULATOR.md), [Monthly forecast](docs/MONTHLY_FORECAST.md) |
| Device features and sharing         | [Achievements and reminders](docs/ACHIEVEMENTS_AND_REMINDERS.md), [Transaction details](docs/TRANSACTION_CONTEXT.md), [PDF and QR](docs/PDF_AND_QR.md)                                        |
| Optional account and model features | [Account access](docs/ACCOUNT_ACCESS.md), [Receipt capture](docs/RECEIPT_CAPTURE.md), [Financial assistant](docs/FINANCIAL_ASSISTANT.md)                                                      |

## Scope and data

Production use has not been verified. The cash-flow score is illustrative, forecast error measures a bounded historical comparison, and generated explanations can be wrong. The feature guides explain their assumptions; [Dependency notes](DEPENDENCY_NOTES.md) covers compatibility and audit history.

Keep real records, credentials, connection tokens, emulator exports, model files and generated runtime data out of source control. Guest records stay on the device until you copy or export them. For a configured Firebase account, Save confirms the financial records and selected attachments with the server. Manual backup creates a separate recovery snapshot. A cloud wallet supports up to 768 KiB of validated financial data and 100 attached photos. Auth-emulator exports alone contain no wallet or photo backup.

Unfinished forms and assistant conversations stay on the device, separated by owner. Each account can keep 20 conversations with the latest 12 exchanges each. A follow-up sends at most the latest three exchanges with the selected calculated facts. Your question may include personal information you type. Receipt recognition sends the selected image only when requested. The app shows the destination before sending either request. The original submission archive and report are not included in this repository.

Developed with assistance from AI tools.

Project code is available under the [MIT license](LICENSE); preserve the [third-party notices](THIRD_PARTY_NOTICES.md) when reusing it.
