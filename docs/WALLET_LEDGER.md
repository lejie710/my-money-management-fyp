# Wallet and transaction foundation

The app presents one active wallet at a time, with separate guest and account data. A wallet has a name and one currency; it does not convert between currencies. The original eight currency choices are available. JPY uses whole yen, while MYR, USD, EUR, GBP, AUD, CAD, and CNY use two decimal places.

## Money, categories, and dates

Amounts are positive integers in the currency's smallest unit. The transaction type determines whether the amount adds to income, expenses, or debt payments. Debt reduces the wallet balance once. Currency becomes fixed after the wallet records its first transaction, including when those transactions are later deleted. The explicit Start fresh flow creates a new empty wallet and allows a different currency.

Transactions reference stable category IDs. Renaming a category updates its displayed name without breaking existing records. A category used by a transaction cannot be deleted. New category names must be unique within their transaction type.

Dates are calendar values in `YYYY-MM-DD` form. The model rejects impossible dates such as 2026-02-30 instead of allowing JavaScript to roll them into another month. Month navigation is bounded to the model's supported 1900–2100 range.

The wallet balance always includes all recorded dates. The activity section can show all dates or one selected month. This prevents a filtered month's net change from being mistaken for the wallet's total balance.

## Save destination and unfinished entries

The guest wallet is device-local. A configured Firebase account uses everyday server-confirmed records, with a last-confirmed cache for offline viewing. An earlier Auth-only local account keeps its local storage behavior. Signing in never copies a guest wallet automatically; use the explicit Cloud Wallet preview/confirmation to copy into an unchanged empty account target while preserving the source.

Typing a transaction does not change the wallet balance. Changed fields can be retained in a device-local draft, including incomplete amounts or dates. Reopening offers Resume/Discard and checks the captured financial base before saving. New cloud edits require a connection; an uncertain submitted operation retains its identity until reconciled rather than being automatically retried as another transaction.

The Activity Show/Hide control hides only the header balance. It does not alter amounts, calculations, transaction rows or reports. Appearance and visibility preferences are separate from financial records.

## Saved-data migration

The local core v5 store uses a separate key. Everyday Firebase caches and operation journals have separate account/project-bound keys and do not replace older local stores. When it is absent, migration checks v4, v3, v2, and the initial v1 preview in that order. It validates the first present source, preserves transaction IDs, dates, amounts, and category spellings, then writes a new copy. The original bytes remain unchanged. Invalid data does not fall back to stale history or reset records. Failed writes are checked against the active saved key before their outcome is reported. See [Budgets and savings goals](BUDGETS_AND_GOALS.md) for the planning fields added in v3 and [Achievements and reminders](ACHIEVEMENTS_AND_REMINDERS.md) for the ownership and milestone fields added in v4.

Native verification uses a separate synthetic namespace through `EXPO_PUBLIC_TEST_DATA_NAMESPACE`. That test store does not read or migrate any canonical store. The environment variable is for local verification; it is not an account or security boundary.

## Worked example

Record RM1,000 income in October, RM80 food in October, RM50 food in September, RM20 food in November, RM30 transport in October, and RM40 debt payment in October.

- All-date wallet balance: `1000 - 80 - 50 - 20 - 30 - 40 = RM780`.
- October activity: income RM1,000, expenses RM110, debt RM40, net change RM850.
- Editing October food to RM120 changes the all-date balance to RM740.

```mermaid
flowchart LR
    A[Wallet and categories] --> B[Validated transactions]
    B --> C[All-date wallet balance]
    B --> D[Selected-month activity]
    B --> E[Guest local or account server-confirmed storage]
    E --> F[Reopen confirmed records or recover an unfinished operation]
```

Exercise: rename Food to Meals. The October expenses should remain RM110 and the all-date balance should remain RM780. The labels change; transaction references and amounts do not.

## Verification

Model checks cover currency precision, calendar bounds, stable references, migration and uncertain storage outcomes. The [verification record](../VERIFICATION.md) gives completed counts and native evidence rather than treating an older foundation checkpoint as the current full suite. Android checks do not establish iOS behavior. See [Account access](ACCOUNT_ACCESS.md) for cloud confirmation, offline-cache and identity boundaries.
