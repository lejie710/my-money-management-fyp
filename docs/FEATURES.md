# Features and navigation

The app starts with a device-local guest wallet. This guide describes the core tools, optional connections and where to find them. See the [project overview](../README.md), [screenshot tour](SCREENSHOTS.md) or [Android setup](ANDROID_SETUP.md).

## What works where

| Capability                   | Implementation                                                                                                                                             | Setup and limits                                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guest finances               | Transactions, eight currencies, categories, calendar budgets, one savings goal and reconciled reports                                                      | Device-local records with exact minor-unit amounts; no account or server required                                                                                                 |
| Firebase account wallet      | Auth, everyday Firestore records, account-owned Storage attachments, confirmed device-wallet copying and manual backups                                    | Use your own Firebase project. Saves need server confirmation. Offline viewing uses the last confirmed copy; offline edits are not merged automatically                           |
| Financial assistant          | OpenAI explains selected summaries and suggests budgeting/saving changes; dates and comparisons are editable, and conversation history stays on the device | Configure the authenticated backend and a compatible model. The assistant cannot make financial changes                                                                           |
| Receipt recognition          | Google Cloud Vision supplies editable suggestions; the user reviews the image, amount, date, currency and category before saving                           | Explicit recognition request through the configured backend; photo retention is a separate choice                                                                                 |
| Prophet forecast             | Flask/Prophet projects six future expense months from completed monthly totals                                                                             | Configured backend with its Python environment; a separate device calculation remains available offline                                                                           |
| Calculators and native tools | Illustrative cash-flow score, what-if simulator, loan schedule, achievements, reminders, photos, selected contact/place labels, PDF export and QR sharing  | Installed project app and relevant permissions; map tiles/address lookup need network/provider availability                                                                       |
| Display and unfinished work  | System/Light/Dark appearance, Activity balance visibility, retained transaction/budget/goal drafts                                                         | Device-local preferences and drafts. Hiding the home balance does not hide transaction amounts or reports                                                                         |
| Optional local service route | Qwen through Lemonade, Windows OCR, the Auth-only emulator and local Prophet                                                                               | The paired Windows companion requires a debug build and Android emulator. Configure the route before starting/reloading the bundle; hosted failure never selects it automatically |

[Original service integrations](ORIGINAL_SERVICE_INTEGRATIONS.md) explains how the architecture differs from the original implementation. Follow [Backend setup](../tools/backend/README.md) to run the service independently of a nearby Windows computer. Windows Prophet runs are recorded separately from the device calculations. Live OpenAI/Vision calls, public deployment and native Linux/container execution remain unverified.

## Find your way around

- **Activity:** add and review transactions. The balance includes all dates, while the activity list can show one month. Show/Hide affects only the top balance.
- **Plan:** manage category budgets and a savings target. These plans do not move or reserve money. Unfinished transaction, budget and goal forms can be resumed from device-local drafts.
- **Reports:** review period balances and the FYP cash-flow score, inspect its calculation, export a PDF, try a what-if scenario or view an eligible expense forecast.
- **Wallet:** change the wallet settings, choose System, Light or Dark appearance, and open tools. **Wallet > Connections** (under Tools) contains Account, Cloud wallet, Cloud backup, receipt recognition, the assistant and forecasts. Open a report before using the assistant; its dates can then be reviewed or changed.

Configuring a service adds shortcuts to the relevant screens. The app checks availability when you request the feature. The header shows the wallet, action results and recovery messages rather than a permanent connection-readiness message.

The [UI guide](UI_DESIGN.md) covers the Apple-inspired grouping, platform fonts, amount display and keyboard-aware sheets, with more native screens. [Verification](../VERIFICATION.md) records the local and optional-service walkthroughs and their limits.
