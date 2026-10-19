# Android Kotlin SDK implementation

## Runtime topology

The Android sample and consumers can choose between two hosts:

- `AndroidServiceTransport` binds the non-exported `QvacWorkerService` in the
  `:qvac_worker` process. Binder carries JSON request/response envelopes and
  byte chunks for duplex calls.
- `AndroidBareKitTransport` embeds the worker in the caller process for apps
  that prefer lower startup overhead and accept native-addon crash coupling.

Both hosts implement the same `QvacTransport` interface and use the same
generated contract and worker bundle.

## Runtime artifact

The `android-barekit` AAR packages:

- BareKit Java classes and JNI libraries.
- The generated `worker.bundle`.
- Configured Android `.bare` addon libraries.
- `libc++_shared.so` and the CMake runtime anchor.
- The Binder service and AIDL callback interfaces.

The all-in-one profile is restricted to `arm64-v8a`, API 29+, and packages
every current SDK addon: completion/embeddings, Whisper/Parakeet/BCI
transcription, translation, TTS/OCR/classification, audio generation,
diffusion/video/world/upscaling, and VLA. Its MobileNetV3 weights are packaged
as a checksummed AAR asset. Six smaller, immutable profiles are published
alongside it: `assistant`, `llm`, `speech`, `vision`, `media`, and `robotics`. Every AAR
contains `qvac/profile.json`, and the transports expose it as a
`QvacRuntimeProfile` so unsupported operations fail before dispatch.

Service callbacks fragment JSON envelopes into 64K-character Binder chunks and
reassemble them in the application process. This supports valid outputs such as
non-streamed TTS buffers that exceed Binder's transaction limit.

## Verification

Required local gates:

```bash
./gradlew checkContract
./gradlew jvmTest
./gradlew :android-example:testDebugUnitTest
./gradlew :android-example:assembleDebug
./gradlew :android-example:compileDebugAndroidTestKotlin
```

On a connected arm64 device, build, install, and run the suite with:

```bash
./scripts/run-android-device-tests.sh
```

The default deterministic smoke suite verifies the packaged worker/profile
digest and isolated service heartbeat. Run
`QVAC_DEVICE_TEST_SCOPE=full ./scripts/run-android-device-tests.sh` to add the
network/model-heavy Qwen text and multimodal completion plus Parakeet
transcription tests. Heavy tests have a 15-minute per-test timeout.

Run the complete small-model matrix with:

```bash
QVAC_DEVICE_TEST_SCOPE=feature-lab ./scripts/run-android-device-tests.sh
```

This executes LLM, vision, OCR, Whisper transcription, TTS, embeddings,
translation, and classification serially through the public Kotlin API. The
suite has a 90-minute first-run bound; the verified cached Pixel 8a run completed
all eight in 117.8 seconds.

## Release wiring

`publishSdkToBuildRepository` produces a local Maven repository containing KMP
metadata, Android/JVM variants, and seven self-contained Android BareKit AARs:
`qvac-sdk-android`, `qvac-sdk-android-assistant`, `qvac-sdk-android-llm`,
`qvac-sdk-android-speech`, `qvac-sdk-android-vision`,
`qvac-sdk-android-media`, and `qvac-sdk-android-robotics`.
`publishSdkToReleaseRepository` publishes the same set when the Maven repository
URL and credentials are supplied. CI should promote only after:

1. Contract freshness and JVM tests pass.
2. The Android AAR and sample APK build for `arm64-v8a`.
3. Instrumentation passes on the supported device profile.
4. Worker/addon digests match the generated SDK version and profile manifest.
5. Maven provenance, NOTICE, and license files are present.

Desktop JVM uses the managed/external worker resolver and a random per-launch
capability token on its loopback channel. Unsupported Kotlin/Native targets are
not published until their worker hosts and release tests exist.
