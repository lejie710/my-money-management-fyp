# Third-party notices

The root [MIT license](LICENSE) applies to this project's original code and documentation. Dependencies, copied upstream files and external assets retain their own licenses; installing or configuring them does not replace those terms.

## Included Expo printing source

The Android printing repair and its test fixtures include source derived from Expo Print 58.0.6, copyright 2015-present 650 Industries, Inc. (Expo), under the MIT license. Preserve the included notices:

- [Printing repair license](plugins/expo-print-58.0.6/EXPO_LICENSE.txt)
- [Fixture license](tests/fixtures/expo-print-58.0.6/LICENSE)
- [Repair provenance and version guards](plugins/expo-print-58.0.6/README.md)

The version and source-hash checks deliberately require review before upgrading the copied implementation.

## Installed packages and optional model assets

JavaScript packages are installed from the pinned package lockfiles and retain the licenses included by their respective authors. Generated native projects, installed packages and downloaded model/runtime binaries are not distributed in this source repository.

The optional [Flask/Prophet foundation](tools/forecast/README.md) installs its Python dependencies separately from a Windows/Python 3.12 version-and-hash lock. Those packages, including the native model runtime shipped with Prophet, retain their upstream licenses and notices. No Python wheel, installed environment or native model binary is included here.

The optional local model configuration identifies Qwen3-4B-Instruct-2507 and its GGUF distribution under Apache-2.0. The companion's [asset manifest](scripts/companion/assets.lock.json) records the model revision and upstream runtime sources, and its [setup guide](scripts/companion/README.md) describes the separate local assets. Consult and preserve the upstream licenses when obtaining or redistributing those assets; the project's MIT license does not relicense them.

## Map data and visual assets

The online map displays OpenFreeMap, OpenMapTiles and OpenStreetMap attribution through the map component. Retain that attribution when changing its presentation or provider. See [transaction context](docs/TRANSACTION_CONTEXT.md) for the implemented map behavior and network requirements.

The current interface uses platform fonts and project-authored outline icons. Unverified artwork from the original submission is not included. A final screenshot gallery will use fictional records and carry a disclosure beside the images; diagnostic screenshots from development are not the public gallery.
