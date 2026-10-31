# Hello QVAC

The smallest Android app that consumes a published Kotlin SDK archive: one
Maven repository, one dependency line, and a `MainActivity` that connects,
loads a model constant and streams one completion.

`app/src/main/kotlin/io/tether/qvac/hello/MainActivity.kt` does, in order:

1. `AndroidServiceTransport.connect` and `client.heartbeat()`.
2. `client.models.downloadWithProgress(Models.QWEN3_600M_INST_Q4.src)`.
3. `client.models.load(...)` with `modelConfig = { "threads": 4 }`.
4. `client.completion.run(...)` with `captureThinking = true`,
   `run.tokens.collect { ... }`, then `run.final.await()` for the token count
   and tokens per second.

## Build

Download `qvac-sdk-android-llm-<version>-maven.zip` from the `sdk-v<version>`
GitHub release, verify it against `qvac-sdk-kotlin-<version>-SHA256SUMS`, and
extract it. Set the version in `app/build.gradle.kts`, then:

```bash
../../gradlew -p . -PqvacMavenRepository=/absolute/path/to/extracted-repository :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n io.tether.qvac.hello/.MainActivity
```

To build against a checkout instead, publish it with
`./gradlew publishSdkToBuildRepository` in `packages/sdk-kotlin` and pass
`packages/sdk-kotlin/build/maven-repository` as `qvacMavenRepository`.

`screenshot.png` is a run on a Pixel 10 Pro: 161 tokens at 56.1 tokens per
second with `QWEN3_600M_INST_Q4` on the CPU.
