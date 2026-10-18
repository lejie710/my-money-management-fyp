# Dependency review

Reviewed: 2026-10-18. Stack: Expo 58.0.14, React Native 0.88.0, React 19.3.0.

## Optional local Firebase Auth

The account branch pins Firebase 13.0.0. The installed package, direct dependency and lockfile agree. Its dependency/optional-dependency closure contains 86 installed lock entries, including shared dependencies already present; this is not a count of newly added packages. All 86 resolve to `registry.npmjs.org`, have SHA-512 integrity and match their installed versions. The app imports Firebase App and Auth only; the SDK's wider package inventory does not enable cloud databases, analytics or financial synchronization.

Installation disabled lifecycle scripts. Two packages in that closure declare postinstall hooks: `@firebase/util` 1.15.3 and `protobufjs` 7.6.6. The inspected Firebase utility hook can read environment-provided web configuration, optionally fetch a web configuration endpoint and write generated defaults. The protobuf hook inspects the parent dependency's version notation and emits warnings. Neither hook was executed for this installation. The app supplies explicit local emulator configuration and does not depend on environment-generated cloud defaults.

Firebase's Auth 1.13.7 package exposes its shipped React Native entrypoint and declares AsyncStorage `^2.2.0 || ^3.0.0`; the installed 2.2.0 satisfies that range. A narrow TypeScript declaration exposes `getReactNativePersistence` from the public Firebase Auth facade without changing SDK runtime files. The adapter connects the fixed loopback emulator and identity-change middleware synchronously before its first awaited hydration. The SDK persistence guard treats session values as opaque bytes and refuses uncertain storage or memory-only fallback. These source checks and the passing app suite do not replace Android session-restoration verification.

The current `npm audit --json` request completed successfully and reported **zero vulnerabilities across 611 dependency entries**. This differs from the preceding PDF/QR checkpoint's 16 high-severity entries. `braces` remains 3.0.3 and `node-forge` remains 1.4.0, so that report alone is not evidence that the earlier reviewed code risks were repaired. The historical advisory discussion below remains relevant context for a future publication/release review; it is not the current npm report count. No forced dependency upgrade or downgrade was applied.

The optional Auth emulator CLI is separate development tooling with its own pinned manifest and lockfile under `tools/auth-emulator`. Its installation, runtime ownership, export/import and audit status are documented there; the app SDK audit does not cover that independent CLI graph.

## Earlier feature dependency reviews

The receipt branch reuses Expo ImagePicker 58.0.10 and FileSystem 58.0.9; it adds no app package dependency or OCR SDK. Android camera permission is now explicitly declared, and the ImagePicker plugin has a camera-purpose string. `RECORD_AUDIO`, contact writes and background location remain blocked. The camera action also requires the explicit receipt-camera UI flag and requests permission only after that action. The changed native configuration requires the rebuilt project APK; this does not establish physical-device or iOS camera verification.

Receipt recognition is performed by the Windows host's installed OCR engine through the separately documented loopback companion. Its host code uses Python/Node standard libraries and existing dependency-free app modules. OCR-only operation does not import or download an LLM. The optional assistant's pinned archives/model and runtime profile are documented in the companion guide, with separate startup/quality gates; their presence does not mean the receipt app has an active assistant UI.

The PDF/QR branch adds Expo Print 58.0.6, Sharing 58.0.19, React Native SVG 15.16.0 and QRCode SVG 6.3.26. All 39 changed lockfile entries resolve to the official npm registry, carry SHA-512 integrity and have no preinstall/install/postinstall hooks; installation disabled lifecycle scripts. Its checkpoint audit reported 16 high-severity dependency entries, discussed below. The QR dependency also brings deprecated `text-encoding` 0.7.0; retain that maintenance limitation when evaluating an encoder upgrade.

Print and Sharing are loaded only after an explicit action and an optional native-module capability check. This prevents Metro's failed-module error overlay when an older installed binary lacks those native modules. The QR runtime is loaded only when the code is shown, beneath its error boundary. Outgoing file sharing requires no incoming-share extension configuration. Android's native print width and height are integer fields, so the adapter uses rounded A4 dimensions of 595 by 842 at 72 PPI.

Native verification exposed an Expo Print page-count defect: its Android API reported 10 pages for a generated PDF independently parsed and rendered as 2 pages. A separate first request produced valid bytes but never completed its JavaScript promise; the exact triggering lifecycle gap is unproven. The [reviewed Android printing repair](plugins/expo-print-58.0.6/README.md) retains the renderer, follows layout/write callbacks, handles terminal failures and reads the actual completed PDF page count. Its config plugin checks exact version/source hashes, and `expo.autolinking.android.buildFromSource` ensures the repaired Kotlin is compiled instead of Expo's prebuilt publication. Android generation requires the repair's native capability marker. Rebuilding the project app is necessary; Expo Go cannot acquire this repair through a JavaScript reload.

The transaction-context branch adds Expo ImagePicker 58.0.10, Contacts 58.0.7, Location 58.0.17, a direct FileSystem 58.0.9 dependency, and MapLibre React Native 11.5.0. All 21 changed dependency entries resolve to the official npm registry with SHA-512 integrity and no install hooks; installation disabled lifecycle scripts. Its checkpoint audit reported 16 high-severity dependency entries propagated from the same two underlying advisories below. MapLibre's declared React Native/React/Expo ranges accept the selected stack; exact native compatibility is checked through this project's Android build.

At the transaction-context checkpoint, native configuration blocked camera access as well as contact writes, microphone and background location for that gallery-only feature. The receipt camera change is described above. Contacts are still selected and read only after an explicit action. Android allowBackup is disabled; this is not a claim that every OEM's device-transfer behavior is prevented. Map tiles come from the public OpenFreeMap service, with attribution and online availability limits documented in the transaction-context guide.

The local-reminders branch adds `expo-notifications` 58.1.5, matching the installed Expo SDK's bundled-module range. Installation used lifecycle scripts disabled. The six changed dependency entries all resolved to the official npm registry with SHA-512 integrity values and no install hooks. The resulting audit still reports the same 15 high-severity entries described below; no forced dependency downgrade was applied. The app uses local notification permissions and scheduling, without requesting remote push tokens.

## Local notification import compatibility

The Android Expo Go 58.0.4 preview failed at package import because `expo-notifications` 58.1.5 eagerly re-exports `topicSubscription`, which requires `ExpoTopicSubscriptionModule`; that remote-push module is absent from this Expo Go binary. The package root also imports remote token auto-registration code. `src/reminders/localNotifications.ts` is a version-specific facade over the same installed package's shipped `build/` modules, exporting only the local APIs, enums, and types used by the app. Extensionless entrypoints preserve Metro's Android/native resolution. No package files, native modules, token registration, or package versions were changed to work around this import failure.

The facade dependency-graph tests inspect Android and iOS module resolution and reject package-root, topic, push-token, auto-registration, and background-task dependencies. Adapter unit tests use a mocked local facade; native delivery was separately verified in the installed project APK. Reassess this boundary whenever `expo-notifications` or the native preview binary changes. This workaround does not claim native iOS verification or remove Expo Go's other limitations.

The actual Expo Go 58.0.4 Android runtime also exposes `ExpoNotificationChannelManager` without its required `NotificationsChannelsProvider`. Native permission queries worked, but both channel lookup and a minimal channel-creation request threw a null-pointer error; omitting the optional channel sound setting did not repair it. The adapter now identifies this specific Android Expo Go capability gap and reports that reminders require the project's installed Android app. Scheduling controls are unavailable there; saved-data inspection, deletion/recovery, and financial features remain accessible. The check deliberately does not inspect this optional JavaScript module in a standalone app, where absence from the JS registry does not establish missing native support. Real reminder scheduling/presentation is gated on the installed Android build, not inferred from Expo Go achievement checks.

The initial npm audit reported 22 affected dependency entries arising from three distinct advisories. npm propagates an advisory through dependent packages, so that count does not represent 22 independent defects. This review inspected the installed dependency paths and relevant call sites; it is not a complete security assessment or proof that the application bundle has no vulnerable code.

## Unresolved upstream advisories

| Package            | Advisory and affected range                                                                        | Inspected use and current limitation                                                                                                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `braces` 3.0.3     | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), high severity, `<=3.0.3` | Reached through `micromatch` in Metro's file-watcher glob matching. Deeply nested, attacker-controlled brace patterns can exhaust the Node.js call stack. The advisory lists no patched version; the npm registry's latest version at review was 3.0.3.                       |
| `node-forge` 1.4.0 | [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv), high severity, `<=1.4.0` | Included by Expo CLI and certificate helpers, with inspected call sites in code-signing tooling. The issue concerns malformed RSA PKCS#1 v1.5 signatures and low-exponent keys. The advisory lists no patched version; the npm registry's latest version at review was 1.4.0. |

These packages arrive through development/build tools, even though npm can classify their dependency paths as production dependencies under `expo` and `react-native`. Dependency classification alone does not establish whether a vulnerable operation is reachable in a mobile release.

## Scoped UUID override

`package.json` overrides only `xcode`'s `uuid` dependency to 11.1.1. [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) affects `<11.1.1`, `>=12.0.0 <12.0.1`, and `>=13.0.0 <13.0.1`; 11.1.1 is explicitly patched. The defect concerns v3/v5/v6 methods with caller-provided buffers.

The inspected `xcode` 3.0.1 caller uses CommonJS `require('uuid').v4()` without a supplied buffer. Version 11.1.1 retains CommonJS support; later major versions change that loading contract. After installation, the UUID-generation smoke check passed and that checkpoint's repeated audit no longer reported this advisory. Its remaining result was 15 high-severity dependency entries propagated from the two upstream advisories above. Remove the override when an upstream dependency update makes it unnecessary.

## Local preview and public release

### Windows native object paths

The PDF/QR Android build initially failed when Ninja 1.10.2, bundled with SDK CMake 3.30.5, tried to create a 262-character SVG code-generation directory. The installed Expo root Gradle plugin defaults `CMAKE_OBJECT_PATH_MAX` to 1024 and supports overriding it with `expo.android.cmakeObjectPathMax`. Setting 240 makes CMake hash long object paths. The successful retry had maximum generated object paths of 238 characters for the app/SVG graph and 219 for Expo's native core.

After generating the Android project and configuring the required JDK/SDK, include the supported property in the Windows build command. For this project's local x86_64 debug verification, from the generated `android` directory:

```powershell
.\gradlew.bat :app:assembleDebug -Pexpo.android.cmakeObjectPathMax=240 -Pandroid.cmakeVersion=3.30.5 -PreactNativeArchitectures=x86_64 --max-workers=2 --no-daemon
```

The equivalent generated Gradle setting is `expo.android.cmakeObjectPathMax=240`. Generated native directories are ignored, so retain the command-line argument when regenerating them. This workaround changes object-file paths; no dependency source or host long-path policy was changed. The resulting debug APK is for local emulator testing and requires Metro. It is not a production-signed release.

The present development scope is an Android emulator preview using synthetic local data and a localhost Metro server. No certificate verification workflow or user-supplied glob configuration is part of the intended preview. This bounds the reviewed use; it does not repair the two upstream defects or authorize exposing development tooling to untrusted networks or inputs.

Before making the repository public or distributing a release, repeat the audit and review current upstream fixes, the actual release bundle, build/signing paths, and any newly enabled features. Resolve applicable issues or document a specific, reviewed exception with its exposure and follow-up. A successful local preview is not public-release acceptance.

Do not apply `npm audit fix --force` blindly. The initial audit proposed downgrading Expo to 44.0.6 and React Native to 0.72.17, which would replace the selected compatible stack. Evaluate dependency changes against Expo's version requirements and rerun the application checks.
