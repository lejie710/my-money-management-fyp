# Guest and configured account access

The app has one guest wallet and a separate device-local wallet for each confirmed account. Sign-in selects that wallet; it never automatically uploads financial records or copies the guest wallet. Accounts can use either the original Auth-only local demonstration or an explicitly configured Firebase project for manual backup and restore. No original hosted project or credential is included.

The [Firebase backup guide](../tools/firebase-backup/README.md) covers the new three-service emulator and hosted setup. The Auth-only helper below remains available independently, with its existing identities and persistence keys preserved.

## What is kept where

| Information                                        | Storage and purpose                                                                                                                                                           |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guest transactions, budgets, goal and achievements | The existing device-local guest store, with earlier migration bytes preserved                                                                                                 |
| Each account's financial records                   | A separate device-local store identified by scope and account; configured Firebase additionally includes project ID so equal UIDs in different projects do not share a wallet |
| Transaction photos and local reminders             | Bound to the same account family and wallet incarnation; earlier owners cannot publish into a newly selected wallet                                                           |
| Email, password credentials and display name       | The selected Firebase Auth service; the older local Auth-only helper can export/import its synthetic accounts                                                                 |
| Saved SDK session                                  | Device AsyncStorage under an isolated scope/project namespace; checked against the SDK's actual identity before opening financial content                                     |
| Optional gender and birthday                       | That account's local profile on the device; initially unset, never inferred, and excluded from wallet backups                                                                 |
| Explicit cloud backup                              | Supported ledger snapshot and optional photo blobs in the configured project, after preview and confirmation; no background synchronization                                   |

The app does not add its own encryption layer to AsyncStorage or its local financial files. Android backup is disabled in the native configuration. The Auth emulator and its exports are development tools; use synthetic identities and passwords that are not reused elsewhere. Hosted Auth and explicit backup/restore have their own configuration and local emulator checks. Live deployment and email delivery remain separate verification; automatic cross-device synchronization is not implemented.

## Use the account screen

Open Wallet > Tools > Connections > Account access. When already signed in, that row is labelled Manage account; configured accounts also have a Wallet account shortcut. With account mode disabled, the account screen identifies the guest wallet and explains that an account service is not configured. Guest financial features remain available.

With either configured account mode enabled, register using an email, password and display name, or sign in to an account in that selected service. A newly encountered account starts with its own empty wallet. If account creation succeeds but its display name cannot be confirmed, the account remains available and Profile offers an explicit name retry. No demographic field is filled automatically.

Sign out to reopen the guest wallet. Signing out does not delete an account's wallet. Signing back into the same UID and project selects its previous records on this device. Removing and recreating an emulator account normally gives it a new UID, so reusing the same email does not identify the old wallet. Preserve the emulator export when you need the original account identity.

Before an identity change, the app blocks new financial writes, waits for owned photo operations and cancels or pauses the previous owner's reminders. It refuses the change while an editor or unconfirmed financial write needs attention. Exports close, and financial content stays hidden until the SDK identity, saved session and exact target wallet are confirmed. A previous account's balance is never used as a loading placeholder for another account.

If a recheck hides an unfinished editor, an explicit Discard transaction draft and recheck action remains reachable outside the financial screen. This discards unsaved form edits only. A failed or uncertain saved operation instead requires Check saved session; the app reads the actual stored result and does not automatically repeat registration, login or financial writes. A restart-required state means that the SDK's saved identity could not be safely reconciled in the current process. Restarting is a recovery step, not permission to clear app data.

## Remove an unavailable saved sign-in

If the SDK tries to discard an existing readable saved sign-in during startup, the application preserves that record instead of silently switching identities. This can happen when an account was deleted from the selected service, including after a local emulator was restarted without its exported users. Repeated app restarts cannot repair that missing server identity by themselves.

Account offers **Remove unavailable saved sign-in** only for that specific known-record recovery state. Open the separate confirmation and review its effect. Cancelling changes nothing. Confirmation rechecks the exact saved record and device storage, removes only this scope/project's unavailable SDK sign-in, and verifies the result. It does not delete an account on the server, clear app storage, or alter guest/account wallets, profiles, photos or other saved sign-ins.

After confirmed removal, close and restart the app. Financial access stays gated in the current process so old SDK callbacks cannot recreate the retired session. The fresh process must confirm the guest identity and its existing saved wallet normally before sign-in or registration becomes available. A newly created account with the same email can have a different UID and does not automatically receive the old account wallet.

Unreadable storage, unresolved financial writes, a changed session record or an uncertain removal outcome do not authorize this recovery shortcut. The app keeps access blocked and reports the unresolved outcome; it never retries deletion or rewrites a replacement session automatically. Ordinary sign-out remains the separate action for a healthy confirmed account.

## Explicit guest copy and cloud backup

Configured Firebase accounts can open **Wallet > Tools > Connections > Cloud Backup**. Previewing a guest copy shows its records before confirmation; copying requires an unchanged empty account wallet and leaves the guest source intact. It performs no upload. Previewing and confirming cloud backup is a separate action, with photos excluded until deliberately selected.

Cloud restore also requires an unchanged empty account wallet. It restores supported financial fields and optional photos under new wallet ownership; it imports no authentication session, profile extras, exports or notification schedules. A populated wallet is never merged or overwritten by these operations. Interrupted backups retain one stable operation ID for explicit reconciliation. See the [Firebase guide](../tools/firebase-backup/README.md) for exact limits, pending-operation recovery, rules and reproduction commands.

## Configured Firebase password reset

The configured Firebase account screen submits an explicit password-reset email request through its selected Auth service. Request acceptance is not proof that an email was delivered. Hosted delivery depends on the owner's project setup. The three-service demo emulator never sends real email and does not expose the old Auth-only reset inbox. That older demonstration is described next.

## Local password reset

Choose Local password reset from Account. Enter the demo account email and request a local reset message. Only that requested address's new message is offered in the local inbox. Open and verify the message, then enter matching new passwords and explicitly confirm.

**No email is delivered.** The reset code remains inside the reset controller and does not appear in the UI, logs, financial records or exported reports. A consumed or invalid message cannot reset another password. If requesting or confirming a reset has an uncertain outcome, follow the displayed inbox/recheck guidance; another request is not silently sent. Closing the reset view cancels its pending inbox read and releases that view's operation gate.

## Original Auth-only developer setup

Guest mode needs no Auth process. For local accounts, use the separately pinned [Auth emulator helper](../tools/auth-emulator/README.md), whose installation is independent of the app's Firebase SDK dependency. Its exact version, package installation review, loopback ports, export/import checks and ownership rules are documented there. Keep its `.runtime` directory and exports ignored.

The helper's normal sequence, from `tools/auth-emulator`, is:

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
python run_auth.py --run-name learning-001 --node "C:\path\to\node.exe"
```

Use an installed Node24 executable. The helper refuses occupied Auth/hub/logging ports or another owner lock. Keep its terminal running. From another terminal in that tool folder, explicitly export or stop:

```powershell
python control.py export --run-name learning-001
python control.py stop --run-name learning-001
```

A normal stop confirms a new Auth-only snapshot and its integrity before stopping the owned service. If export fails, the running service is retained. Start again with a new run name to import the last confirmed snapshot. An abnormal owner lock or uncertain export is retained for inspection; do not delete it merely to force an empty service to start.

In the app's Metro terminal, enable local account mode before starting a new server:

```powershell
$env:EXPO_PUBLIC_FIREBASE_MODE = 'off'
$env:EXPO_PUBLIC_LOCAL_AUTH_EMULATOR = '1'
npm.cmd run android -- --project-app
```

Changing this flag requires restarting the selected development server. The runtime connects Auth to `http://127.0.0.1:9099` synchronously before its first awaited initialization step. For an Android emulator, configure `adb -s <emulator-serial> reverse tcp:9099 tcp:9099` for that verified target; the ordinary app launcher forwards Metro's 8081 port, not Auth's 9099 port. The helper binds its service to loopback and never logs into a cloud Firebase account.

The public helper's real 12-check lifecycle gate passed separately from the 18 recorded Android account checks. It verified empty and populated export/import, two synthetic accounts retaining their UIDs/profiles/password access, and three owned graceful shutdowns with final listeners clear. [Verification](../VERIFICATION.md) records the exact fixture scope and platform limits. The app's working guest mode does not by itself establish that optional account mode or the emulator is running.

## Worked example

Suppose the guest wallet has RM40.00, account A records RM12.50 and account B records RM80.00. Moving among Guest, A and B should show those three separate balances, including after an app restart. Editing A must not change either other wallet. A rejected sign-in must return only to an identity whose SDK persistence and financial store were confirmed; it must not show a blank replacement wallet.

```mermaid
flowchart LR
    G[Confirmed guest identity] --> GW[Guest wallet]
    A[Confirmed account A UID] --> AW[Account A wallet]
    B[Confirmed account B UID] --> BW[Account B wallet]
    U[Unconfirmed identity or saved write] --> R[Recovery screen]
```

Exercise: the guest has a saved budget and photo. Register account A, then sign out. Where should those items appear?

Answer: the new account begins with its own empty wallet, and the guest budget/photo appear again only when the confirmed guest wallet is reopened. There is no automatic transfer. In configured Firebase mode, the user can later preview and confirm a separate guest copy into the still-empty account, optionally including the photo. The original owned photo remains protected by retained-reference checks; account changes do not delete it merely because it is not visible in the newly selected wallet.
