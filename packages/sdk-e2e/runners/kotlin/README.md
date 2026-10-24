# Kotlin client

The shared catalog, run through the Kotlin SDK on an Android device. The app is a batch consumer in its
own right: it registers with the producer over MQTT, takes the queue it is handed, interprets each
definition's `steps` against [`packages/sdk-kotlin`](../../../sdk-kotlin), and reports every outcome.
An app cannot be driven over stdin the way the Python client is, so it is a `mode: 'mqtt'` external
consumer (see the `@qvac/test-suite` README).

| Path                                          | Holds                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| `app/src/main/kotlin/.../e2e/runner/`         | The interpreter: steps, the method tables, named assertions, the resource table |
| `app/src/main/kotlin/.../e2e/consumer/`       | The consumer protocol (`consumer-base.ts`, ported), MQTT 3.1.1 and 5            |
| `app/src/main/kotlin/.../e2e/MainActivity.kt` | Starts the consumer, and the worker once the producer has acknowledged it       |
| `scripts/device.mjs`                          | Build, install, launch and follow the app                                       |

The APK carries the catalog as JSON (`npm run emit:catalog-json`), the resource table, the fixtures and
the worker settings from `fixtures/qvac.config.e2e.json`. It registers as `kotlin-android`, applies the
resource table as `mobile-android`, and inherits every skip that applies to the Android phones it shares
with the React Native app (`SAME_DEVICE` in `catalog/platform-skips.ts`).

## Running it

Locally, against the device on USB:

```bash
cd packages/sdk-e2e
npx qvac-test run:local:external --name=kotlin-android --suite=smoke
```

The entry's `prepare` step builds the APK and installs it before the producer starts; `--skip-build`
reuses what is installed. Its `run` step reverses the broker port onto the device, starts the app with
the run in intent extras and follows its log, which is tagged `QvacE2E`.

In CI, `test-android-sdk.yml` with `app: kotlin` builds the same APK with the run and broker baked in
and runs it on Device Farm under the same test spec as the React Native app. Dispatch it from
`test-sdk.yml` with **Kotlin Android tests**.

Building by hand needs JDK 17 and an Android SDK with NDK `29.0.14206865`:

```bash
node runners/kotlin/scripts/device.mjs build   # -> build/consumers/kotlin-android/consumer.apk
cd runners/kotlin && ../../../sdk-kotlin/gradlew :app:testDebugUnitTest
```

The Gradle build includes `packages/sdk-kotlin` as a composite build, so the app always runs this
checkout's Kotlin SDK and the worker it bundles. The Kotlin SDK's PR checks run the unit tests, so an
SDK change that breaks the app is caught there; they need neither npm nor a device.

MQTT runs on Eclipse Paho with OkHttp underneath for WebSocket brokers (`OkHttpWebSocket.kt`). Paho
1.2.5's own WebSocket transport feeds ping frames into the MQTT stream and never answers them, so behind a
load balancer that pings, which the CI broker is, the connection dropped every few minutes and stopped
coming back.

## What it covers

The interpreter is the Python client's, step for step, so a test that passes on one and fails on the
other points at an SDK. Calls go through `QvacClient`'s public request surface with the payloads the JS
client sends, and return the shapes the JS step bindings return. A method, a `collect` mode, a named
assertion or a resource key the app does not have makes the test `incomplete`, never a pass; so does a
definition with no `steps`. Add one in `Calls.kt` or `Assertions.kt`, after its JS binding in
`runners/js/shared/step-bindings.ts`.
