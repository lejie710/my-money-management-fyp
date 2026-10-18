# Understand the loan calculator

Open Wallet, then Loan calculator. Enter a principal in the wallet's currency, a nominal annual percentage rate, and a whole number of months. Calculate produces an estimate and an optional payment schedule. Clear removes the inputs and estimate. These calculations are temporary; they do not create a loan account or alter transactions.

## What the estimate assumes

The rate is fixed, compounding and payments are monthly, and there are no fees or rate changes. Principal must be positive. Rates range from 0 to 100 percent with up to four decimal places; terms range from 1 to 600 months. The result is an estimate under those assumptions, not a lender's quote.

Each payment contains interest plus principal repaid. Interest is calculated from that month's opening balance. The remaining balance therefore falls as principal is repaid. The schedule exposes all four values so the total can be checked.

```mermaid
flowchart LR
    A[Principal, rate, months] --> B[Validate inputs]
    B --> C[Exact annuity calculation]
    C --> D[Round regular payment once]
    D --> E[Calculate monthly interest and principal]
    E --> F[Adjust final payment to clear balance]
    F --> G[Show reconciled schedule]
```

## Worked example

For RM1,200 at 12 percent nominal annual interest over 12 months:

| Result | Amount |
| --- | ---: |
| Regular monthly payment | RM106.62 |
| Adjusted final payment | RM106.60 |
| Total interest | RM79.42 |
| Total paid | RM1,279.42 |

The first month begins with RM1,200. Interest is RM12, leaving RM94.62 of the payment to repay principal. The next opening balance is RM1,105.38. The last month begins with RM105.54; RM1.06 interest makes the final payment RM106.60 and leaves zero.

The total reconciles: RM1,200 principal plus RM79.42 interest equals RM1,279.42 paid. The sum of all principal portions is exactly RM1,200.

## Why rounding matters

Money enters the model as integer minor units: sen for MYR and whole yen for JPY. The annuity formula uses internal arbitrary-size integers to avoid losing precision when a tiny rate is raised over a long term. Each rational amount rounds half up; half a minor unit rounds upward. Only safe integer numbers leave the calculation module.

The regular payment is rounded once. Each month's interest is also rounded. As a result, the last payment can be slightly higher or lower, and very small loans can finish early. A payment that rounds to zero or does not reduce principal is rejected explicitly. The app does not hide that precision limitation by returning a schedule that cannot repay the debt.

For example, RM100 at 1 percent over 36 months has RM2.82 regular payments and a RM2.85 final payment. At zero interest, two yen over three requested months becomes two payments of one yen, with the shorter actual count shown.

## Applying and clearing inputs

Typing changes the draft. The displayed estimate remains tied to its labelled applied principal, rate, and requested term until Calculate succeeds. Invalid new input leaves the previous estimate available for comparison. Schedule pages show six payments at a time and include First page and Last page controls for long terms.

Try changing the worked example's rate to zero and calculating again. The expected regular and final payment is RM100, interest is RM0, and total paid is RM1,200. Then type 101 as the rate: validation should fail while the zero-rate result remains displayed. Clear should remove that result and all three inputs.

## Implementation and evidence

`src/core/loan.js` owns the formulas and invariants. `LoanCalculatorScreen.tsx` owns only draft, applied-result, and schedule-page state. Neither writes the ledger. The 17 focused tests include independent Decimal reference values, half-unit ties, long terms, tiny rates, JPY precision, validation, and reconciliation across 120 parameter combinations.

See the repository verification record for actual Android execution and remaining platform limits. A passing JavaScript test alone does not prove that a mobile runtime supports the internal arithmetic.
