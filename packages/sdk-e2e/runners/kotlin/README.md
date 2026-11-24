# Kotlin client

Runs the shared catalog through the Kotlin SDK on an Android device and on a desktop JVM. Both are
batch consumers: each registers with the producer over MQTT, interprets each queued definition's
`steps` against [`packages/sdk-kotlin`](../../../sdk-kotlin) and reports the outcome. An app cannot be
driven over stdin like the Python client, so the Android app is a `mode: 'mqtt'` external consumer (see
the [`@qvac/test-suite` README](../../../test-suite/README.md#non-js-clients)). The desktop program
shares its consumer, so it is one too.

| Path                                              | Holds                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `runner/src/main/kotlin/.../e2e/runner/`          | The interpreter: steps, method tables, named assertions, resource table             |
| `runner/src/main/kotlin/.../e2e/consumer/`        | The consumer protocol (port of `consumer-base.ts`), MQTT 3.1.1 and 5                |
| `app/src/main/kotlin/.../e2e/E2eSession.kt`       | Android: starts the consumer, then the worker once the producer has acknowledged it |
| `desktop/src/main/kotlin/.../e2e/desktop/Main.kt` | Desktop: the same, with the worker in-process through `jvm-barekit`                 |
| `scripts/device.mjs`                              | Builds, installs, launches and follows the Android app                              |
| `scripts/desktop.mjs`                             | Builds and runs the desktop program                                                 |

`:runner` is a plain Kotlin/JVM library; `:app` (Android) and `:desktop` (a JVM application) add only
the host: where the catalog and fixtures come from, and which transport starts the worker.

| Leg     | Registers as     | Resource table as | Worker                                      | Carries                                                                                               |
| ------- | ---------------- | ----------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Android | `kotlin-android` | `mobile-android`  | `AndroidBareKitTransport`, in the app       | catalog JSON, resource table, platform policy, fixtures, worker settings                              |
| Desktop | `desktop-kotlin` | `desktop-kotlin`  | `JvmBareKitTransport`, in the program's JVM | catalog JSON, resource table, platform policy, worker settings; fixtures read in place from `assets/` |

The catalog JSON comes from `npm run emit:catalog-json`; the worker settings are
`fixtures/qvac.config.e2e.json` without its plugins and `rpcServerProvider`, which the SDK's runtime
profile decides. The Android leg inherits the `mobile-android` device skips (`SAME_DEVICE` in
`catalog/platform-skips.ts`). The desktop leg is one label on Linux, macOS and Windows, like
`desktop-python`, and its skips name it.

## Prerequisites

- JDK 17, Node.js, and Python 3 (the Kotlin SDK's build of `packages/sdk` runs `build_worker.py`, and
  its client generator is a Python script).
- An Android SDK (`ANDROID_HOME`, or the usual install locations). The desktop build needs one too: the
  Gradle build configures the Android modules beside it. The Android app also needs NDK `29.0.14206865`.
- `npm run install:build` in `packages/sdk-e2e`: the catalog is emitted from it.
- For Android runs, `adb` and a USB-debuggable arm64 device.

## Run locally

```bash
cd packages/sdk-e2e
npx qvac-test run:local:kotlin-android --suite=smoke
npx qvac-test run:local:kotlin-desktop --suite=smoke
```

- `prepare` builds before the producer starts (and on Android installs the APK); `--skip-build` reuses
  the last build.
- On Android, `run` reverses the broker port onto the device (`adb reverse`, so the device need not
  share this machine's network), starts the app with the run in intent extras and follows its log
  (tag `QvacE2E`). `ANDROID_SERIAL` picks the device when several are connected. The app's memory is
  sampled through adb every 5 s and charted per test in the report; `QVAC_ANDROID_MEM_INTERVAL_MS` sets
  the period and `QVAC_ANDROID_MEM_DISABLED=1` turns it off.
- On desktop, `run` starts the program with `java` from `JAVA_HOME` (else `PATH`) and the run in its
  environment. Its output is the consumer log, and it exits when the producer completes. A
  `QVAC_CONFIG_PATH` file's keys go over the worker settings, which is how CI points it at the model
  cache. The worker keeps its data under `QVAC_HOME_DIR`, else the home directory.

## Build

From `packages/sdk-e2e`:

```bash
node runners/kotlin/scripts/device.mjs build    # -> build/consumers/kotlin-android/consumer.apk
node runners/kotlin/scripts/desktop.mjs build   # -> runners/kotlin/desktop/build/install/qvac-e2e-desktop
```

The Gradle build includes `packages/sdk-kotlin` as a composite build, so both legs run this checkout's
Kotlin SDK and the worker it bundles, and an edit to either is picked up on the next build. It
substitutes `io.tether:qvac-sdk-kotlin` (the client), `io.tether:qvac-sdk-android` and
`io.tether:qvac-sdk-jvm` with the client and the two worker hosts. The desktop program only builds this
way: `jvm-barekit` is experimental and not published, so users build it from this repository too. The
runner has no unit tests: verify a runner change by running the affected e2e tests.

`device.mjs build --maven` builds the Android app the way an app outside the monorepo gets the SDK. It
publishes the SDK's all-in-one profile to `packages/sdk-kotlin/build/maven-repository` with
`publishSdkToBuildRepository`, then builds the app with `-PqvacSdkRepository` pointing there and
`-PqvacSdkVersion` at the SDK's version, so `io.tether:qvac-sdk-android` and
`io.tether:qvac-sdk-kotlin` resolve from that repository. The `:desktop` project is left out of that
build.

## CI

sdk-kotlin's `test:mobile` builds the APK with `--maven`, with the run and broker baked in, and runs it on
Device Farm under the React Native app's test spec. A packaging break in the Maven publication fails the
build. Dispatch `sdk-e2e.yml` with `languages: kotlin` and `platforms: android`.

sdk-kotlin's `test:integration` runs the desktop leg on Linux, macOS and Windows (`node ../sdk/ci/e2e.mjs
kotlin`): it builds `packages/sdk` and the desktop program against it, then runs the program as the
`kotlin-desktop` external consumer beside the producer. Dispatch `sdk-e2e.yml` with `languages: kotlin`
and `platforms: linux,mac,windows`.

## Adding coverage

The interpreter mirrors the Python client's step for step, so a test that passes on one and fails on the
other points at an SDK. Calls go through `QvacClient`'s public request surface with the payloads the JS
client sends, and return the shapes the JS step bindings return. A method, `collect` mode, named
assertion or resource key the client lacks makes the test `incomplete`, never a pass; so does a
definition with no `steps`. Add the missing piece in `Calls.kt` or `Assertions.kt`, following its JS
binding in `runners/js/shared/step-bindings.ts`.

## Gotchas

- WebSocket brokers go through OkHttp under Eclipse Paho (`OkHttpWebSocket.kt`). Paho 1.2.5's own
  WebSocket transport never answers ping frames, so behind a load balancer that pings (as the CI broker
  does) the connection drops and does not recover.
- Paho names TCP and TLS brokers `tcp://` and `ssl://`; `desktop.mjs` rewrites the framework's
  `mqtt://` and `mqtts://` URLs to them.
