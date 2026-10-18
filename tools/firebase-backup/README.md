# Firebase account backup and restore

Firebase is optional. Local tracking works without configuration. This implementation uses Firebase Auth for a separate account wallet, Firestore for immutable backup indexes, and Firebase Storage for snapshot JSON and optional photos. Edits stay on the device until the user explicitly confirms a backup. There is no automatic upload or continuous synchronization.

The client and rules are implemented and have synthetic emulator verification. A hosted project must belong to the person configuring it. Live project deployment, password-reset email delivery, production quotas and billing have not been verified by this repository. The main [verification record](../../VERIFICATION.md) records Android evidence separately.

## What the user confirms

Open **Wallet > Tools > Connections > Cloud Backup**. Sign in through **Connections > Account**, then preview an operation before confirming it. Opening the screen does not upload records. The photo choice starts off and must be selected deliberately.

| Operation                 | Effect and safeguards                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview guest wallet copy | Reads the guest wallet in the same device scope and shows its summary. Confirmation copies it into an unchanged empty account wallet; the guest source remains available after sign-out. This operation does not upload anything. |
| Preview cloud backup      | Captures the current account wallet and the selected photo policy. Confirmation rechecks the source before writing a durable pending operation and uploading it.                                                                  |
| List and preview restore  | Reads completed indexes and validates the selected snapshot before showing its summary. Confirmation requires the same unchanged empty account wallet and creates fresh wallet/photo ownership.                                   |
| Resume pending backup     | Reuses the persisted operation ID and verifies existing remote objects instead of treating a timeout as permission to create another backup.                                                                                      |
| Discard pending operation | Requires acknowledgement for that exact operation. It removes the device-local intent only; incomplete private cloud objects and completed backups remain.                                                                        |

An empty restore/copy target has no transaction history, transactions, budgets, savings goal, milestone/check-in/review evidence or custom categories. There is no merge and no populated-wallet overwrite. A changed owner, open editor, uncertain saved write or changed target blocks confirmation. Do not clear app data or erase a populated wallet merely to make a restore button available; use a deliberately empty test/account wallet after preserving any records you need.

The snapshot includes supported transactions, notes, person/place labels, categories, budgets, savings goal and achievement evidence. It excludes authentication credentials, email/display-name/profile extras, notification schedules, exported PDFs and temporary conversations. Restoring records does not recreate old notification schedules or sign in another account. Photos are separate optional blobs; no device URI or tokenized download URL is stored in the portable snapshot.

## Run the local emulators

First install the root application dependencies using [Android setup](../../docs/ANDROID_SETUP.md). The app and SDK tests use Firebase 13 from that root installation. The optional tool below separately pins Firebase CLI 15.34.0.

Use Node 24.12 or later within Node 24 and **JDK 21 in the emulator terminal**. The pinned CLI requires Java 21; Android compilation continues to use JDK 17 in its own terminal. Install Java from an official JDK distributor, then replace this example with its actual installation directory. These assignments affect only the current PowerShell session:

```powershell
$env:JAVA_HOME = 'C:\Tools\jdk-21'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
java -version
node --version
npm.cmd --prefix tools/firebase-backup ci --ignore-scripts
npm.cmd --prefix tools/firebase-backup start
```

Run these commands from the repository root. Installation downloads pinned npm packages; the first emulator launch downloads official Firebase emulator binaries. The start command selects only the fictitious `demo-money-backup` project and Auth/Firestore/Storage emulators. No Firebase login or hosted project is required. See the official [Emulator Suite setup guide](https://firebase.google.com/docs/emulator-suite/install_and_configure).

Services bind to `127.0.0.1` on Auth 19099, Firestore 18080 and Storage 19199; hub/logging use 19440/19450. Keep the terminal running. If a port is occupied, identify its existing owner instead of stopping unrelated processes. Stop this foreground emulator command with Ctrl+C when finished. This basic public start command does not export accounts or backups when stopped, so keep the emulators running across an app-restart check. It does not depend on any private `.setup` launcher or downloaded files from another machine.

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

Emulator mode rejects non-`demo-` project IDs and requires all three services. The SDK instances connect to loopback before use; a failed emulator does not select hosted mode. Hosted mode rejects `demo-` IDs, keeping the two modes distinct. The older Auth-only demonstration remains a separate option with its previous local keys; see [Account access](../../docs/ACCOUNT_ACCESS.md). Do not enable both account choices together.

## Configure your own hosted project

These are manual setup instructions for the project owner. No setup command in this repository creates a hosted project, enables billing or deploys rules automatically.

1. In a Firebase project you control, register a JavaScript/web app to obtain the client configuration used by the Firebase JavaScript SDK. Enable email/password Authentication, create the default Cloud Firestore database, and create the Storage bucket you intend to use. Review current service availability, billing requirements and usage limits before enabling hosted resources. The official [JavaScript setup guide](https://firebase.google.com/docs/web/setup) explains project/app registration.
2. Review [firestore.rules](firestore.rules) and [storage.rules](storage.rules). They restrict reads, creates and deletes to the authenticated UID in the path, validate index fields and object bounds, and deny updates to immutable indexes/blobs. The explicit Storage `resource == null` condition also rejects overwriting an existing upload. These rules govern this backup namespace, not an arbitrary application's other collections.
3. Deploy the reviewed rules to your own project. You can publish them through the Firebase console, or authenticate the pinned CLI under your own account and run the commands below deliberately. The example assumes the project's default database and default Storage bucket; a custom bucket needs an explicitly reviewed deployment target matching the client bucket. Do not assume default-bucket rules protect a different bucket.
4. Set `EXPO_PUBLIC_FIREBASE_MODE=hosted`, `EXPO_PUBLIC_LOCAL_AUTH_EMULATOR=0` and the five client fields from [client.env.example](client.env.example) in ignored `.env.local`. Use the exact bucket name from your project, without a `gs://` prefix. Remove emulator-port entries for clarity; hosted mode does not use them. Restart Metro.
5. Register a new test account using the app, verify that its new wallet is empty, and perform a small explicit backup/restore using fictional records before relying on a hosted deployment. Record hosted verification separately from the local emulator checks.

After installing the optional CLI dependencies, these commands are run manually from the repository root. Replace `YOUR_PROJECT_ID` with the intended project before running them; rule deployment changes that remote project's access policy:

```powershell
.\tools\firebase-backup\node_modules\.bin\firebase.cmd login
.\tools\firebase-backup\node_modules\.bin\firebase.cmd deploy --project YOUR_PROJECT_ID --only firestore:rules,storage --config tools/firebase-backup/firebase.json
```

The [Firebase CLI reference](https://firebase.google.com/docs/cli) documents project selection and deployment. Review the target and rules before deploying; this repository has not executed those hosted commands. Never copy the original author's project settings, service-account JSON, admin credentials, OpenAI keys or Google Vision secrets into the app.

Firebase client configuration identifies a project; authentication and access rules protect its data. An environment variable beginning `EXPO_PUBLIC_` can be bundled and is not secret. See [Firebase API-key guidance](https://firebase.google.com/docs/projects/api-keys). The app does not add end-to-end encryption to uploaded snapshots or photos; anyone with appropriate administrative access to the configured project can access its data.

Hosted password reset submits a Firebase email request. A successful API response does not prove delivery. The three-service emulator never sends a real email; its reset request remains a local emulator action and does not use the older Auth-only inbox UI. Multi-tenant Auth, anonymous account migration, custom Firestore database selection and automatic account deletion are outside this implementation.

## Recovery and format boundaries

Each backup has one stable identifier. Photos and the snapshot are uploaded before the complete index is published. A locally unreadable or malformed pending journal blocks a new backup, preserving the uncertain intent. Resume reconciles the same ID and validates existing snapshot/photo bytes; it never accepts a matching index alone as proof that its blobs exist. If you explicitly discard an unreadable intent, any remote objects remain private and require deliberate review in your own project. Automatic orphan cleanup and in-app backup deletion are not implemented.

Restore and guest copy first stage any chosen photos under the target owner's fresh wallet incarnation, then compare and save the unchanged empty target. Failed preparation does not save financial records. Unconfirmed photo cleanup is surfaced separately, including when records were already saved successfully; **Retry photo cleanup** retries that ownership check. A cancelled request or timeout cannot undo a write already accepted by a remote service.

| Item           | Boundary                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| Snapshot       | `mymoney-backup-v1`, strict supported ledger fields, at most 5 MiB                                    |
| Photos         | At most 100 attachments and 50 MiB combined; JPEG/PNG/WebP, at most 10 MiB per photo                  |
| Integrity      | SHA-256 over exact snapshot/image bytes; header dimensions and type checked during image restoration  |
| Index list     | Fifty newest completed backups                                                                        |
| Cloud identity | Firebase project plus UID; legacy local/Auth-emulator namespaces retain their previous encodings      |
| Restore        | Preview plus unchanged-empty-target compare-and-save; fresh wallet incarnation and photo ownership    |
| Requests       | Explicit operations with bounded waits and visible retry/recovery; no automatic cloud synchronization |

Firestore indexes use `users/{uid}/walletBackups/{backupId}`. Storage uses the same prefix with `snapshot.json` and `photos/{sha256}`. Unsupported extra ledger fields and oversized backups are rejected rather than silently leaked, dropped or partially represented as a completed backup. Client hash verification detects inconsistent content; access control still depends on the deployed rules and authenticated account.

## Reproduce the checks

The ordinary `npm.cmd test` suite includes pure format, identity, pending-journal, transport, coordinator and file-lifecycle checks. The SDK and rules checks below are deliberately separate: start only the documented local emulators, leave them running, then use another terminal at the repository root:

```powershell
$env:FYP_FIREBASE_RULES_TEST = '1'
node --test tools/firebase-backup/rules.test.cjs
node --test tools/firebase-backup/roundtrip.test.cjs
```

Both scripts install [emulatorOnly.cjs](emulatorOnly.cjs) before Firebase imports. It rejects fetch, socket and HTTP/2 destinations outside the three allowed loopback ports; unexpected destinations fail the gate. The guard has its own offline regression in the ordinary suite. These scripts accept no live-project override.

The rules gate uses invented owner A, owner B and anonymous callers, verifies allowed operations and rejected cross-owner/malformed/overwrite cases, and deletes only its test paths. The SDK gate creates a synthetic Auth user and passes a wallet plus receipt photo through the actual application Firestore/Storage ports, checking hashes, restored photo ownership and same-ID retry. It confirms its own object/account cleanup and prints only a network-destination summary. Seven rules checks and the SDK roundtrip have passed against the documented emulators with the network guard enabled.

For an Android manual check, use fictional records: save a guest expense, register a new account, preview/copy the guest wallet, confirm a backup, and reopen the guest to check that its source remains. A restore needs a deliberately empty account wallet; preserve any existing records before arranging that target. Preview and confirm the selected backup, then restart only the app while emulators remain running and verify the restored amounts and optional photos. A successful SDK gate does not replace this device workflow.

Emulator evidence does not establish hosted deployment, email delivery, production quotas, a clean-machine installation, physical-device behavior or iOS support. See [Verification](../../VERIFICATION.md) for the independently recorded Android checks and their exact limits.
