# Swift client

Runs the shared catalog through [`packages/sdk-swift`](../../../sdk-swift) on macOS and iOS. It
interprets each definition's `steps` the way the Python and Kotlin clients do, through the Swift
client's raw request surface, and reports the outcome.

| Path                                           | Holds                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `Sources/QvacE2E/`                             | The shared runner: interpreter, calls, named assertions, resource table       |
| `Sources/QvacE2E/Consumer.swift`, `Mqtt.swift` | The consumer protocol and an MQTT client, for the iOS app                     |
| `macos/`                                       | `swift-macos`: a command the framework drives over stdin (`mode: 'bridge'`)   |
| `ios/`                                         | `swift-ios`: an app that speaks the consumer protocol itself (`mode: 'mqtt'`) |
| `scripts/prepare.mjs`                          | Generates the client, bundles the worker for this Mac, builds the command     |
| `scripts/ios.mjs`                              | Builds, installs, launches and follows the iOS app                            |

Both scripts generate the Swift client from this checkout's SDK before building, as
`packages/sdk-swift/scripts/generate.py` does: the client is never committed.

Both bundle the worker from `fixtures/qvac.config.e2e.json`, so they register the same plugins as the
JS legs. `swift-macos` applies the resource table as `desktop-macos` and keeps models in
`~/.qvac/models` like the other desktop clients; `swift-ios` applies it as `mobile-ios`. Each inherits
the device skips of the leg it shares hardware with (`SAME_DEVICE` in `catalog/platform-skips.ts`).

## Prerequisites

- macOS with Xcode, and Python 3 for the client generator.
- `npm run install:build` in `packages/sdk-e2e`, or `install:build:full` when this checkout's SDK
  needs an unreleased `@qvac/inference`.

## Run locally

From `packages/sdk-e2e`:

```bash
npx qvac-test run:local:swift-macos --suite=smoke
npx qvac-test run:local:swift-ios --filter model-info-get
```

- `prepare` builds before the producer starts; `--skip-build` reuses the last build.
- `swift-ios` runs on a simulator: `QVAC_IOS_SIMULATOR` names one (name or UDID), otherwise a
  booted iPhone is used or the first available one is booted. The run reaches the app through its
  launch environment.
- `node runners/swift/scripts/ios.mjs build --device` builds the app for iPhones.

Model tests may crash in the iOS simulator. The Llama 3.2 1B completion crashed there on a CPU
path assert in llama.cpp, and the embedding model crashed when Metal emulation refused a buffer,
while a Qwen3 0.6B completion has run. iOS model tests run on devices.

The runner has no unit tests: verify a runner change by running the affected e2e tests.

## CI

Swift is one of the e2e languages in `sdk-e2e.yml`, on the same labels as the others: `test-e2e-smoke`
runs it when the PR changes `packages/sdk-swift` or what every client is generated from, and
`test-e2e-full`, `test-e2e-rerun-failed`, `test-e2e-clients` and a PR into `release-*` run it as they
run Python and Kotlin. A dispatch runs it with `swift` in `languages`.

- `swift-macos` is sdk-swift's `test:integration` configuration `darwin-arm64`, on the Apple silicon
  macOS runner (`packages/sdk/ci/e2e.mjs swift`). It builds the bridge with `prepare.mjs`, restores
  the models its tests need from the per-model cache, and points the worker at them through
  `QVAC_CONFIG_PATH`.
- `swift-ios` is sdk-swift's `test:mobile` configuration `ios-arm64`, on the iOS Device Farm pools
  (`packages/sdk/ci/mobile.mjs swift`). It builds the app as `ios.mjs ipa` under the React Native
  app's bundle id, so the same provisioning profile signs it. The test spec follows the device log of
  its own process, `QvacSwiftE2E`.

## Adding coverage

A method, `collect` mode, named assertion or resource key the runner lacks makes the test
`incomplete`, never a pass; so does a definition with no `steps`. Add the missing piece in
`Calls.swift` or `Assertions.swift`, following its JS binding in `runners/js/shared/step-bindings.ts`.
