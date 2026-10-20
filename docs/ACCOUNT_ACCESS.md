# Guest and Firebase account wallets

A fresh installation opens an empty device-local guest wallet. With Firebase configured, sign-in opens that account's everyday cloud wallet: financial saves use Firestore, and attached photos use Firebase Storage. Guest records and earlier account-local wallets are not uploaded merely by signing in. The original Auth-only local demonstration remains an alternative with local financial records.

Use the [Firebase setup guide](../tools/firebase-backup/README.md) for project configuration, rules, the three-service emulator and everyday-cloud recovery. The [backend guide](../tools/backend/README.md) separately configures the original OpenAI, Vision and Prophet services using the same Firebase account identity.

## What is kept where

| Information                                    | Location and purpose                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Guest financial records and attachments        | Device-local guest store; preserved when entering or leaving an account                                                   |
| Configured account ledger                      | Firestore, with server revisions and save receipts; one wallet for that project/UID                                       |
| Account attachment bytes                       | Owner-scoped Firebase Storage after explicit transaction/copy/restore confirmation, with checked local copies for display |
| Last confirmed account records                 | Device cache for offline viewing; never a substitute for server acknowledgement of an attempted save                      |
| Unfinished transaction, budget and goal fields | Local drafts scoped to account family, wallet incarnation and form target                                                 |
| Interrupted submitted cloud operations         | Separate local recovery journal retaining the same operation identity until its server outcome is resolved                |
| Assistant conversation history                 | Local per-account/guest storage; not included in Firebase wallet synchronization or backups                               |
| Auth credentials and identity                  | The selected Firebase Auth service; its SDK session is stored in a scoped device namespace                                |
| Optional profile extras and local reminders    | Device-local account/owner data, excluded from wallet recovery snapshots                                                  |
| Manual cloud backup                            | Separate explicit recovery snapshot, with photos included only when selected                                              |

Equal UIDs in different Firebase projects do not share local account data. The app does not add its own encryption layer to AsyncStorage or local financial files; native Android backup is disabled. Uninstalling or clearing app storage can remove local drafts, history and cached data, while confirmed remote financial records remain in the configured project.

## Sign in and change accounts

Open Wallet > Tools > Connections > Account access, or Manage account when signed in. Register with an email, password and display name, or sign in to the selected Firebase project. A new account starts with an empty cloud wallet; an existing account retrieves its current server records. When account configuration is disabled, the account screen explains guest mode without presenting unusable sign-in controls.

Sign out to reopen the separate guest wallet. Signing out does not delete the cloud account wallet or the earlier local account store. Signing back into the same project/UID reopens that account. Deleting and recreating an account can change its UID even if the email is reused, so it does not automatically recover the old wallet.

Before an identity change, the app retires feature sessions, protects owned photo operations and pauses/cancels the previous owner's local reminders. An active financial editor or unconfirmed financial write can require attention before switching. Financial content remains gated until identity and the intended wallet are confirmed; another account's balance is not used as a loading placeholder.

If account recovery closes an unfinished financial form, confirmed local drafts remain separate from saved records and require Resume/Discard on reopening. Temporary photo selections may need to be chosen again. An uncertain cloud Save is a different state: reconcile the operation rather than discarding it as if no request was submitted. Recovery labels may require closing an active editor before checking the saved session.

## Connected saving and offline viewing

Everyday account saves require a Firebase server acknowledgement. A successful Save on one device becomes available when another device opens or explicitly refreshes the wallet. The app does not provide automatic offline edit merging or promise live push updates between every open screen.

Offline access uses the last server-confirmed records. Transaction, budget and goal text can be retained locally as unfinished drafts, but those drafts do not change confirmed cloud totals. On reopening, compare the captured financial base with the current wallet before resuming. A newer wallet version cannot be silently replaced by a stale draft.

If a save was dispatched but its response was lost, Cloud wallet retains the operation for explicit reconciliation/retry. A server receipt confirms whether that exact operation committed. Another device's intervening change produces a conflict with the attempted draft preserved. Malformed recovery data is retained and blocks replacement. [Firebase setup and recovery](../tools/firebase-backup/README.md) documents the exact states and limits.

## Copy an existing wallet or restore a backup

Open Wallet > Tools > Connections > Cloud wallet to preview an existing guest or earlier account-local wallet. Confirming the copy requires the same unchanged empty cloud target and unchanged source. The reviewed records and attachments are saved to the account's Firebase project; the original device source stays intact. There is no silent migration on sign-in.

Cloud backup is a separate recovery feature. Its photo inclusion remains explicit. Confirming a restore into a live account wallet writes the restored records and selected attachments to the unchanged empty Firebase target so other devices can retrieve them. A populated target is not merged or overwritten. Restore imports no Auth session, profile extras, assistant history, export artifact or notification schedule. An Auth-emulator export alone is not a wallet/photo backup.

## Remove an unavailable saved sign-in

If the SDK tries to discard an existing readable saved sign-in during startup, the application preserves that record instead of silently switching identities. This can happen when an account was deleted from the selected service, including after a local emulator was restarted without its exported users. Repeated app restarts cannot repair that missing server identity by themselves.

Account offers **Remove unavailable saved sign-in** only for that specific known-record recovery state. Open the separate confirmation and review its effect. Cancelling changes nothing. Confirmation rechecks the exact saved record and device storage, removes only this scope/project's unavailable SDK sign-in, and verifies the result. It does not delete an account on the server, clear app storage, or alter guest/account wallets, profiles, photos or other saved sign-ins.

After confirmed removal, close and restart the app. Financial access stays gated in the current process so old SDK callbacks cannot recreate the retired session. The fresh process must confirm the guest identity and its existing saved wallet normally before sign-in or registration becomes available. A newly created account with the same email can have a different UID and does not automatically receive the old account wallet.

Unreadable storage, unresolved financial writes, a changed session record or an uncertain removal outcome do not authorize this recovery shortcut. The app keeps access blocked and reports the unresolved outcome; it never retries deletion or rewrites a replacement session automatically. Ordinary sign-out remains the separate action for a healthy confirmed account.

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

The [verification record](../VERIFICATION.md) separates the Auth helper's export/import lifecycle checks from Android account workflows. Working guest mode does not establish that an optional Auth service is running. Preserve exported emulator identities when continuing a previous synthetic account.

## Worked example

The guest wallet holds RM40.00. Account A confirms RM12.50 of expenses in Firebase; account B has separate records. Moving among those identities must preserve their different wallets. Editing A cannot change guest or B data, and an account transition retires previews or requests from the previous session.

If A loses connectivity, its last confirmed wallet can remain visible with a read-only/recovery indication. Typing a new budget creates a local draft, not a cloud budget. The user must resume/review and save when connected. Returning to Guest still shows the original guest records unless a separate guest action changed them.

Exercise: the guest has a budget and receipt photo. Register A, then sign out without confirming a copy. Where should those items appear?

Answer: only in the guest wallet. A's new account wallet begins empty. Later, an explicitly confirmed copy into an empty A wallet may include those records/photos, while keeping the guest originals.

## Verification boundaries

See [Verification](../VERIFICATION.md) for completed source, emulator and native checks. A locally tested Auth/Firestore/Storage flow does not establish hosted project deployment, production rules setup, email delivery or iOS behavior. No original hosted account is needed for the repository's synthetic examples.
