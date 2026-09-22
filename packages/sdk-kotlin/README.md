# QVAC SDK for Kotlin

Local Kotlin client for the `@qvac/sdk` Bare worker, including a native Android
host backed by BareKit and an authenticated desktop JVM sidecar transport.

The published Kotlin targets are Android and desktop JVM. Native targets are
deferred until each has a tested worker host; no hostless Kotlin/Native
artifacts are published. Android embeds the same QVAC mobile worker and native
addons used by the Expo integration. The sample hosts it in an
`android:process=":qvac_worker"` bound service so addon crashes are isolated
from the UI process.

The client, generated contract, and embedded worker are version-locked to the
`@qvac/sdk` version pinned in `package.json`.

## Package naming

QVAC uses ecosystem-native publisher and package conventions while keeping the
same `qvac-sdk` product name:

| Ecosystem | Published package | Source import namespace |
| --- | --- | --- |
| JavaScript | `@qvac/sdk` | `@qvac/sdk` |
| Python | `tetherto-qvac-sdk` | `tetherto.qvac_sdk` |
| Kotlin Multiplatform | `io.tether:qvac-sdk-kotlin` | `io.tether.qvac.sdk` |
| Android embedded runtime | `io.tether:qvac-sdk-android` | `io.tether.qvac.sdk.barekit` |

Android is published as one all-in-one runtime plus smaller capability profiles:

| Artifact | Included capabilities |
| --- | --- |
| `io.tether:qvac-sdk-android` | all currently exported QVAC addons/capabilities |
| `io.tether:qvac-sdk-android-assistant` | LLM and Parakeet transcription |
| `io.tether:qvac-sdk-android-llm` | LLM and embeddings |
| `io.tether:qvac-sdk-android-speech` | Whisper/Parakeet/BCI transcription, translation, and TTS |
| `io.tether:qvac-sdk-android-vision` | multimodal LLM, OCR, and classification |
| `io.tether:qvac-sdk-android-media` | audio, image, video, world generation, and upscaling |
| `io.tether:qvac-sdk-android-robotics` | VLA inference |

Every AAR embeds a capability manifest. Calling an operation that its profile
does not contain throws `UnsupportedCapabilityException` before dispatch. The
active profile is available as `client.runtimeProfile`.

## Android

Open `packages/sdk-kotlin` in Android Studio and run the `android-example`
configuration, or build it from the command line:

```bash
./gradlew :android-example:assembleDebug
```

The first build runs `npm install` to fetch the exact-pinned `@qvac/sdk` and
BareKit dependencies, bundles the worker for `android-arm64`, links the
configured native addons,
and packages the BareKit runtime, worker asset, and addons into the APK.
The sample is intentionally restricted to `arm64-v8a`, API 29+. It is a native
Jetpack Compose app whose launcher is an executable Feature Lab with independent
and run-all buttons for completion, vision, OCR, transcription, TTS, embeddings,
translation, and classification. The Compose assistant demo remains available
for chat, image prompts, and microphone transcription. The sample uses the
verified all-in-one profile.

### Pixel 8a verified feature matrix

These public Kotlin SDK paths passed together on a physical Pixel 8a. Models
are loaded one at a time and retained in the SDK cache after unload.

| Feature | Small model | Catalog size | Cached device time |
| --- | --- | ---: | ---: |
| LLM | `QWEN3_600M_INST_Q4` | 383 MB | 35.5 s |
| Vision | `SMOLVLM2_500M_MULTIMODAL_Q8_0` + projection | 437 + 109 MB | 27.0 s |
| OCR | `OCR_DOCTR` + derived detector | 5 + 9 MB | 6.2 s |
| Transcription | `WHISPER_TINY_Q8_0` | 44 MB | 5.1 s |
| TTS | `TTS_MULTILINGUAL_SUPERTONIC3_Q4_0` | 85 MB | 24.9 s |
| Embeddings | `EMBEDDINGGEMMA_300M_Q4_0` | 278 MB | 15.5 s |
| Translation | `BERGAMOT_EN_FR` + vocabularies | 32 MB + companions | 1.8 s |
| Classification | bundled MobileNetV3 | 3 MB | 1.3 s |

The cached matrix completed in 117.8 seconds. A clean first run additionally
downloads roughly 1.4 GB and depends on network speed. AudioGen,
diffusion/video/world, and VLA are packaged and API-covered, but are not part of
this phone-sized model matrix because the available catalog entries require
multi-model, multi-gigabyte packs.

```bash
QVAC_DEVICE_TEST_SCOPE=feature-lab ./scripts/run-android-device-tests.sh
```

### Consume a published artifact

Release automation publishes the KMP client and the self-contained Android AAR
to the configured Maven repository. For GitHub Packages, configure the QVAC
repository and use a package-read token:

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven {
            url = uri("https://maven.pkg.github.com/tetherto/qvac")
            credentials {
                username = providers.gradleProperty("gpr.user").orNull
                    ?: System.getenv("GITHUB_ACTOR")
                password = providers.gradleProperty("gpr.key").orNull
                    ?: System.getenv("GITHUB_TOKEN")
            }
        }
    }
}
```

```kotlin
// app/build.gradle.kts
dependencies {
    implementation("io.tether:qvac-sdk-android:0.20.0")
}
```

Replace `qvac-sdk-android` with `qvac-sdk-android-assistant`, `-llm`, `-speech`,
`-vision`, `-media`, or `-robotics` when the app only needs that profile. The
Kotlin API and import namespace remain identical across all artifacts.

Each `sdk-v<version>` GitHub Release also contains token-free Maven repository
ZIPs for the seven Android profiles and the desktop JVM client. For example,
download `qvac-sdk-android-llm-<version>-maven.zip`, extract it, and point a
normal Gradle Maven repository at the extracted directory:

```kotlin
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven { url = uri("/absolute/path/to/extracted-qvac-repository") }
    }
}
```

The archive includes the selected runtime and the Kotlin client modules it
depends on, so the dependency declaration remains
`implementation("io.tether:qvac-sdk-android-llm:<version>")`. Verify downloads
against the release's `SHA256SUMS` asset. GitHub Packages or the configured
public Maven repository remains the recommended path for normal dependency
resolution and upgrades.

Until the next authenticated, coordinated SDK version is released, publish locally with
`./gradlew publishSdkToBuildRepository` and add
`packages/sdk-kotlin/build/maven-repository` as a Maven repository.

### Consume the source checkout

For SDK development, add the composite build:

```kotlin
// settings.gradle.kts
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

includeBuild("/absolute/path/to/qvac/packages/sdk-kotlin")
```

Then add the Android host:

```kotlin
// app/build.gradle.kts
dependencies {
    implementation("io.tether:qvac-sdk-android:0.20.0")
}
```

For local Maven publication of the KMP metadata and target variants:

```bash
./gradlew publishSdkToBuildRepository
```

The repository is written to `build/maven-repository` and includes the generated
KMP variants plus the `io.tether:qvac-sdk-android` AAR, sources, Dokka API documentation
(`-javadoc.jar`), POM metadata,
checksums, worker, addons, LICENSE, and NOTICE. Set `MAVEN_REPOSITORY_URL` plus
`MAVEN_USERNAME`/`MAVEN_PASSWORD` to enable `publishSdkToReleaseRepository`.
Set `MAVEN_SIGNING_KEY` and `MAVEN_SIGNING_PASSWORD` to sign every publication
with an in-memory PGP key. `./gradlew verifyMavenPublications` checks every current
coordinate's documentation, sources, artifact presence and checksums.

CI defaults to GitHub Packages; `KOTLIN_MAVEN_REPOSITORY_URL` and the matching
`KOTLIN_MAVEN_*` secrets support other generic Maven repositories. Maven Central
uses its dedicated deployment workflow, not a generic Maven URL:

```bash
# Set Central user-token credentials (not account login credentials) securely:
# ORG_GRADLE_PROJECT_mavenCentralUsername
# ORG_GRADLE_PROJECT_mavenCentralPassword
# MAVEN_SIGNING_KEY / MAVEN_SIGNING_PASSWORD
./gradlew publishToMavenCentral           # upload for manual validation/release in the Portal
./gradlew publishAndReleaseToMavenCentral # upload, release, wait for PUBLISHED; irreversible
```

Both commands include all ten publications: KMP metadata, JVM, Android client,
and seven Android runtimes. The maintained Vanniktech base plugin manages Central
deployments; Dokka generates real API documentation. Existing coordinates,
sources, signing and GitHub Packages support remain unchanged.

For CI, configure the protected `release` environment with
`KOTLIN_CENTRAL_USERNAME`, `KOTLIN_CENTRAL_PASSWORD`, `KOTLIN_MAVEN_SIGNING_KEY`
and `KOTLIN_MAVEN_SIGNING_PASSWORD`. Select `central` in the manual workflow;
it only stages unless `release_central` is explicitly enabled. For tag/lockstep
release automation, set `KOTLIN_MAVEN_DESTINATION=central`; those release events
publish publicly and wait for Central's `PUBLISHED` state. Namespace ownership
and a discoverable production signing public key must be configured beforehand.
Never run both staging and automatic publication for the same release blindly;
finish or drop an existing deployment in the Portal before retrying.

Central publication fails closed without signing and a matching authenticated
published JS worker, even though the plugin stages artifacts on disk first.
The tokenless published npm worker is not eligible for external Kotlin release.

Start and close the isolated worker with the application lifecycle:

```kotlin
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.barekit.AndroidServiceTransport
import kotlinx.coroutines.runBlocking

fun runQvac(applicationContext: android.content.Context) = runBlocking {
    val transport = AndroidServiceTransport.connect(applicationContext)
    val client = QvacClient(transport)
    try {
        println(client.heartbeat())
    } finally {
        client.close()
    }
}
```

`client.close()` stops the service and performs the worker cleanup round trip.
For an in-process host, use `AndroidBareKitTransport.connect()` directly; the
same typed client and worker bundle are used in either topology.
Initialization and cleanup are dispatched to Android's main thread internally;
calling the suspend API from `Dispatchers.Default` or `Dispatchers.IO` is supported.
Service duplex input is registered before writes are accepted, fragmented into
64 KiB Binder transactions, and buffered with bounded backpressure. Cancelling
collection cancels the service-side duplex request instead of merely sending EOF.
IPC reads/writes also run on the main thread. An in-flight frame finishes before
cancellation releases the write lock; a write failure or 10-second write timeout
closes the connection rather than letting later requests use a partial frame.

The committed `qvac.config*.json` files define the immutable published profiles.
The Gradle `aio`, `assistant`, `llm`, `speech`, `vision`, `media`, and `robotics`
product flavors build those profiles reproducibly.

## Desktop JVM

Desktop JVM worker hosting is experimental. The client resolves the same worker
tiers as Python: explicit paths, `QVAC_WORKER_PATH`/`QVAC_BARE_PATH`,
`QVAC_SDK_DIR`, a local `node_modules`, the versioned managed cache, and a global
npm installation. It requires a worker whose version matches this client and
negotiates authentication from the worker's package metadata: a worker that
declares `qvacIpcAuthentication: "token-v1"` runs over the authenticated loopback
handshake; one that does not — including the published `@qvac/sdk` — runs over an
unauthenticated loopback channel. Enforcement returns automatically once a
coordinated token-v1 worker release is the pinned version. Android uses its
embedded BareKit worker and is unaffected.

```kotlin
import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import kotlinx.coroutines.runBlocking

fun main() = runBlocking {
    val transport = JvmBareRpcTransport.connectResolved(
        sdkDirectory = "/path/to/qvac/packages/sdk", // a local @qvac/sdk installation
    )
    val client = QvacClient(transport)

    try {
        println(client.heartbeat())
    } finally {
        client.close()
    }
}
```

`installWorkerIfMissing = true` installs and caches the pinned `@qvac/sdk`
version on first use; cached packages are re-checked. The transport launches
`bare` and creates a loopback-only TCP endpoint. When the worker declares
token-v1 it is given a random per-launch `QVAC_IPC_AUTH_TOKEN` and must present
it before any Bare-RPC frame is accepted; wrong-token sockets are rejected with a
constant-time comparison. Against a tokenless worker the token is not issued and
the loopback channel is unauthenticated, so do not use JVM hosting across a
hostile local-user boundary until the authenticated worker release is pinned.

Worker stdout/stderr are continuously drained into `transport.recentWorkerLogs`
(a bounded 16K-character tail); `isWorkerAlive` reports the child process state.
Always call `close()` in `finally`. Close is idempotent and cancellation-safe;
a JVM shutdown hook is an additional best-effort cleanup, not protection from
SIGKILL or a host crash. The SDK never silently restarts/replays inference.

## Full worker contract

Unary, server-stream, and duplex methods accept the language-neutral JSON
objects described by `packages/sdk/contract/schema.json`:

```kotlin
import kotlinx.coroutines.flow.collect
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

val response = client.call(
    buildJsonObject {
        put("type", "getSystemResources")
    },
)

client.stream(
    buildJsonObject {
        put("type", "completionStream")
        put("modelId", modelId)
        put("stream", true)
    },
).collect { chunk ->
    println(chunk)
}
```

`QvacClient` reconstructs worker error envelopes as `QvacException`.

## Typed and idiomatic Kotlin API

The contract generator produces Kotlin serialization models and typed methods
for every operation in `manifest.json`. The generated layer is available under
`io.tether.qvac.sdk.generated` and includes request/response models, call-shape
metadata, model constants, model-type maps, error codes, and `SDK_VERSION`.

For new code, use request/response types from
`io.tether.qvac.sdk.generated.schema`: discriminated unions are sealed classes,
engine configurations are nested typed models, and serializers preserve the
worker's JSON shape (no Kotlin wrapper fields on the wire). Existing flat models
remain source-compatible. Import one model namespace, not both wildcards.
Worker numeric/range and addon-specific validation remains authoritative.

```kotlin
import io.tether.qvac.sdk.generated.schema.*
import io.tether.qvac.sdk.generated.Models

val request = LoadModelRequest.LoadModelSrcRequest(
    LoadModelSrcRequest.LlamacppCompletion(
        LoadModelSrcRequestLlamacppCompletion(
            modelSrc = Models.QWEN3_600M_INST_Q4.src,
            modelConfig = LoadModelSrcRequestLlamacppCompletionModelConfig(
                ctx_size = 2048.0,
                gpu_layers = 0.0,
            ),
        ),
    ),
)
val loaded = client.models.load(request)
```

Known worker errors are subclasses of generated `QvacKnownException`, itself a
`QvacException`; for example `QvacKnownException.ServerContextOverflow`.
Unknown or inconsistent name/code pairs preserve the original envelope in a
generic `QvacException` rather than guessing a typed error.

For chat and multimodal generation, `CompletionRun` mirrors the useful JS
completion handle while using Kotlin `Flow` and `Deferred`:

```kotlin
val run = client.completion.run(
    modelId = modelId,
    history = listOf(QvacMessage.user("Explain local AI in three sentences")),
    options = QvacCompletionOptions(
        generation = QvacGenerationOptions(predict = -1),
    ),
)

run.tokens.collect(::print)
val completed = run.final.await()
println(completed.stopReason)
println(completed.stats?.tokensPerSecond)

// From another coroutine:
run.cancel()
```

`CompletionRun` exposes normalized events, accumulated text, thinking text,
tool calls, final statistics, stop reason, and cancellation. Tool definitions
can carry suspend handlers; `client.completion.orchestrate(...)` executes the
worker-owned multi-turn tool loop and returns the same run type.

`run()` intentionally accumulates the complete result, including streams not
collected by the caller. Its memory usage grows with output. Use the cold
`completion.stream(...)` or generated stream methods for incremental processing
without retaining a final result. No SDK-wide token cutoff is introduced.

The feature APIs use ordinary Kotlin data classes and `Flow`, not JSON-shaped
application code:

```kotlin
val transcript = client.speech.transcribe(
    modelId = modelId,
    audio = QvacDataInput.FilePath("/sdcard/Music/sample.wav"),
)
println(transcript.text)

val speech = client.speech.synthesize(modelId, "Hello from QVAC")
val page = client.vision.ocr(modelId, QvacDataInput.FilePath("/sdcard/page.png"))
val vector = client.embeddings.embed(modelId, "local intelligence")
val translation = client.translation.run(modelId, "hello", modelType = "nmt")
println(translation.text())

val hparams = client.vla.hparams(vlaModelId).hparams
val state = qvacVlaPadState(robotState, hparams.maxStateDim)
val actions = client.vla.run(
    modelId = vlaModelId,
    images = listOf(frontCamera, wristCamera),
    imgWidth = hparams.visionImageSize,
    imgHeight = hparams.visionImageSize,
    state = state,
    tokens = instructionTokens,
    mask = instructionMask,
).actions
```

Higher-level wrappers also cover BCI transcription, classification, audio
generation, diffusion, video, world generation, upscaling, and VLA.
`registry`, `plugins`, `retrieval`, and `training` expose typed request helpers;
`completion.batch` exposes batch generation. `system.pause/resume/state` use the
worker lifecycle API, while `resources(includeUsageSnapshot = true)` keeps the
wire key `sample` internal. `serverLogs()` returns a cold log Flow;
`subscribeServerLogs(scope, handler)` returns a caller-owned cancellable Job.
`speech.transcribeStream(request, audioFlow)` and
`speech.synthesizeStream(request, utf8TextFlow)` are duplex Flows: finish the
input Flow to signal EOF and cancel collection to close the session. Neither
helper accumulates the audio result.
`client.raw` remains available for a new plugin field or
operation that has not reached the generated contract yet. The Android Feature
Lab is an executable example for the eight phone-sized capabilities; Media and
VLA have API/packaging tests because their current catalog packs are too large
for the Pixel 8a matrix.

Regenerate and verify the checked-in contract surface with:

```bash
./gradlew generateContract
./gradlew checkContract
```

Generation is deterministic and CI checks the checked-in output, Python
generator tests, handwritten wire vocabulary (including the upstream VLA Zod
schema), and Kotlin compilation. Unsupported schema constructs fail generation
instead of silently degrading to an empty DTO. The generated schema namespace
is large by design; edit the exporter/generator, never generated DTOs.

## Streaming resource limits

Bare-RPC honors request-stream PAUSE/RESUME and sends response-stream flow
control at byte/chunk watermarks. Queues are bounded even for empty chunks.
An addressed oversized frame up to the discard safety limit is drained in
64 KiB pieces and fails only its request with `BareRpcLimitException`; later
RPCs remain usable. Unaddressable/malformed frames and frames beyond the safety
limit close the connection. JSON lines have a separate bound, including lines
split across frames. These are memory-safety limits, not generation cutoffs.

Pass `rpcLimits = BareRpcLimits(...)` to `AndroidBareKitTransport.connect` or
`JvmBareRpcTransport.connect/ connectResolved` when a capability needs larger
individual frames/JSON lines. Defaults: 16 MiB frame and JSON line, 256 MiB
discard ceiling, 32 MiB/1024 chunks per stream, pause at 1 MiB and resume below
512 KiB. Account for device RAM before raising them. The isolated Android
service uses the safe defaults.

## Local development

```bash
./gradlew jvmTest
./gradlew :android-barekit:assemble
./gradlew :android-example:assembleDebug
./gradlew publishSdkToBuildRepository
```

Real-engine cross-client conformance uses the same corpus as JS/Python:

```bash
python3 ../sdk-python/scripts/build_worker.py --force
QVAC_RUN_CONFORMANCE=1 ./gradlew jvmTest --tests '*WorkerConformanceTest' --rerun-tasks
```

This downloads small models and tests generation, translation, embeddings,
load/unload, cancellation, the tool loop, and TTS. Without the opt-in variable
this test is explicitly skipped; ordinary JVM tests still exercise a live
JavaScript Bare-RPC process and canonical bytes from the locked upstream
encoder. CI runs real inference on pushes to `kotlin-sdk`,
`test-e2e-smoke`-labelled PRs, or manual dispatch. Branch pushes run only
non-publishing checks; publishing requires a release tag, explicit dispatch,
or the SDK release workflow.

External Maven publication is gated on an already-published, version-matched
SDK with authenticated IPC metadata. Central destinations require an in-memory
signing key; local Maven verification does not.

## Current boundary

The supported runtime matrix is intentionally explicit:

- Android `arm64-v8a`, API 29+: embedded in-process or isolated-service host.
- Desktop JVM: experimental, authenticated workspace worker through
  `connectResolved`. The managed npm worker is unsupported; the next coordinated
  authenticated SDK release is required before external Kotlin publication.
- Kotlin/Native: not published in this phase. Each target will be added only
  with a real worker host and target-specific release evidence.
