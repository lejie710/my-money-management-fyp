# Apple-inspired mobile interface

The interface uses light grouped surfaces, platform typography, readable money and consistent controls across Activity, Plan, Reports and Wallet. The current design keeps ordinary local tracking prominent and puts optional service setup under Wallet → Tools → Connections. Android is the current development target; visual styling does not establish iOS behavior.

## First launch and saved data

An ordinary first launch creates an empty local wallet with predefined categories, no transactions, no budgets and no savings target. No account or companion is needed. Existing wallets take precedence over the default seed, including supported migration stores. Changing the default does not clear data, convert an existing sample wallet into a real one or fabricate a new history.

Existing sample wallets remain explicitly labelled because sample mode has different achievement behavior. Verification fixtures and any future screenshot dataset are separate, deliberately selected data. The ordinary empty state must remain useful without them.

## Shared visual language

| Role              | Value     | Purpose                                               |
| ----------------- | --------- | ----------------------------------------------------- |
| Canvas            | `#F2F2F7` | Separate white content groups without heavy outlines  |
| Surface           | `#FFFFFF` | Forms, grouped rows and financial content             |
| Main text         | `#1C1C1E` | Headings, primary values and entry titles             |
| Secondary text    | `#636366` | Dates, labels and supporting explanations             |
| Action            | `#0066CC` | Enabled actions, selected controls and focused fields |
| Positive          | `#18794E` | Income and progress, accompanied by signs or labels   |
| Destructive/error | `#B42332` | Destructive actions and errors, accompanied by text   |

Platform system fonts avoid a bundled font dependency. Page titles use 32/40 size/line-height, section headings 17/24, body text 15/23 and hints 13/19. Monetary values use tabular numerals and retain their exact currency precision instead of approximate abbreviations. Outline icons use the existing SVG library and supplement visible labels and accessible names.

Selected text/action contrast pairs were checked during the earlier design work; those checks are not a complete accessibility audit. Disabled states, native text scaling and screen-reader behavior still need appropriate device verification.

## Activity

Activity is the home screen. Add opens the ordinary transaction form, and the wallet balance is labelled Across all recorded dates. All time / By month controls precede period totals and the transaction list. Editing and Details & share remain separate targets.

An empty wallet offers its first entry rather than displaying invented transactions. The edit/delete hint appears only when entries exist. A configured receipt connection adds a compact Review receipt shortcut; it does not claim recognition has succeeded. Full setup and manual receipt access remain under Connections.

When account access is unconfigured, the persistent header shows the wallet name and opens wallet settings. Configured accounts retain their account shortcut. Exact idle restore/seed messages are omitted from the header; meaningful save results, errors and recovery actions remain.

## Plan

Each budget keeps its category, calendar period, exact dates, spending, limit and remaining/over amount together. Amount rows can stack for larger text. Empty states explain how to add a budget or savings target.

The savings goal stays separate and follows the wallet balance without moving or reserving money. Overlapping weekly, monthly and yearly plans are not combined into an invented remaining allowance. Progress always has a textual explanation rather than relying on color alone.

## Reports

The applied dates and reconciled balances precede report actions. Opening, closing and all-date wallet balances remain distinct. Category breakdowns preserve their denominators; zero-income ratios remain unavailable rather than inventing a value.

Date edits require Apply. Invalid edits preserve the displayed report, and exports and explanations use its applied range. A configured companion adds the assistant shortcut. The explicit Choose a report route from Connections also exposes that action with guidance; it never guesses a range or sends a question merely by navigating.

The score, simulator and expense forecast remain distinct from recorded facts. The simulator captures its baseline, while forecast selection has its own as-of date and category. Insufficient history stays an honest unavailable state.

## Wallet and Connections

Wallet groups everyday settings and tools. Categories, achievements, reminders and the loan calculator remain under Tools, alongside Connections. Account access is promoted as a wallet shortcut only when configured. Start fresh stays separate and requires its existing disclosure and confirmation.

Connections keeps three optional areas discoverable:

- **Account:** open local account access. When unconfigured, explain that the current wallet works without signing in instead of presenting unusable sign-in buttons.
- **Receipts:** choose/review an image, inspect connection details or open ordinary manual entry. Recognition requires an explicit request to the local Windows companion.
- **Financial assistant:** choose a report, inspect its facts and optionally ask the local model. Calculated facts remain usable without that model.

Configured means connection settings are present, not that a provider is reachable. The [original service integration plan](ORIGINAL_SERVICE_INTEGRATIONS.md) describes hosted alternatives that still require implementation; these screens do not enable them by accepting an API key.

## Sheets, forms and feedback

Shared sheets sit at the bottom on phone layouts and center on spacious layouts. Their title and Close action remain above scrolling content. Keyboard avoidance, handled-tap scrolling and focus styling preserve access to fields and actions. Explicit Close and Android Back retain busy guards, and the assistant retains its opening-session key.

There is no drag-to-dismiss claim or decorative drag handle. The existing Modal uses a static transition. Shared actions retain at least 48dp targets; important text can wrap, and decorative icons are excluded from accessibility focus.

Loading, error, empty and content states stay distinct. Unconfirmed saved data must not appear as a newly empty wallet. Recovery, cleanup retry and explicit save feedback remain reachable even though routine readiness text has been removed.

## Behavior preserved by presentation

- Financial screens stay behind confirmed owner/session gates.
- Existing records and migration bytes are retained; a new default is not a reset.
- Applied selections remain distinct from pending form edits.
- Optional photo retention, export details and QR text require explicit choices.
- Recognition and explanations do not save transactions automatically.
- Currency restrictions, reset confirmation and owned-resource cleanup retain their existing behavior.
- An inactive period can carry an earlier balance, and missing records do not prove real-world inactivity.

## Verification and screenshot status

Focused UI source tests cover shortcut visibility, Connections navigation, manual fallback, applied report dates, idle-message suppression, account recovery and the empty Activity state. The integrated JavaScript suites passed 850 tests and TypeScript passed for this checkpoint.

Seven native check groups covered empty first launch, invalid/cancelled and confirmed entry, optional-tool discovery, budget/goal saves, app-process restoration, navigation at font scale 1.3, and a freshly built APK with native PDF generation. Ledger bytes remained identical across read-only tool navigation and across the later restart, font-scale and APK-update checks. [Verification](../VERIFICATION.md) separates these observations from older provider-backed feature evidence.

The screenshot gallery is pending completion of the required optional integrations and a final walkthrough. Diagnostic screenshots are kept outside the repository. Gallery images will show actual rendered screens using fictional records, with that illustrative purpose disclosed. No finished gallery or additional platform coverage is claimed here.

See [Android setup](ANDROID_SETUP.md) for the build path. Physical-device behavior, iOS and a full screen-reader audit remain unverified.
