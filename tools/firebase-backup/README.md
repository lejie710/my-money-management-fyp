# Firebase wallets, backup and restore

Firebase is optional for guest tracking. When a Firebase project is configured and an account is signed in, **ordinary financial saves use Firebase**: Auth identifies the account, Firestore stores its current wallet, and Storage holds photos explicitly attached to saved transactions. Guest records and the older Auth-only demonstration remain local. Existing device account wallets are kept separately; signing in does not silently upload them.

Manual backup is a separate recovery snapshot of the account wallet. It is not required to publish each ordinary edit. This guide covers both features because they share the same configured Firebase app and access rules.

The implementation has offline safety tests and synthetic Auth/Firestore/Storage emulator checks. A hosted project must belong to the person configuring it. Hosted deployment, password-reset email delivery, production quotas and billing have not been verified by this repository. The main [verification record](../../VERIFICATION.md) records Android evidence and its limits separately.

## Everyday account storage

Open **Wallet > Connections > Account access** to sign in, and **Wallet > Connections > Cloud wallet** for save status, refresh, recovery or an existing-wallet copy. A new cloud account starts with an empty wallet; existing guest records remain available after sign-out.

| Action                                                                        | What happens                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save an account transaction, category, budget, savings goal or wallet setting | The complete validated wallet is saved with a revision check. The UI reports success only after server acknowledgement or exact server reconciliation of the same operation.                                                                                                          |
| Open the account on another device                                            | The app downloads its current wallet and verifies its attachment manifest. Referenced photos are downloaded into that account's managed device storage.                                                                                                                               |
| Refresh and reconcile                                                         | Reads the server again and reopens the confirmed wallet. Refresh happens on account opening or explicit request; there is no continuous Firestore listener.                                                                                                                           |
| Lose the connection                                                           | The last server-confirmed device copy can remain readable after the saved identity is confirmed. A financial edit is not accepted as a completed offline save.                                                                                                                        |
| Leave an unfinished editor                                                    | Supported transaction, budget and goal form drafts stay on that device. A newly selected photo must be selected again after resuming an editor; picker URLs are not written into text drafts.                                                                                         |
| A Save request fails                                                          | A durable, account-scoped save draft remains available. An unsubmitted draft can be deliberately retried or discarded. A submitted operation with an unknown outcome must be reconciled or retried using its original ID.                                                             |
| Another device saves first                                                    | The older revision cannot overwrite the newer wallet. The newer confirmed records are reopened, while the losing draft remains for review and explicit discard. Automatic merging is not implemented.                                                                                 |
| Start fresh while signed in                                                   | After the replacement warning and confirmation, the account's current Firebase wallet becomes empty. Other devices retrieve that replacement when they reopen or refresh. This does not create a second cloud wallet; make a separate backup beforehand if a recovery copy is needed. |

An offline cache is not a second source of truth and does not prove that an uncertain server write failed. Unknown dispatched saves keep financial access guarded until reconciliation establishes their outcome. The app also keeps records gated if saved Auth persistence cannot be confirmed; it never treats an unreadable account session as permission to open a different wallet. A fresh installation without a downloaded account wallet needs a connection to open that cloud wallet.

Photos explicitly kept on signed-in transactions are part of ordinary account storage. Choosing an image for receipt recognition alone does not attach it to the wallet. Receipt processing and keeping a transaction attachment have separate actions. The cloud financial payload contains validated photo references and SHA-256 digests, not local file paths, picker URIs or tokenized download URLs.

## Copy an existing device wallet

Use **Cloud wallet > Preview this account's device wallet** or **Preview guest wallet copy**. These actions read the preserved local source and show its financial summary and photo count. Only **Confirm cloud copy** uploads the reviewed copy. The source wallet remains on the device.

The destination must be unchanged and empty: no transaction history, transactions, budgets, savings goal, milestone/check-in/review evidence or custom categories. There is no merge or populated-wallet overwrite. The source is reread before confirmation, and the server target is rechecked. An account change, financial restoration, open editor, unknown write, changed source or changed target retires the old confirmation.

A guest photo copy stages new managed files in the target account's family before saving. A failed preparation does not save financial records. Unconfirmed owned-file cleanup is shown separately with **Retry photo cleanup**, including when the financial save itself already succeeded. The old guest-copy button in Cloud Backup cannot upload into an everyday Firebase wallet; it directs users to this explicit cloud-copy workflow.

## Separate manual backups

Open **Wallet > Connections > Cloud backup**. Opening the screen does not create a backup. The optional **Include photo attachments** choice starts off; financial records and textual transaction context remain included.

| Operation                          | Effect and safeguards                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview cloud backup               | Captures the current account wallet and selected photo policy. Confirmation rechecks the source before persisting the operation intent and uploading it.              |
| Load completed backups             | Reads up to the fifty newest complete backup indexes. It does not restore records.                                                                                    |
| Preview restore                    | Downloads and validates the selected snapshot, then shows its summary. Confirmation requires the same unchanged empty account wallet.                                 |
| Confirm restore to Firebase wallet | Stages selected photos with fresh ownership and saves the restored records into the empty current Firebase wallet. Other devices can retrieve those restored records. |
| Resume and reconcile backup        | Reuses the persisted backup ID and verifies existing remote snapshot/photo bytes instead of creating another backup after a timeout.                                  |
| Discard pending operation          | Requires acknowledgement for that exact operation. It removes the local backup intent only; incomplete private cloud objects and completed backups remain.            |

Do not clear app data or erase a populated wallet merely to make a restore button available. Preserve needed records first and arrange a deliberately empty target. A snapshot that exceeds the everyday wallet's size or photo limits cannot be restored into that live target, even when the backup format itself permits a larger snapshot.

Current wallets and backups include supported financial records, notes, person/place labels, categories, budgets, the savings goal and achievement evidence. They exclude authentication credentials, email/display-name/profile extras, notification schedules, exported PDFs and device conversation history. Restoring records does not recreate old notification schedules or sign in another account. Profile extras, appearance settings and unfinished form drafts remain device-local.

## Run the local emulators

First install the root application dependencies using [Android setup](../../docs/ANDROID_SETUP.md). The app and SDK tests use Firebase 13 from that root installation. The optional tooling below separately pins Firebase CLI 15.34.0.

Use Node 24.12 or later within Node 24 and **JDK 21 in the emulator terminal**. The pinned CLI requires Java 21; Android compilation continues to use JDK 17 in its own terminal. Install Java from an official JDK distributor, then replace the example with its actual installation directory. These assignments affect only the current PowerShell session:

```powershell
$env:JAVA_HOME = 'C:\Tools\jdk-21'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
java -version
node --version
npm.cmd --prefix tools/firebase-backup ci --ignore-scripts
npm.cmd --prefix tools/firebase-backup start
```

Run these commands from the repository root. Installation downloads pinned npm packages; the first emulator launch downloads official Firebase emulator binaries. The start command selects only the fictitious `demo-money-backup` project and Auth/Firestore/Storage emulators. No Firebase login or hosted project is required. See the official [Emulator Suite setup guide](https://firebase.google.com/docs/emulator-suite/install_and_configure).

Services bind to `127.0.0.1` on Auth 19099, Firestore 18080 and Storage 19199; hub/logging use 19440/19450. Keep that terminal running. If a port is occupied, identify its existing owner instead of stopping unrelated processes. Stop this foreground emulator command with Ctrl+C when finished.

The basic public start command does not export accounts, wallets or backups when stopped. Keep the emulators running across an app-restart check. Restarting an empty Auth emulator while the app retains an old synthetic session can make that saved sign-in unavailable. The explicit saved-sign-in recovery, when offered, removes only that device session and requires an app restart; it does not delete retained financial records. The public setup does not depend on private launchers, exports or files from another machine.

For emulator testing, create or edit ignored `.env.local` at the repository root with these deliberately fictitious client values. Preserve unrelated settings you already use:

```dotenv
EXPO_PUBLIC_LOCAL_AUTH_EMULATOR=0
EXPO_PUBLIC_FIREBASE_MODE=emulator
EXPO_PUBLIC_FIREBASE_PROJECT_ID=demo-money-backup
EXPO_PUBLIC_FIREBASE_API_KEY=demo-only-money-backup-key
EXPO_PUBLIC_FIREBASE_APP_ID=1:1234567890:android:0000000000000000000000
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=demo-money-backup.firebaseapp.com
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=demo-money-backup.appspot.com
EXPO_PUBLIC_FIREBASE_AUTH_PORT=19099
EXPO_PUBLIC_FIREBASE_FIRESTORE_PORT=18080
EXPO_PUBLIC_FIREBASE_STORAGE_PORT=19199
```

Restart the selected Metro server after changing configuration. In the separate Android terminal, keep JDK 17 selected and forward all three ports to your confirmed emulator serial. For the normal documented `emulator-5580`:

```powershell
adb -s emulator-5580 reverse tcp:19099 tcp:19099
adb -s emulator-5580 reverse tcp:18080 tcp:18080
adb -s emulator-5580 reverse tcp:19199 tcp:19199
npm.cmd run android -- --project-app
```

Emulator mode rejects non-`demo-` project IDs and requires all three services. SDK instances connect to loopback before use; an unavailable emulator never selects hosted mode as a fallback. Hosted mode rejects `demo-` IDs, keeping the two modes distinct.

The older **Auth-only demonstration** remains a separate option with its previous local storage keys. Set Firebase mode to `off` before enabling that route and follow [Account access](../../docs/ACCOUNT_ACCESS.md). Its account wallets stay on the device. Do not enable both account choices together.

## Configure your own hosted project

These are manual setup instructions for the project owner. No setup command automatically creates a hosted project, enables billing or deploys rules.

**Hosted Storage requires the pay-as-you-go Blaze plan and a linked Cloud Billing account.** Firebase's current FAQ states that the access requirement took effect on February 3, 2026, including existing default buckets. No-cost usage allowances do not remove this billing prerequisite. Confirm your own project's pricing and controls before enabling hosted photos or manual backups. [Official Storage billing requirements](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024).

The documented `demo-money-backup` emulator route has no live resources and does not require a billing account. Dependency/emulator downloads require an initial connection, but the configured demo services run locally. [Official demo-project guidance](https://firebase.google.com/docs/emulator-suite/connect_storage#choose_a_firebase_project).

1. In a Firebase project you control, register a JavaScript/web app to obtain the client configuration used by the Firebase JavaScript SDK. Enable email/password Authentication, create the default Cloud Firestore database and create the Storage bucket you intend to use. Review current service availability, billing requirements and usage limits before enabling hosted resources. The official [JavaScript setup guide](https://firebase.google.com/docs/web/setup) explains project/app registration.
2. Review [firestore.rules](firestore.rules) and [storage.rules](storage.rules). They restrict wallet, receipt, backup and photo paths to their authenticated UID. Ordinary wallet updates require the next revision and an atomically matching immutable operation receipt. Backup indexes and photo objects are immutable; ordinary wallet and receipt deletion is denied. These files are a complete rules configuration for this project, not a safe additive patch for an unrelated application's collections. Integrate and review existing policies before deploying them into any project that already contains data.
3. Deploy the reviewed rules to your own project deliberately. You can publish them through the Firebase console, or authenticate the pinned CLI under your own account and run the commands below. The example assumes the default Firestore database and default Storage bucket. A custom bucket needs an explicitly reviewed deployment target matching the configured client bucket; default-bucket rules do not establish protection for a different bucket.
4. Set `EXPO_PUBLIC_FIREBASE_MODE=hosted`, `EXPO_PUBLIC_LOCAL_AUTH_EMULATOR=0` and the five client fields from [client.env.example](client.env.example) in ignored `.env.local`. Use the exact bucket name without a `gs://` prefix. New default buckets normally end in `.firebasestorage.app`; older buckets may retain `.appspot.com`. Do not copy the fictitious emulator bucket name into hosted configuration. [Official bucket naming guidance](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024#will-the-name-of-my-default-bucket-change). Remove emulator-port entries for clarity; hosted mode does not use them. Restart Metro.
5. Register a new test account in the app and verify that its cloud wallet is empty. Save a small fictional transaction, reopen it, and sign in on another independently configured device to check retrieval and an explicit refresh. Test a receipt attachment and the separate backup/restore workflow before relying on your deployment. Record hosted verification separately from emulator evidence.

After installing the optional CLI dependencies, run the following manually from the repository root. Replace `YOUR_PROJECT_ID` with the intended project first. **Rule deployment changes that remote project's access policy.**

```powershell
.\tools\firebase-backup\node_modules\.bin\firebase.cmd login
.\tools\firebase-backup\node_modules\.bin\firebase.cmd deploy --project YOUR_PROJECT_ID --only firestore:rules,storage --config tools/firebase-backup/firebase.json
```

The [Firebase CLI reference](https://firebase.google.com/docs/cli) documents project selection and deployment. This repository's verification has not executed those hosted commands. Never copy another person's project settings, service-account JSON, admin credentials, OpenAI keys or Google Vision secrets into the app.

Firebase client configuration identifies a project; authentication and deployed access rules protect its data. An environment variable beginning `EXPO_PUBLIC_` can be bundled and is not secret. See [Firebase API-key guidance](https://firebase.google.com/docs/projects/api-keys). The app does not add end-to-end encryption to uploaded records or photos; people with appropriate administrative access to the configured project can access its data.

Hosted password reset submits a Firebase email request. A successful API response does not prove delivery. The three-service emulator never sends a real email; its reset request remains a local emulator action and does not use the older Auth-only inbox UI. Multi-tenant Auth, anonymous account migration, custom Firestore database selection and automatic account deletion are outside this implementation.

## Storage and recovery boundaries

| Item                        | Boundary                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Current financial wallet    | One validated JSON payload and attachment manifest, at most 768 KiB of UTF-8 bytes; at most 100 referenced photos                    |
| Current-wallet photos       | JPEG/PNG/WebP, at most 10 MiB per photo; exact byte digest and image metadata checked                                                |
| Current-wallet save         | Server revision comparison plus stable operation ID and immutable receipt; a stale device cannot silently overwrite a newer revision |
| Device cache and save draft | Separate project, UID and data-scope keys; old local account keys are retained                                                       |
| Manual backup snapshot      | `mymoney-backup-v1`, strict supported fields, at most 5 MiB                                                                          |
| Manual backup photos        | Optional; at most 100 attachments and 50 MiB combined, at most 10 MiB per photo                                                      |
| Completed backup list       | Fifty newest indexes                                                                                                                 |
| Restore/copy target         | Preview and unchanged-empty-target compare-and-save; account/session and financial binding must remain current                       |
| Server reads                | Finite waits; an unknown transaction outcome is reconciled using its original operation instead of assuming cancellation reversed it |

Firestore stores current wallets at `users/{uid}/wallets/{walletId}` and receipts in their `operations/{operationId}` subcollection. The normal wallet ID is `main`; explicit test namespaces use a hash-derived `test-...` ID. Current-wallet photos use `users/{uid}/walletFiles/{walletId}/{sha256}`. Neither scope is shared with the old local wallet keys.

Manual backup indexes use `users/{uid}/walletBackups/{backupId}`. Storage uses that prefix with `snapshot.json` and `photos/{sha256}`. Photo and snapshot upload precede publication of the complete backup index. Resume checks the actual blobs; a matching index alone is insufficient.

An unreadable or malformed local save/backup journal blocks replacement work. It is retained for recovery rather than overwritten with a new operation. A submitted ordinary save cannot be discarded as though nothing reached the server. Unsubmitted save conflicts must be resolved explicitly; the app does not automatically rebase or merge them.

**Remote photo garbage collection is not implemented.** Removing a transaction or replacing the current wallet can leave earlier immutable photo objects in the owner's private Storage namespace. This avoids deleting an image still referenced by another device's retained version. Manual-backup orphan cleanup and in-app backup deletion are also not implemented. A project owner should review storage retention deliberately; do not infer that deleting a local record erased every historical cloud object.

Unsupported extra financial fields and oversized payloads fail validation. Client hash checks detect inconsistent content; access control still depends on authenticated identity and deployed rules. Cancellation or timeout cannot undo a write already accepted by the service.

## Reproduce the checks

The ordinary `npm.cmd test` suite includes offline format, identity, save-draft, revision-conflict, copy/restore, pending-journal, transport and file-lifecycle checks. It also exercises actual account/coordinator/ledger runtime wiring using injected cloud ports. Those tests do not replace Firebase SDK or Android checks.

Start only the documented local emulators, leave them running, and use another terminal at the repository root:

```powershell
$env:FYP_FIREBASE_RULES_TEST = '1'
node --test tools/firebase-backup/rules.test.cjs
node --test tools/firebase-backup/everyday-roundtrip.test.cjs
node --test tools/firebase-backup/roundtrip.test.cjs
```

Each script installs [emulatorOnly.cjs](emulatorOnly.cjs) before Firebase imports. It rejects fetch, socket and HTTP/2 destinations outside the three allowed loopback ports; unexpected destinations fail the gate. The guard has its own offline regression. These scripts accept no live-project override.

- The rules gate checks owner A, owner B and anonymous callers, immutable backup paths, everyday revision/receipt pairing, forbidden deletion, and private image metadata restrictions.
- The everyday SDK gate uses the actual application ports with two Auth clients. It verifies ordinary save, second-client retrieval and photo hydration, stale-revision rejection, exact-operation replay, and reuse of the same Firebase services by the separate backup feature. Its immutable synthetic wallet/receipt/photo paths remain in the disposable emulator run; the synthetic Auth account and SDK instances are closed.
- The backup SDK gate roundtrips a snapshot and photo, validates restored photo ownership and same-ID retry, and confirms cleanup of its permitted backup objects and synthetic account.

For Android acceptance, use fictional records and keep the emulators running across app restarts. Start with a guest transaction, sign in to a new empty account, explicitly preview/copy the guest records through Cloud wallet, and verify the guest source after sign-out. Save an ordinary account edit, reopen it and test an attached photo. Check cached reads after a genuine cold offline start separately from an already-open session. Then make a manual backup and restore only into a deliberately empty target, verifying amounts and photo bytes after restart. Device checks must establish these behaviors rather than infer them from successful Node SDK tests.

Emulator evidence does not establish hosted deployment, email delivery, production quotas, a clean-machine installation, physical-device behavior or iOS support. See [Verification](../../VERIFICATION.md) for the recorded gates and current limitations.
