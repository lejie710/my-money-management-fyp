# Local Auth emulator

This is the reproducible Windows owner for the app's **synthetic local account demo**. It uses Firebase CLI 15.34.0 from this separate tool package, the fixed project `demo-fyp-local`, and loopback ports 9099 (Auth), 4409 (hub) and 4500 (logging). The Firebase UI is disabled. The mobile app uses its own Firebase SDK 13.0.0 dependency; the CLI is not part of the mobile bundle.

This public layout passed its real Windows runtime gate on 18 October 2026: three owned starts and graceful stops, empty-database export/import, and two synthetic accounts retaining their UIDs, profile names and working passwords through export/import. The final check confirmed all owned processes and the three listeners stopped. The earlier Node SDK proof is described in [Account access](../../docs/ACCOUNT_ACCESS.md); Android evidence is recorded separately in [Verification](../../VERIFICATION.md).

## Install the pinned tool package

Use Windows, Node 24 (development checked with 24.22.0), and Python 3.12 or newer. No Java emulator is needed for this Auth-only target. From this folder, explicitly install its separate package:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
```

This command downloads npm dependencies; it never logs into Firebase or starts an emulator. The lock was prepared offline from cached metadata and has 636 entries, all tarball resolutions under the official npm registry. It pins only `firebase-tools` 15.34.0 as the direct tool dependency. Installation scripts stay disabled, matching the earlier working Auth probe. No native RE2 build or extra artifact download is authorized by these instructions. Check installation failures rather than enabling scripts automatically.

The CLI has a large dependency tree containing services this helper does not use. The earlier broader development probe reported dependency advisories; this source package is not a clean security-audit or production-security claim. Upgrade the pinned CLI only as a reviewed tool change, then rerun the ownership, import/export and runtime gates.

## Start a new owned run

```powershell
python run_auth.py --run-name learning-001
```

If Node 24 is not the `node.exe` on PATH, pass its explicit path using `--node`. The owner remains running in this terminal; its Node child is hidden. Use a second terminal for the control commands below. Automated execution should launch the owner through the existing hidden/background executor, not open another desktop window.

Every run name is new and lowercase. The helper refuses existing listeners on any of the three fixed ports and does not reuse or stop another service. It also refuses an existing owner lock. If the private development probe or another project's emulator is still using these ports, stop it through its own verified owner before starting this helper.

The child waits for bounded stdin before importing Firebase. Its exact process handle is assigned to a Windows Job first. Fresh task-local Configstore, cache, data and temporary directories are installed under the run folder; no previous Firebase login is read. Usage tracking and update notifications are disabled. The wrapper supports only the fixed Auth start and graceful shutdown paths; there is no cloud login, deploy, project creation or account creation command.

Raw CLI console/debug transports are disabled in this child because Auth output can include local reset links. The owner prints only fixed lifecycle stages and records non-secret ownership/status metadata. These are application logging choices, not changes to Windows monitoring, firewall or host security policy.

Wait for a `ready-auth-only-loopback-*` stage before using the app. Readiness requires the exact live child PID to own all three loopback listeners, the matching CLI version in the hub, only Auth/hub/logging in the emulator registry, and a responsive demo project. If importing a saved snapshot, the imported account IDs and email/display-name fields must match it before readiness is published. Password behavior still needs a deliberate login check; the launcher does not know user passwords.

## Export, stop and restart

From another terminal in this folder:

```powershell
python control.py export --run-name learning-001
python control.py stop --run-name learning-001
```

`export` takes a fresh point-in-time snapshot and leaves the service running. `stop` first performs a new export, verifies its files and integrity record, then requests the pinned CLI's `cleanShutdown`. It waits for the child and drains the exact owned Job. No process is killed by a saved PID or broad executable name. A failed graceful stop is reported as unconfirmed even if the final owned-process cleanup succeeds.

Control requests are completely written and flushed before atomic, non-overwriting publication. The owner cannot consume a half-written request. An export must contain an explicit account list; a missing list is a failure, not evidence that the database is empty. The version-pinned CLI supplies that list even for an empty database.

Finish account operations and close the app before stopping the emulator. Export is a snapshot, not a transaction spanning concurrent clients; a new registration or reset after export begins could otherwise miss that snapshot. A failed export returns before any stop effect and leaves the service running for a deliberate retry. The control tool never repeats a timed-out request automatically.

After a confirmed stop, start with a new run name:

```powershell
python run_auth.py --run-name learning-002
```

The helper imports only its last confirmed export. It verifies all hashes before startup and refuses changed or unreadable exports instead of silently creating an empty replacement. Source downloads, old runs and failed partial exports are retained; no cleanup sweep is performed. An abnormal loss after readiness retains the owner lock and summary for inspection. Do not delete that lock or overwrite exports just to make startup proceed; first establish the actual process/port state and whether the latest account changes were exported.

## Private runtime data

All mutable state is beneath the app's ignored `.runtime/auth-emulator` by default:

```text
.runtime/auth-emulator/
  owner-lock.json
  last-export.json
  runs/<run-name>/owner.json, status.json, summary.json
  runs/<run-name>/requests/, responses/, cli-config/, tmp/
  exports/snapshot-<request-id>/
    firebase-export-metadata.json
    auth_export/accounts.json, config.json
    export-integrity.json
```

Account exports contain authentication/profile data, including password hashes. Keep the entire `.runtime` tree out of Git. This package includes no account data, old credentials, probe runtime, corporate certificates or installed node_modules. `--runtime-root` accepts only an explicit child of this app's ignored `.runtime` directory. The app's guest/account ledgers and photos live separately on the Android device; exporting Auth does not back them up.

## App connection and verification

The restored App enables local Auth only with `EXPO_PUBLIC_LOCAL_AUTH_EMULATOR=1`. That flag selects the fixed demo endpoint, not a cloud project. The owned Android emulator needs its separately verified 9099 ADB reverse mapping; this host helper never creates an emulator, changes forwarding, installs an APK or opens the app. Root integration owns that device step. Configured account access is not proof that the backend is reachable or a native session is durable.

Run the source-only checks:

```powershell
python tests/test_lifecycle.py
node --test tests/cli-child.test.cjs
```

The current 19 Python and 4 Node checks use injected APIs and temporary synthetic files. They cover occupied/foreign ports, strict readiness, redirect/proxy refusal, export integrity and failed-export preservation, explicit empty-versus-missing account lists, imported identity comparison, atomic request publication, graceful shutdown ordering, exact owner verification, isolated CLI configuration, disabled raw logs, bounded stdin and unsupported paths/version rejection. The port snapshot uses a fixed read-only PowerShell command without changing execution policy; it does not depend on permission to run a script file. These checks do not start a real service, create an account, contact a device or prove native persistence.

The real runtime gate used a separate ignored synthetic database. It verified a genuinely empty export/import, created two distinct accounts and profile names, explicitly exported, stopped gracefully, imported in a new owned run, and signed in using the same passwords with the same UIDs and imported profile names. Every run confirmed export completion, graceful process shutdown and owned-process completion; the final gate also checked the released ownership lock and clear ports. Passwords and tokens were never printed or committed. This is local emulator behavior, not cloud authentication, email delivery or production-security validation.

An initial gate run used an incorrect administrative header for a client profile request; it was preserved as a failed result and its owned processes stopped. The corrected gate keeps client and admin API requests separate and checks profile names in the imported account records because the pinned emulator's login response does not return them. Its request/response regression tests passed independent review before the successful full rerun. No helper behavior was relaxed to obtain the runtime pass.

Re-run the real lifecycle gate after changing the pinned CLI or ownership/export implementation. Android account/guest isolation, session restoration, profile and local-reset behavior remain separate application evidence.
