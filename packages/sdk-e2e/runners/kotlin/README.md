# Kotlin client

Runs the shared catalog through the Kotlin SDK on an Android device. The app is a batch consumer: it
registers with the producer over MQTT, interprets each queued definition's `steps` against
[`packages/sdk-kotlin`](../../../sdk-kotlin) and reports the outcome. An app cannot be driven over stdin
like the Python client, so it is a `mode: 'mqtt'` external consumer (see the
[`@qvac/test-suite` README](../../../test-suite/README.md#non-js-clients)).

| Path                                        | Holds                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `app/src/main/kotlin/.../e2e/runner/`       | The interpreter: steps, method tables, named assertions, resource table    |
| `app/src/main/kotlin/.../e2e/consumer/`     | The consumer protocol (port of `consumer-base.ts`), MQTT 3.1.1 and 5       |
| `app/src/main/kotlin/.../e2e/E2eSession.kt` | Starts the consumer, then the worker once the producer has acknowledged it |
| `scripts/device.mjs`                        | Builds, installs, launches and follows the app                             |

The APK carries the catalog as JSON (`npm run emit:catalog-json`), the resource table, the fixtures and
the worker settings from `fixtures/qvac.config.e2e.json`. It registers as `kotlin-android`, applies the
resource table as `mobile-android`, and inherits the `mobile-android` device skips (`SAME_DEVICE` in
`catalog/platform-skips.ts`).

## Prerequisites

- JDK 17, Node.js, and Python 3 (the Kotlin SDK's build of `packages/sdk` runs `build_worker.py`).
- An Android SDK with NDK `29.0.14206865` (`ANDROID_HOME`, or the usual install locations).
- `npm run install:build` in `packages/sdk-e2e`: the APK's catalog is emitted from it.
- For local runs, `adb` and a USB-debuggable arm64 device.

## Run locally

```bash
cd packages/sdk-e2e
npx qvac-test run:local:kotlin-android --suite=smoke
```

- `prepare` builds the APK and installs it before the producer starts; `--skip-build` reuses the
  installed app.
- `run` reverses the broker port onto the device (`adb reverse`, so the device need not share this
  machine's network), starts the app with the run in intent extras and follows its log (tag `QvacE2E`).
- `ANDROID_SERIAL` picks the device when several are connected.
- The app's memory is sampled through adb every 5 s and charted per test in the report.
  `QVAC_ANDROID_MEM_INTERVAL_MS` sets the period; `QVAC_ANDROID_MEM_DISABLED=1` turns it off.

## Build and unit-test

From `packages/sdk-e2e`:

```bash
node runners/kotlin/scripts/device.mjs build   # -> build/consumers/kotlin-android/consumer.apk
cd runners/kotlin && ../../../sdk-kotlin/gradlew :app:testDebugUnitTest
```

The Gradle build includes `packages/sdk-kotlin` as a composite build, so the app always runs this
checkout's Kotlin SDK and the worker it bundles. `pr-checks-sdk-kotlin.yml` runs the unit tests, so an
SDK change that breaks the app fails the Kotlin SDK's PR checks.

## CI

`test-android-sdk.yml` with `app: kotlin` builds the APK with the run and broker baked in and runs it on
Device Farm under the React Native app's test spec. Dispatch `test-sdk.yml` with **Kotlin Android
tests**.

## Adding coverage

The interpreter mirrors the Python client's step for step, so a test that passes on one and fails on the
other points at an SDK. Calls go through `QvacClient`'s public request surface with the payloads the JS
client sends, and return the shapes the JS step bindings return. A method, `collect` mode, named
assertion or resource key the app lacks makes the test `incomplete`, never a pass; so does a definition
with no `steps`. Add the missing piece in `Calls.kt` or `Assertions.kt`, following its JS binding in
`runners/js/shared/step-bindings.ts`.

## Gotchas

- WebSocket brokers go through OkHttp under Eclipse Paho (`OkHttpWebSocket.kt`). Paho 1.2.5's own
  WebSocket transport never answers ping frames, so behind a load balancer that pings (as the CI broker
  does) the connection drops and does not recover.
