# Dependency review

Reviewed: 2026-10-18. Stack: Expo 58.0.14, React Native 0.88.0, React 19.3.0, Firebase 13.0.0 and `@noble/hashes` 2.4.0.

## Current pinned-graph audit

The publication review ran `npm audit --json --package-lock-only --ignore-scripts` separately against the app and both optional Firebase CLI lockfiles. Successful registry responses were obtained on 18 October 2026 with TLS certificate and hostname verification retained. The first attempts failed local issuer validation and produced no vulnerability verdict; retrying with the already configured local trust certificate in the audit processes succeeded. No global trust setting, dependency, lockfile or installed package was changed, and no install, upgrade or automatic fix ran.

| Pinned graph | Lock entries, excluding root | Current npm affected-package entries | Underlying advisories |
| --- | ---: | --- | --- |
| App `package-lock.json` | 612 | 20 high; no critical, moderate or low package entries | Four: braces, node-forge and two grpc-js advisories |
| Auth helper `tools/auth-emulator/package-lock.json` | 635 | 3 high and 4 moderate, total 7 | Three: braces, OpenTelemetry Core and UUID |
| Backup helper `tools/firebase-backup/package-lock.json` | 635 | 3 high and 4 moderate, total 7 | The same three advisories as the Auth helper |

The two helper graphs both pin `firebase-tools` 15.34.0 and were queried separately; their counts must not be added as independent defects. npm propagates underlying advisories through dependent packages and assigns each affected package entry its resulting severity. The app's low-severity grpc-js issue therefore does not appear as a separate low package count beside that package's high issue. Audit exit code 1 reflected these findings, not a failed registry request.

These results supersede the earlier Auth checkpoint's zero findings across 611 entries. The extra pinned app entry is the direct hash library; the currently reported advisories are not defects in that library. The previous 22, 15 and 16 affected-entry checkpoints below describe earlier graphs and advisory responses. A changed count, including zero, does not prove that dependency code was repaired. Private audit reports and before/after lock hashes were retained; all three lockfiles were byte-identical after this review.

To repeat the queries, run the command above from the repository root, then from each helper directory. Each lock is a separate graph; the default app check does not audit optional CLI packages, Python wheels, Java emulator binaries or downloaded model/runtime assets. The current advisory disposition is documented below rather than represented as an audit-clean result.

## Firebase accounts and manual backup

The installed Firebase 13.0.0 package, direct dependency and app lock agree. Its dependency/optional-dependency closure still contains **86 installed lock entries**, including dependencies shared with other packages. All 86 resolve to the official npm registry, carry SHA-512 integrity and match installed versions. This is a closure count, not a count of newly added packages.

The active source now imports **Firebase App, Auth, Firestore and Storage**. App/Auth manage explicitly configured accounts. Firestore holds immutable backup indexes and Storage holds validated snapshots and optional photo blobs. Ordinary financial edits remain device-local; uploads occur only through explicit manual backup. These imports do not add Analytics, automatic synchronization or an import of the original project's account/configuration. See [Firebase setup](tools/firebase-backup/README.md) for disabled defaults, emulator and own-project configuration, access rules and verification boundaries.

The documented installation uses lifecycle scripts disabled. Two packages in the Firebase closure declare postinstall hooks: `@firebase/util` 1.15.3 and `protobufjs` 7.6.6. Their source was rechecked. The utility hook can read environment-supplied web configuration, optionally contact its configuration endpoint and generate defaults. The protobuf hook inspects parent version notation and warns. Neither hook was executed during this review; the application uses explicit configuration rather than those generated defaults.

Auth 1.13.7 exposes its shipped React Native entrypoint and accepts AsyncStorage `^2.2.0 || ^3.0.0`; installed 2.2.0 satisfies that range. The narrow declaration for `getReactNativePersistence` does not modify SDK runtime files. Session hydration remains guarded against uncertain persistence and memory-only fallback. Configured accounts include the selected project in their financial ownership, while the older standalone Auth-emulator mode remains separate.

### Native Storage byte upload

Actual Android verification exposed an SDK upload path that attempted to construct a Blob from an ArrayBuffer view, which the tested React Native runtime rejected. The project now changes only the Firebase port's upload operation: a bounded multipart request sends actual `Uint8Array` bytes through the named `expo/fetch` implementation. Node verification supplies an explicitly guarded fetch instead. This adds no package, native module, Blob polyfill or native rebuild. SDK metadata/download operations and Firestore remain in use; this is not a replacement of Firebase authentication or access rules.

The repair passed focused transport checks and a real guarded emulator wallet/photo roundtrip, including a gate that forbids Blob construction. Native evidence confirmed recovery of the retained data-only backup under the same operation ID, data-only restore and app restart with the expected wallet preserved. Native Photo Picker attachment and photo-bearing backup upload/listing also passed. Native photo download/restoration and the resulting managed-file/restart checks were still in progress at this review checkpoint; [Verification](VERIFICATION.md) records their final status separately. No hosted Firebase account, live Storage deployment, email delivery or billing behavior is established by these local checks.

## Hash dependency provenance and scope

`@noble/hashes` 2.4.0 is a direct pinned dependency for SHA-256 content hashes used by backup integrity checks. Its installed manifest, versioned npm metadata and lock agree. The registry tarball URL and SHA-512 integrity exactly match the lock. It declares **no runtime dependencies and no preinstall/install/postinstall hooks**. The installed package and [upstream project](https://github.com/paulmillr/noble-hashes) identify the MIT license; preserve its included copyright/license notice when redistributing package code.

The app imports only `@noble/hashes/sha2.js` through [the byte-hash adapter](src/cloud/hash.js), accepting actual `Uint8Array` bytes and formatting the SHA-256 digest as hexadecimal. The inspected SHA-2 import closure uses local JavaScript modules; this operation does not need a random-number polyfill, network request or native crypto package. The package's Node requirement is `>=20.19.0`, satisfied by the project's Node 24 toolchain. Hashes detect content mismatch; they do not encrypt backups or replace account authorization and rules. Package provenance, focused tests and upstream audit claims are not an independent cryptographic audit of version 2.4.0.

## Optional provider dependency boundaries

The Windows OCR path still uses the installed Windows engine. OpenAI and Google Vision use server-side adapters with fixed provider endpoints and no added provider SDK package; their keys remain outside the mobile bundle. The local assistant runtime/model and the optional Flask/Prophet environment are installed separately under their documented manifests/locks. npm audits do not establish the safety, compatibility or quality of those binaries/models, or successful access to a live paid provider. See [companion setup](scripts/companion/README.md) and [Prophet setup](tools/forecast/README.md).

## Android development bundle inclusion check

On 18 October 2026, the running local Metro manifest was checked against this repository before reading its actual Android launch asset and corresponding version 3 source map. Requests were restricted to that loopback Metro instance; the server, build flags, app state and device were not changed. The bundle's embedded source-map URL matched the fetched map. The private capture contained a 9,462,176-byte bundle, an 18,937,631-byte map and **1,320 source paths**.

| Source-map inventory | Observed in this capture |
| --- | --- |
| `@firebase/firestore/dist/index.rn.js` | Present |
| Firestore Node entry variants | No matching source path |
| `@firebase/storage/dist/index.esm.js` | Present |
| `@noble/hashes` | Four paths: `sha2.js`, `_md.js`, `_u64.js` and `utils.js` |
| `@grpc/grpc-js`, `braces`, `node-forge`, npm `uuid`, `@opentelemetry/*` | No matching source paths |
| Expo's own UUID helpers | Three paths under `expo-modules-core/build/uuid`; these are distinct from the npm `uuid` dependency |

This is direct module-inclusion evidence for the served Android **development entry bundle**, including its selected Firebase React Native transport. It is narrower than the complete installed/locked dependency graph. The entry used lazy development loading, so this inventory does not cover every later-loaded chunk, a production/release bundle, iOS, native binaries, copied implementations or all executable behavior. Absence of a package path is not an exhaustive vulnerability proof. The unresolved source advisories, independent CLI audit results and scoped follow-up below remain unchanged.

## Earlier feature dependency reviews

The receipt branch reuses Expo ImagePicker 58.0.10 and FileSystem 58.0.9; it adds no app package dependency or OCR SDK. Android camera permission is now explicitly declared, and the ImagePicker plugin has a camera-purpose string. `RECORD_AUDIO`, contact writes and background location remain blocked. The camera action also requires the explicit receipt-camera UI flag and requests permission only after that action. The changed native configuration requires the rebuilt project APK; this does not establish physical-device or iOS camera verification.

At the receipt checkpoint, recognition used the Windows host's installed OCR engine through the separately documented loopback companion. The current explicit Vision alternative is described above. Its host code uses Python/Node standard libraries and existing dependency-free app modules. OCR-only operation does not import or download an LLM. The optional assistant's pinned archives/model and runtime profile are documented in the companion guide, with separate startup/quality gates; runtime assets alone do not establish availability or answer quality; the current assistant UI uses the explicitly selected provider.

The PDF/QR branch adds Expo Print 58.0.6, Sharing 58.0.19, React Native SVG 15.16.0 and QRCode SVG 6.3.26. All 39 changed lockfile entries resolve to the official npm registry, carry SHA-512 integrity and have no preinstall/install/postinstall hooks; installation disabled lifecycle scripts. Its checkpoint audit reported 16 high-severity dependency entries, discussed below. The QR dependency also brings deprecated `text-encoding` 0.7.0; retain that maintenance limitation when evaluating an encoder upgrade.

Print and Sharing are loaded only after an explicit action and an optional native-module capability check. This prevents Metro's failed-module error overlay when an older installed binary lacks those native modules. The QR runtime is loaded only when the code is shown, beneath its error boundary. Outgoing file sharing requires no incoming-share extension configuration. Android's native print width and height are integer fields, so the adapter uses rounded A4 dimensions of 595 by 842 at 72 PPI.

Native verification exposed an Expo Print page-count defect: its Android API reported 10 pages for a generated PDF independently parsed and rendered as 2 pages. A separate first request produced valid bytes but never completed its JavaScript promise; the exact triggering lifecycle gap is unproven. The [reviewed Android printing repair](plugins/expo-print-58.0.6/README.md) retains the renderer, follows layout/write callbacks, handles terminal failures and reads the actual completed PDF page count. Its config plugin checks exact version/source hashes, and `expo.autolinking.android.buildFromSource` ensures the repaired Kotlin is compiled instead of Expo's prebuilt publication. Android generation requires the repair's native capability marker. Rebuilding the project app is necessary; Expo Go cannot acquire this repair through a JavaScript reload.

The transaction-context branch adds Expo ImagePicker 58.0.10, Contacts 58.0.7, Location 58.0.17, a direct FileSystem 58.0.9 dependency, and MapLibre React Native 11.5.0. All 21 changed dependency entries resolve to the official npm registry with SHA-512 integrity and no install hooks; installation disabled lifecycle scripts. Its checkpoint audit reported 16 high-severity dependency entries propagated from the same two underlying advisories below. MapLibre's declared React Native/React/Expo ranges accept the selected stack; exact native compatibility is checked through this project's Android build.

At the transaction-context checkpoint, native configuration blocked camera access as well as contact writes, microphone and background location for that gallery-only feature. The receipt camera change is described above. Contacts are still selected and read only after an explicit action. Android allowBackup is disabled; this is not a claim that every OEM's device-transfer behavior is prevented. Map tiles come from the public OpenFreeMap service, with attribution and online availability limits documented in the transaction-context guide.

The local-reminders branch adds `expo-notifications` 58.1.5, matching the installed Expo SDK's bundled-module range. Installation used lifecycle scripts disabled. The six changed dependency entries all resolved to the official npm registry with SHA-512 integrity values and no install hooks. That checkpoint reported 15 high-severity entries from the then-reviewed paths; no forced dependency downgrade was applied. The app uses local notification permissions and scheduling, without requesting remote push tokens.

## Local notification import compatibility

The Android Expo Go 58.0.4 preview failed at package import because `expo-notifications` 58.1.5 eagerly re-exports `topicSubscription`, which requires `ExpoTopicSubscriptionModule`; that remote-push module is absent from this Expo Go binary. The package root also imports remote token auto-registration code. `src/reminders/localNotifications.ts` is a version-specific facade over the same installed package's shipped `build/` modules, exporting only the local APIs, enums, and types used by the app. Extensionless entrypoints preserve Metro's Android/native resolution. No package files, native modules, token registration, or package versions were changed to work around this import failure.

The facade dependency-graph tests inspect Android and iOS module resolution and reject package-root, topic, push-token, auto-registration, and background-task dependencies. Adapter unit tests use a mocked local facade; native delivery was separately verified in the installed project APK. Reassess this boundary whenever `expo-notifications` or the native preview binary changes. This workaround does not claim native iOS verification or remove Expo Go's other limitations.

The actual Expo Go 58.0.4 Android runtime also exposes `ExpoNotificationChannelManager` without its required `NotificationsChannelsProvider`. Native permission queries worked, but both channel lookup and a minimal channel-creation request threw a null-pointer error; omitting the optional channel sound setting did not repair it. The adapter now identifies this specific Android Expo Go capability gap and reports that reminders require the project's installed Android app. Scheduling controls are unavailable there; saved-data inspection, deletion/recovery, and financial features remain accessible. The check deliberately does not inspect this optional JavaScript module in a standalone app, where absence from the JS registry does not establish missing native support. Real reminder scheduling/presentation is gated on the installed Android build, not inferred from Expo Go achievement checks.

The initial npm audit reported 22 affected dependency entries arising from three distinct advisories. npm propagates an advisory through dependent packages, so that count does not represent 22 independent defects. This review inspected the installed dependency paths and relevant call sites; it is not a complete security assessment or proof that the application bundle has no vulnerable code.

## Current upstream advisories and reviewed use

The following primary advisory pages were rechecked on 18 October 2026. Retaining a compatible pin with a scoped usage assessment does not repair the upstream package.

| Package in the app lock | Current primary advisory status | Inspected project use and follow-up |
| --- | --- | --- |
| `braces` 3.0.3 | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): high, `<=3.0.3`, no patched version listed. Registry latest remains 3.0.3. | Metro/micromatch use it for development file matching. Deeply nested untrusted patterns can exhaust the call stack. The documented local workflow uses repository-selected patterns; it has no user-supplied glob feature. Reassess for untrusted configuration/input and an upstream fix. |
| `node-forge` 1.4.0 | [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv): high, `<=1.4.0`, no patched version listed. Registry latest remains 1.4.0. The [upstream proposed fix](https://github.com/digitalbazaar/forge/pull/1152) remains open. | Expo CLI/certificate helpers include the affected RSA signature-verification code. The local preview does not perform an exposed user-certificate verification service. Keep build/signing use within its reviewed scope and reassess before accepting untrusted signatures or a release-signing workflow. |
| `@grpc/grpc-js` 1.9.16 | [GHSA-m9gg-hp2v-232j](https://github.com/advisories/GHSA-m9gg-hp2v-232j), high, and [GHSA-f596-whhp-79r4](https://github.com/advisories/GHSA-f596-whhp-79r4), low: fixed in 1.13.6 and 1.14.5; affected ranges include `<1.13.6` and `>=1.14.0 <1.14.5`. | Firestore 4.18.0 pins `~1.9.0` for its Node transport. Its declared React Native entrypoint has no grpc import; its Node entrypoint imports grpc. The project does not implement a gRPC server or use `getAuthContext`/`ServerCredentials`. A compatible upstream dependency update still needs review; the installed version remains in the reported range. |

The grpc-js high advisory concerns server authentication when client certificates are optional and the application trusts `getAuthContext`; the low advisory concerns server-handler error text returned to clients. The app's Firebase SDK usage is client-side, and its emulator test calls are client calls to explicitly local services. That is the inspected exposure distinction, not a claim that a release bundle has been exhaustively audited or that every SDK use is unaffected.

The two CLI locks also contain `braces` 3.0.3. Each contains `@opentelemetry/core` 1.30.1 through `@google-cloud/pubsub` 5.3.1: [GHSA-8988-4f7v-96qf](https://github.com/advisories/GHSA-8988-4f7v-96qf) concerns inbound baggage parsing without bounds and lists 2.8.0 as patched. Each also contains `uuid` 9.0.1 through `gaxios` 6.7.1, within [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)'s affected range. The inspected gaxios caller uses `v4()` without a supplied output buffer; that is narrower than the advisory's affected v3/v5/v6 buffer paths, not a general exemption for the package.

These optional CLI packages are development tools, not mobile imports. The documented emulator commands select local Auth/Firestore/Storage with synthetic demo projects; they do not enable a hosted Pub/Sub service. Keep their exposure bounded to that documented use and review compatible tool updates before widening it. A direct force override of OpenTelemetry across major versions or a new gRPC minor outside Firebase's requested range has not been compatibility-tested here.

The current disposition is to retain the unchanged pins for the documented educational/local workflow while recording these findings and the follow-up, rather than advertise zero vulnerabilities. No npm audit suppression or fabricated patched version was applied. Source publication is separate from exposing a service or distributing a production-signed app.

## Scoped UUID override

`package.json` overrides only `xcode`'s `uuid` dependency to 11.1.1. [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) affects `<11.1.1`, `>=12.0.0 <12.0.1`, and `>=13.0.0 <13.0.1`; 11.1.1 is explicitly patched. The defect concerns v3/v5/v6 methods with caller-provided buffers.

The current app override remains verified as 11.1.1 in the lock; the upstream advisory still lists that version as patched. It does not apply to either independent Firebase CLI lock, where UUID remains 9.0.1.

The inspected `xcode` 3.0.1 caller uses CommonJS `require('uuid').v4()` without a supplied buffer. Version 11.1.1 retains CommonJS support; later major versions change that loading contract. After installation, the UUID-generation smoke check passed and that checkpoint's repeated audit no longer reported this advisory. Its remaining result was 15 high-severity dependency entries propagated from the two upstream advisories above. Remove the override when an upstream dependency update makes it unnecessary.

## Local preview and public release

### Windows native object paths

The PDF/QR Android build initially failed when Ninja 1.10.2, bundled with SDK CMake 3.30.5, tried to create a 262-character SVG code-generation directory. The installed Expo root Gradle plugin defaults `CMAKE_OBJECT_PATH_MAX` to 1024 and supports overriding it with `expo.android.cmakeObjectPathMax`. Setting 240 makes CMake hash long object paths. The successful retry had maximum generated object paths of 238 characters for the app/SVG graph and 219 for Expo's native core.

After generating the Android project and configuring the required JDK/SDK, include the supported property in the Windows build command. For this project's local x86_64 debug verification, from the generated `android` directory:

```powershell
.\gradlew.bat :app:assembleDebug -Pexpo.android.cmakeObjectPathMax=240 -Pandroid.cmakeVersion=3.30.5 -PreactNativeArchitectures=x86_64 --max-workers=2 --no-daemon
```

The equivalent generated Gradle setting is `expo.android.cmakeObjectPathMax=240`. Generated native directories are ignored, so retain the command-line argument when regenerating them. This workaround changes object-file paths; no dependency source or host long-path policy was changed. The resulting debug APK is for local emulator testing and requires Metro. It is not a production-signed release.

The present development scope is an Android emulator preview using synthetic local data and a localhost Metro server. No certificate verification workflow or user-supplied glob configuration is part of the intended preview. This bounds the reviewed use; it does not repair the upstream findings above or establish safety for untrusted networks or inputs.

The current publication review refreshed the pinned-graph audits and upstream advisory status as recorded above. Before a later dependency update, hosted deployment or signed application release, repeat the relevant review of current fixes, actual bundle reachability, build/signing paths and enabled features. Preserve the specific exposure limits and reassess compatible fixes; a successful local preview alone is not production-release acceptance.

Do not apply `npm audit fix --force` blindly. The refreshed audit again proposes Expo 44.0.6 and React Native 0.72.17, and proposes Firebase 9.14.0 or Firebase CLI 14.23.0 for their graphs, which would replace the selected compatible stack. Evaluate dependency changes against Expo's version requirements and rerun the application checks.
