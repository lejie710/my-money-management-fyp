# Build and run on Windows and Android

This source project can generate a local Android debug application with Expo. The project does not distribute an APK or require an Expo cloud account. A debug build loads JavaScript from the development server and is intended for local study and verification.

**Verification status, 18 October 2026:** dependency installation, fresh Android project generation and the x86_64 debug build completed from this repository's source using an existing Windows toolchain and dependency caches. The resulting APK passed signature/alignment checks, installed as a data-preserving update in an isolated API 35 emulator, restored an expense, budget and savings goal, and generated a native report PDF. The build took 11 minutes 54 seconds on that host; this is an observation, not an installation-time estimate. A clean computer, ARM phone, production release and iOS remain unverified. See [Verification](../VERIFICATION.md) for the complete checkpoint.

## Prerequisites

Use a short checkout path such as `C:\src\money`. Install the following through the official Node.js, JDK, and Android SDK distributions before building. The helper checks their presence; it does not install an SDK, accept licenses, modify host security settings, or download a model.

| Tool                                    | Selection for this pinned project                                       | Purpose                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Node.js                                 | Node 24.12 or later within Node 24; development used 24.22.0            | Expo, JavaScript tests, and build helpers                                 |
| Java                                    | JDK 17                                                                  | Gradle and Android compilation                                            |
| Android SDK command-line/platform tools | Include `adb` and the SDK package manager                               | Install SDK components and connect the emulator                           |
| Android platform                        | SDK package `platforms;android-37.0`                                    | Compile SDK 37; the package identifier includes `.0`                      |
| Android Build-Tools                     | `37.0.0` and `36.0.0`                                                   | The app selects 37; a native dependency required 36 in the recorded build |
| NDK                                     | `27.1.12297006`                                                         | Native module compilation                                                 |
| CMake                                   | `3.30.5`                                                                | Generate native build files                                               |
| Emulator                                | Android API 35, Google APIs, x86_64, with working hardware acceleration | The verified development target; this is distinct from compile SDK 37     |

The pinned Expo template selects Gradle 9.4.1. The installed React Native catalog selects Android Gradle Plugin 9.2.1, minimum SDK 24, target SDK 36, and compile SDK 37. Do not lower the compile SDK to match the emulator image.

Configure `JAVA_HOME` and `ANDROID_HOME` for your installed tools and put Node, Java, and Android platform-tools on PATH. Keep a short Gradle cache outside the repository:

```powershell
$env:GRADLE_USER_HOME = 'C:\g\money'
```

Use a directory you own. This setting applies to the current terminal; set it again in a new terminal or configure your own persistent environment. Do not copy another computer's certificates, SDK path files, signing material, or generated native directory into this repository.

## Install the JavaScript dependencies

From the repository root:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd test
npm.cmd run typecheck
```

The install downloads the pinned npm dependencies. Installation hooks remain disabled. The separately documented account and companion helpers have their own optional setup; they are not required to build the financial app.

## Generate and inspect the Android project

```powershell
node scripts/build-android.cjs --prebuild-only
```

The helper uses the installed Expo CLI and bundled template with `--platform android --no-install --no-clean`. It generates `android/` only when that directory is absent. If an Android directory already exists, it preserves it and skips prebuild, so hand-edited native files are not silently regenerated. It rejects a failed or timed-out prebuild even if the command printed a completion message. Generated partial output is retained for inspection.

The generated wrapper must select the reviewed Gradle 9.4.1 distribution. The helper adds its recorded SHA-256 when absent and refuses an unexpected distribution URL, a different checksum, or duplicate distribution properties. It preserves other wrapper settings. The expected distribution hash is `2ab2958f2a1e51120c326cad6f385153bb11ee93b3c216c5fccebfdfbb7ec6cb`.

Review native changes before intentionally regenerating after a plugin/configuration update. The helper does not clear or repair an existing native directory. A successful `--prebuild-only` result proves generation/wrapper checks, not compilation or working device behavior.

## Build the debug application

```powershell
node scripts/build-android.cjs
```

Gradle can download its pinned distribution and Maven dependencies on the first build. Missing Android SDK packages fail explicitly because SDK auto-installation is disabled. The helper invokes the generated Gradle wrapper entry point through the selected Java executable without Windows shell interpolation. It builds only the x86_64 debug variant, with two workers, no parallel project execution, and no reusable Gradle daemon.

The supported Gradle options include:

```text
:app:assembleDebug
--no-daemon --max-workers=2 --no-parallel
-PreactNativeArchitectures=x86_64
-Pandroid.cmakeVersion=3.30.5
-Pexpo.android.cmakeObjectPathMax=240
-Pandroid.builder.sdkDownload=false
```

The CMake path bound matters on Windows. The previously used SDK CMake 3.30.5 package bundled Ninja 1.10.2, and long generated object paths failed despite that CMake version. The supported Expo property makes CMake shorten object paths. A short checkout and Gradle cache are still needed because this property does not shorten every external dependency path. No host long-path policy change or third-party source edit is performed.

Successful output is `android/app/build/outputs/apk/debug/app-debug.apk`. The helper requires Gradle exit code zero and a nonempty APK. This is a development-signed emulator build, not a production-signed release or a build for an ARM phone. The project-specific Expo Print plugin is applied during prebuild and compiled from source as configured in `package.json`; an old installed binary cannot gain that native repair through a JavaScript reload.

## Install and open on the selected emulator

The existing launcher expects an AVD named `FYP_API35` on emulator port 5580. Create that API 35 x86_64 virtual device in Android Studio or with the Android SDK tools. Then prepare it:

```powershell
npm.cmd run android -- --boot-only
```

Check the device identity before installing. The usual serial is `emulator-5580`; use the confirmed serial if ADB reports the configured emulator differently.

```powershell
adb devices
adb -s emulator-5580 shell getprop ro.boot.qemu.avd_name
adb -s emulator-5580 install -r android/app/build/outputs/apk/debug/app-debug.apk
npm.cmd run android -- --project-app
```

`install -r` replaces the application binary while retaining its data when Android accepts the update. Do not uninstall an existing application merely to bypass a signing mismatch; preserve its data and inspect the mismatch first. The installed project app and Expo Go have separate saved data.

Keep the development-server terminal running. The project launcher verifies the installed debuggable package and Metro checkout, forwards the development port, waits until Android can reach that server, and then opens the application. It does not build or install an APK. Background emulator execution is available with `--headless`; ordinary local use can keep the emulator visible.

## Verify the result and handle failures

Confirm the four main tabs render, add and edit a fictional expense, inspect its report totals, and restart the application to confirm persistence. Native optional features need their own permissions and services; a successful build does not prove notifications, map tiles, PDF generation, OCR, or model answers on your computer.

If prebuild fails, inspect its retained output and any source changes before retrying. If Gradle reports a missing SDK component, install that specific official package rather than enabling automatic downloads blindly. If Windows reports a native path-length failure, shorten the checkout/cache paths and preserve existing native edits before regenerating. If a corporate network requires additional trust configuration, follow that environment's approved setup; this repository supplies no private certificate and does not disable TLS verification.

Generated Android files, build outputs, SDK paths, caches, logs, and signing keys remain local. Android checks do not establish iOS support; iOS verification is deferred.
