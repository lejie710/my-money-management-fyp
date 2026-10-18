# Isolated native verification scenarios

The normal app loads its saved wallet or creates the small sample ledger. Native verification can select a fixed synthetic history through two public build-time environment variables:

```powershell
$env:EXPO_PUBLIC_TEST_DATA_NAMESPACE = 'reports-check-1'
$env:EXPO_PUBLIC_TEST_SCENARIO = 'report-reconciliation'
npm.cmd run android
```

Restart the development server after changing these values. They are included in the JavaScript bundle and must contain only nonsensitive test configuration. Clear both values before opening the normal saved preview:

```powershell
Remove-Item Env:EXPO_PUBLIC_TEST_DATA_NAMESPACE -ErrorAction SilentlyContinue
Remove-Item Env:EXPO_PUBLIC_TEST_SCENARIO -ErrorAction SilentlyContinue
```

`report-reconciliation` creates the ten dated records described in [Financial reports](FINANCIAL_REPORTS.md), with a wallet named Report example wallet. For October 2026, opening is RM750, closing is RM2,200, and the all-date balance is RM2,680.

`health-goal` uses the same financial history with a Health example wallet and a RM4,000 emergency-fund goal. It verifies that the simulator uses the all-date wallet balance for goal progress. The illustrative RM1,000 income / RM800 expenses / RM400 debt scenario has a 45.00 score, RM550 closing, RM1,030 all-date balance, and RM2,970 still needed toward the goal.

`achievements-completion` creates an Achievement verification wallet with 18 synthetic records, RM626 balance, two food budgets, a RM500 target, and three explicitly synthetic historical weekly reviews. Its achievement clock is fixed at 2 November 2026, while tracking starts on 1 October. Eight rules qualify at initialization; confirming 31 October and completing the current week's review exercise the remaining two. This scenario deliberately uses local mode to test durable awards, but is available only with an isolated namespace. It does not represent genuine month-long usage. Android's clock is not changed, and real reminders still use the actual device clock.

The scenario requires a nonempty isolated namespace. Unknown scenario names are errors. Seeding occurs only after a successful load returns no saved ledger, and the new ledger must save successfully before it appears in the app. Read errors, corrupt data, and unsupported schemas never trigger replacement data.

Existing data always wins, including an intentionally empty wallet created with Start fresh. Reusing a namespace preserves its saved records even if a different scenario is requested. Use a new namespace for a fresh test run. Neither the scenario nor its namespace provides authentication or encryption; they keep test fixtures separate from ordinary application stores.

Each namespace has its own v5 financial key and may migrate only its own earlier version keys. Reminder ownership includes the tagged test namespace, local/account identity, and wallet incarnation. A test run does not cancel canonical-preview or another namespace's notifications.

Fixture-initialization tests verify the guards, deterministic fresh instances, preserved canonical bytes, existing empty records, read failures, failed seed writes, and the added goal's independence from financial history. Scenarios supplement real native interactions; they do not substitute for testing provider calls, device permissions, or rendered behavior.

## Export verification fixture

The explicit `export-verification` scenario requires an isolated test namespace. It creates a sample JPY wallet with 67 synthetic transactions across 65 used categories, multilingual text, escaped markup-looking notes, oversized optional QR text, and one exactly 1,024-byte QR selection. Its October expenses are 9,991 yen: category values 1 through 64 total 2,080, followed by 1,234, 5,678 and 999 yen. The fixture exists to verify multi-page PDF output and actual QR pixels without editing an existing wallet.
