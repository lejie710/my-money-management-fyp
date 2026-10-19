# Apple-inspired mobile interface

Activity, Plan, Reports and Wallet use grouped surfaces, platform typography and readable amounts. The accepted Apple-inspired layout is retained while Android remains the verified development target. The interface presents ordinary financial work first and keeps account/service configuration discoverable under Wallet > Tools > Connections.

## Appearance and balance visibility

Wallet offers System, Light and Dark. System is the default; the override is saved on this device. Changing appearance updates existing screens and sheets without intentionally remounting the financial app or discarding typed fields. The status bar, input appearance and semantic colors follow the selected mode.

| Role              | Light     | Dark      | Purpose                                              |
| ----------------- | --------- | --------- | ---------------------------------------------------- |
| Canvas            | `#F2F2F7` | `#101014` | Separate content groups from the surrounding screen  |
| Surface           | `#FFFFFF` | `#1C1C21` | Cards, sheets and forms                              |
| Main text         | `#1C1C1E` | `#F5F5F7` | Headings, entries and primary values                 |
| Secondary text    | `#636366` | `#B8B8C0` | Dates, labels and supporting copy                    |
| Link/action text  | `#0066CC` | `#80B9FF` | Interactive text and selected controls               |
| Filled action     | `#0066CC` | `#0066CC` | Preserve contrast behind white button labels         |
| Positive          | `#18794E` | `#75D8A4` | Income and progress, with textual meaning            |
| Error/destructive | `#B42332` | `#FF9CA5` | Errors and destructive choices, with explicit labels |

Activity's Show/Hide control affects only the wallet balance at the top of that screen. The preference survives reopening. Transaction amounts, summary totals, Plan, Reports and exports remain visible; this is a display preference, not an app lock or complete financial redaction. The hidden value is also removed from that balance element's accessible text. The app waits for saved display preferences before revealing a previously hidden header balance.

QR codes retain a white scanning surface in either theme. PDF output uses its own readable document styling rather than adopting a dark application canvas. Images remain actual image content; theming does not recolor receipt pixels.

## First launch and saved records

Normal first launch creates an empty guest wallet with predefined categories, no transactions, no budgets and no savings target. Existing supported records take precedence over defaults. A different visual theme or first-launch default does not reset saved data or invent demonstration history.

Configured Firebase sign-in opens a separate account wallet. Server-confirmed records, offline cached views, local unfinished form drafts and an uncertain dispatched cloud save have different states and explanations. Loading failures must not be rendered as an empty wallet. Cloud Wallet remains reachable for recovery when ordinary financial editing is gated.

## Shared visual language

Platform system fonts avoid an additional font dependency. Titles use 32/40 size/line-height, section headings 17/24, body text 15/23 and hints 13/19. Monetary values use tabular numerals and their exact currency precision. Outline icons supplement visible labels and accessible names.

Semantic palette checks cover ordinary text, links, positive/error text and solid action labels. They do not replace native checks of scaling, focus order, screen-reader behavior or actual pixels. Progress, overspending and errors retain textual meaning instead of relying on color alone.

## Activity and financial forms

Activity keeps the all-dates wallet balance distinct from the All time / By month activity summary. Add opens the ordinary transaction form; Edit and Details & share remain separate actions. Empty states explain the first useful action. A configured recognition provider adds receipt access without claiming a successful scan.

Transaction, budget and goal forms retain unfinished bounded text as local drafts. Reopening offers explicit Resume/Discard. A changed saved financial base prevents silent stale submission. A successful financial save clears only the matching draft generation; failures keep retry/recovery reachable. Temporary selected photos require a fresh choice after recovery rather than reusing an unowned picker URI.

Keyboard-aware sheets keep primary actions reachable. Android Back and explicit Close are guarded during critical saves. Appearance changes preserve the active component/draft. These sheets use static modal transitions; no unsupported drag-to-dismiss behavior is implied.

## Plan and Reports

Each budget groups its category, calendar period, exact dates, spending, limit and remaining/over amount. Amount rows can stack with larger text. The savings goal follows the wallet balance without moving or reserving money. Overlapping plans keep their own periods instead of being combined into a false remaining allowance.

Reports distinguishes applied dates from pending edits and keeps opening, closing and all-dates balances separate. Exports and assistant entry use the applied range. The assistant can then apply another date range and select summaries; its facts, generated advice and saved historical conversations remain visually distinct.

The score, simulator, device forecast and Prophet output have separate meanings. A hypothetical change is not a saved transaction. Prophet uses completed monthly totals only after an explicit request, with the configured processing destination disclosed. Insufficient history remains an unavailable state without invented values.

## Wallet and Connections

Wallet contains details, appearance and tools. Connections provides:

- **Account:** use the configured Firebase project or optional Auth-only local mode. Signing in does not copy the guest wallet automatically.
- **Cloud wallet:** inspect everyday save status, last confirmed records, operation recovery and explicit copying into an unchanged empty Firebase target. The source is retained.
- **Cloud backup:** create a separate recovery snapshot, or confirm restoring into an unchanged empty target. Restoring into a live account writes to Firebase; manual backup is not required for ordinary account saves.
- **Receipts:** select an image, request the identified provider, then review editable suggestions and explicitly confirm the expense. Photo retention remains a separate choice.
- **Financial assistant:** review summaries/date range, ask OpenAI or the explicitly selected optional local model, and reopen device-local history. At most three prior exchanges accompany a follow-up; responses cannot change finances.
- **Forecasts:** request the configured Prophet service or inspect the separate device calculation. Processing location and model limitations remain visible.

Configured service metadata describes the selected route, not a successful inference. Errors do not switch providers automatically. Provider keys and backend setup internals are documented in setup guides rather than embedded in ordinary financial controls.

## Verification

[Verification](../VERIFICATION.md) records completed source checks and actual Android workflows by scope. It is the authority for counts and final integration status. Theme contrast calculations and hook tests do not establish rendered Android behavior by themselves, and previous gallery captures do not prove newly added cloud/draft/history behavior. Current native checks should include restart, failure/recovery, dark/light/system mode, large text, keyboard use and accessible control labels.

## Native Android gallery

The [README tour](../README.md#screenshots) groups twelve main workflows into recording/planning, analysis and connected tools. Three supplementary views show wallet settings, period balances and the device forecast. These actual captures precede the current everyday-cloud, appearance and conversation-history updates; they remain labelled with the workflows/providers they actually show.

The views use fictional records in a 277-transaction MYR wallet. The wallet balance is RM23,677.70; its October report opens at RM22,276.00 and closes at RM23,677.70. A saved cafe receipt and note belong to an ordinary transaction. The display name is Lejie. The recorded capture walkthroughs compared account, guest-wallet and managed-photo bytes before and after each read-only view.

| View                | What it shows                                                                                                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activity            | All-time wallet balance and recorded activity, with income, expenses and debt payments distinguished.                                                                                                                                                                         |
| Transaction details | The saved receipt photo and note within an ordinary transaction's optional details.                                                                                                                                                                                           |
| Category budgets    | Food & beverages spending of RM517.80 against an October budget of RM800.00, leaving RM282.20.                                                                                                                                                                                |
| Savings goal        | Progress derived from the recorded wallet balance, without moving or reserving money.                                                                                                                                                                                         |
| Reports             | The leading four of seven October expense categories: Bills & utilities RM1,227.60, Food & beverages RM517.80, Shopping RM357.90 and Family RM250.00. Shares use the full RM2,778.30 expense total, including the three categories below this scroll view.                    |
| What-if simulator   | A hypothetical RM500 reduction in October expenses gives RM1,901.70 net change and RM24,177.70 calculated closing balance. No transaction is saved.                                                                                                                           |
| Loan calculator     | A RM10,000 loan calculation at 5% nominal annual interest over 36 months, with explicit payment, interest and repayment totals.                                                                                                                                               |
| Expense forecast    | All six local Prophet estimates from November 2026 through April 2027, using an as-of date of 18 October and 18 completed months through September. Each displayed value matches the actual service response; the RM2,644.00 device comparison is separately labelled.        |
| Receipt review      | Windows OCR suggested the cafe title, 13 October 2026 and MYR. No total was auto-filled; RM12.50 was entered manually after visually checking the receipt. Recognition warnings remain visible, confirmation stays unchecked, and the review is cancelled without saving.     |
| Financial assistant | A real local Qwen explanation of October expenses with the three largest expense categories explicitly selected. The displayed amounts, percentages and cited facts were checked against the report. Future answers still require review; the model cannot change the wallet. |
| Backup preview      | A Firebase-emulator preview of 277 records, three budgets, the savings goal and one selected photo attachment. The preview is cancelled without uploading.                                                                                                                    |
| Exported report     | The first page of the genuine two-page October PDF generated by the Android app, rendered locally for readability. Both pages were checked against the applied report.                                                                                                        |

The README displays linked images at a fixed 320-pixel width in two columns. Native phone images keep their original 720-by-1560 pixels, system bars and aspect ratio. The report image is a faithful PDF page rendering. Labels, amounts and application pixels are not replaced for presentation; the links open the original full-resolution images.

### Supplementary views

These three views complement the twelve main README features.

| Wallet settings                                                                                                 | Period balances                                                                                                                                         | Device forecast                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a href="images/wallet.png"><img src="images/wallet.png" alt="Everyday wallet settings in MYR" width="240"></a> | <a href="images/report-balances.png"><img src="images/report-balances.png" alt="October opening, closing and all-date wallet balances" width="240"></a> | <a href="images/device-forecast.png"><img src="images/device-forecast.png" alt="Six monthly projections from the device forecast" width="240"></a> |
| Everyday wallet, MYR and its recorded balance.                                                                  | October opens at RM22,276.00 and closes at RM23,677.70; the all-date balance remains separately labelled.                                               | The device method projects RM2,644.00 for each of six future months. This is separate from Prophet output.                                         |

Achievements, reminders, QR sharing and additional transaction tools are covered in their feature guides. The showcase does not imply that every feature appears in one gallery.

See [Android setup](ANDROID_SETUP.md) for the build path and [Verification](../VERIFICATION.md) for workflow evidence and limits. The gallery is not evidence of hosted Firebase, live OpenAI/Google Vision, a deployed backend, iOS or a full screen-reader audit. Current feature verification is recorded separately.
