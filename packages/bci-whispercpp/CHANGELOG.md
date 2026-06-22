# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2] - 2026-06-22

### Changed

- Windows prebuilds now link the static Visual C++ runtime (`/MT`) instead of
  importing `vcruntime140.dll`, `msvcp140.dll`, or UCRT DLLs from the MSVC
  redistributable. Shared monorepo `vcpkg-overlays/triplets/{x64,arm64}-windows.cmake`
  build dependencies with a static CRT; addon CMake no longer links `msvcrt.lib`,
  which had forced the dynamic runtime. Per-package vcpkg overlays were
  consolidated into the shared `vcpkg-overlays/` tree. No public API change.

## Pull Requests

- [#2722](https://github.com/tetherto/qvac/pull/2722) - QVAC-21100: Switch to static C/C++ windows runtimes

## [0.3.1]

### Added

- `files.embedder` — optional path to the embedder weights file. The
  embedder location can now be supplied explicitly from JS instead of
  always being derived from a hardcoded `bci-embedder.bin` filename next to
  the GGML model. The path flows from JS (`files.embedder` →
  `configurationParams.embedderPath`) down to
  `BCIModel::loadEmbedderIfNeeded()`. Fully backward compatible: when
  `files.embedder` is omitted, the native side falls back to resolving
  `bci-embedder.bin` next to `files.model` (previous behaviour).

  ```js
  // default (unchanged) — embedder resolved next to the model
  new BCIWhispercpp({ files: { model } }, config)
  // explicit embedder location
  new BCIWhispercpp({ files: { model, embedder } }, config)
  ```

## [0.3.0]

### Changed

- `bci-whispercpp`'s `vcpkg.json` now selects `whisper-cpp[metal]` on
  **iOS** as well as macOS (QVAC-20692). The separate featureless `ios`
  dependency entry is merged into the `osx` entry as a single
  `"platform": "osx | ios"` block requesting `["metal"]`, so the Apple GPU
  backend is selected declaratively on iOS for `bci-whispercpp` — at
  parity with the same fix already landed in `transcription-whispercpp`
  (QVAC-20687). Supersedes the `bci-whispercpp` 0.2.0 note that iOS stayed
  CPU-only pending the upstream Metal/MTLCompiler XPC issue.

## [0.2.0]

Explicit per-platform GPU backend selection (QVAC-19234). Vulkan and
OpenCL GPU acceleration on Android, Vulkan on Linux/Windows, Metal on
macOS — declared as explicit `whisper-cpp` features instead of relying
on `ggml-speech`'s platform default-features.

### Changed

- `vcpkg.json`: the bare `whisper-cpp` dependency is replaced with
  per-platform feature selections mirroring `transcription-whispercpp`:
  - `whisper-cpp[opencl, vulkan]` on `android`
  - `whisper-cpp[vulkan]` on `!(osx | ios | android)` (Linux / Windows)
  - `whisper-cpp[metal]` on `osx`
  - `whisper-cpp` (no GPU feature) on `ios` — iOS stays CPU-only until
    the upstream Metal XPC issue is resolved (parity with the
    `whisper-cpp` port's iOS `GGML_METAL=OFF`).

### Why explicit (vs. relying on defaults)

`0.1.3` already pulled the Android GPU backends transitively because
`ggml-speech` lists `opencl`/`vulkan` as Android default-features. This
release makes the selection **explicit and deterministic** so
`bci-whispercpp` owns its GPU matrix: a future change to `ggml-speech`'s
default-features can no longer silently add or drop a backend, and the
desktop (Vulkan) / Apple (Metal) / iOS (CPU) choices are now intentional
and reviewer-auditable.

### Android prebuild (verified locally via NDK cross-build)

`prebuilds/android-arm64/qvac__bci-whispercpp/` ships the dynamically
loaded backend modules picked up at runtime by
`ensureBackendsLoadedAndroid()`:

```
libqvac-speech-ggml-cpu-android_armv8.0_1.so   (+ 8.2_1, 8.2_2, 8.6_1,
                                                  9.0_1, 9.2_1, 9.2_2)
libqvac-speech-ggml-opencl.so
libqvac-speech-ggml-vulkan.so
```

The active backend is reported through `RuntimeStats.backendId`
(OpenCL = 4, Vulkan = 3, CPU = 0) captured by `captureActiveBackendInfo()`,
which walks the GPU **and IGPU** device list and applies the Adreno
OpenCL preference (mirrors `transcription-whispercpp` #2343).

## [0.1.3]

vcpkg dependency consistency with `transcription-whispercpp` (QVAC-19009).
Bumps the whisper-cpp port to `1.8.5#1` (which consumes
`ggml-speech@2026-06-02`) and aligns the shared C++ dependencies. No
JS/native source changes; no public API change.

### Changed

- `vcpkg.json`: `whisper-cpp` override `1.8.4.2` → `1.8.5#1`
  (matches `transcription-whispercpp`'s current pin, which pulls
  `ggml-speech@2026-06-02`); `qvac-lint-cpp` (unpinned) → `>=1.4.4#3`.
  `qvac-lib-inference-addon-cpp` is already `>=1.2.1` on `main` (#2355).
- `vcpkg-configuration.json`: `default-registry.baseline`
  `acdd94de…` → `a9d7e924…` — the **same baseline
  `transcription-whispercpp` uses**, not registry HEAD. The newer
  `whisper-cpp` / `ggml-speech` are pulled from the registry's version
  history via the `overrides` + transitive `version>=` constraints, not
  by moving the baseline to HEAD; the baseline only had to advance far
  enough to contain a `ggml-speech` port entry (bci's previous
  `acdd94de` predated that port).
- `vcpkg-configuration.json`: route `vulkan` / `vulkan-headers` /
  `vulkan-loader` / `spirv-headers` to the Microsoft registry — required
  for baseline validation because `ggml-speech` (pulled transitively by
  `whisper-cpp`) declares a `vulkan` default-feature whose
  `spirv-headers` dependency the qvac registry does not vendor.

### Android: dynamic backend loading activates

`whisper-cpp@1.8.5#1` consumes the `ggml-speech` port, which on Android
builds ggml with `GGML_BACKEND_DL=ON` + `GGML_CPU_ALL_VARIANTS=ON`. The
android-arm64 prebuild now ships the per-arch CPU backend modules
(`libqvac-speech-ggml-cpu-android_armv8.0_1.so` …
`…_armv9.2_2.so`) loaded at runtime via `dlopen`. The loader added in
`0.1.2` (`ensureBackendsLoadedAndroid()`) is what makes this safe. No
GPU backends yet (that is `0.2.0` / QVAC-19234). Verified locally by
cross-building the android-arm64 prebuild with the NDK.

## [0.1.2]

Android dynamic-backend-loading infrastructure (QVAC-19235). Behaviour
on every platform is unchanged today because `bci-whispercpp` still
pins `whisper-cpp@1.8.4.2`, whose port builds ggml with the static-
backend registry (`GGML_BACKEND_DL=OFF`). This PR is the "safety net"
that lets the follow-up `whisper-cpp@1.8.5` bump (QVAC-19009) flip
`GGML_BACKEND_DL=ON` on Android without reproducing the `SIGABRT` on
model load that hit `transcription-whispercpp` on its PR #2124. See
`aiDocs/15-android-mobile-test-crash-fix.md` for the post-mortem.

### Added

- Native `BCIConfig::backendsDir` field plus JS-side `configurationParams.backendsDir`
  pass-through (defaults to `<addon>/prebuilds` resolved via
  `bare-path`). Surfaces on `BCIWhispercppConfig.backendsDir`.
- Android-only `ensureBackendsLoadedAndroid()` in `BCIModel::load()`
  (process-local `std::call_once`); resolves the per-arch backend
  subdir from `backendsDir / BACKENDS_SUBDIR` and dispatches to
  `ggml_backend_load_all_from_path()`.
- `captureActiveBackendInfo(useGpu, gpuDevice)` in `BCIModel::load()`:
  enumerates `ggml_backend_dev_*` after backend registration and
  snapshots the active backend identity + device memory. New
  `RuntimeStats` keys: `backendDevice`, `backendId`, `gpuMemTotalMb`,
  `gpuMemFreeMb`. The numeric mapping (CPU=0 / Metal=1 / CUDA=2 /
  Vulkan=3 / OpenCL=4 / other=99) is lock-stepped with
  `transcription-whispercpp 0.9.0` and `transcription-parakeet` for
  cross-addon Device Farm comparability. Backend selection is sourced
  from the exact `whisper_context_params` the context was built with
  (use_gpu/gpu_device), walks the `whisper_backend_init_gpu()`-filtered
  GPU **and IGPU** device list (Mali / Adreno-via-Vulkan / Intel iGPU
  report as IGPU), and applies the Adreno OpenCL preference — mirroring
  `transcription-whispercpp` PR #2270 + #2343. Inert on
  `whisper-cpp@1.8.4.2` (no GPU backends registered).
- `CMakeLists.txt`: `bare_target` + `bare_module_target` discovery,
  `BACKENDS_SUBDIR` compile define, `BACKEND_DL_LIBS` (IMPORTED
  `ggml::*` targets) + `BACKEND_DL_LOOSE_SOS` (loose
  `libqvac-speech-ggml-*.so` staging) plumbing, parity with
  `transcription-whispercpp` / `transcription-parakeet`. Inactive
  today (no MODULE backends produced at `whisper-cpp@1.8.4.2`);
  activates on the QVAC-19009 bump.

### Added (tests)

- `BCIConfig.backendsDirDefaultsEmpty`, `BCIConfig.backendsDirRoundTrip`:
  guard the new config field's defaults and copy semantics.
- `BCIModel.runtimeStatsExposesBackendIdentityKeys`,
  `BCIModel.backendIdentityDefaultsToCPU`: guard the new
  `RuntimeStats` keys + default-CPU contract without requiring a
  loaded model (mirrors transcription-whispercpp's `BackendInfo`
  unit-test pattern).
## [0.1.1] - 2026-06-02

### Changed

- Bumped the `qvac-lib-inference-addon-cpp` vcpkg dependency to `1.2.1`.

## [0.1.0]

Initial POC release of `@qvac/bci-whispercpp`, a brain-computer-interface neural
signal transcription addon powered by a BCI-patched fork of whisper.cpp.

### Added

- `BCIWhispercpp` client class (standalone, built on `createJobHandler` +
  `exclusiveRunQueue` from `@qvac/infer-base`) with `load()`, `transcribe()`,
  `transcribeFile()`, `unload()`, `destroy()`, `cancel()`, `getState()`.
- Low-level `BCIInterface` (`./bci` subpath export) for users that need direct
  control over the native addon lifecycle.
- `./addonLogging` subpath exposing `setLogger` / `releaseLogger` for wiring a
  native log handler.
- C++ native addon (`NeuralProcessor`, `BCIModel`, `BCIConfig`) using the
  `inference-addon-cpp` framework, with BCI-specific preprocessing
  (Gaussian smoothing, low-rank day projection, softsign non-linearity) and
  mel-layout injection into a patched whisper.cpp encoder.
- Integration tests for load/destroy, batch transcription, and a 5-sample
  WER measurement (avg 6.0% on the reference fixtures).
- GoogleTest C++ unit tests covering mel shape, gaussian smoothing, padded
  frames, truncation handling, invalid-config rejection, and range validation.
- `scripts/convert-model.py` to convert a BrainWhisperer checkpoint into the
  GGML model + embedder binary pair consumed at runtime.
- `scripts/download-models.sh` to fetch the reference model and test fixtures
  from the `bci-test-assets-v0.1.0` GitHub release.

### Streaming Transcription API

`BCIWhispercpp#transcribeStream(neuralStream, streamOpts)` alongside the
existing batch `transcribe()`. Returns the standard `QvacResponse` shape, so
consumers use `response.onUpdate(cb)` for incremental outputs and
`response.await()` for the final transcript. Input can be an async iterable of
`Uint8Array` chunks, a single `Uint8Array`, or a chunk array.

```js
const response = await bci.transcribeStream(neuralChunkStream, {
  windowTimesteps: 1500, // ~30s window
  hopTimesteps: 500,     // ~10s hop
  emit: 'delta'          // or 'full'
})
response.onUpdate(segments => {
  for (const s of segments) console.log(s.windowStartTimestep, s.t0, s.t1, s.text)
})
```

- `emit:'delta'` (default) emits the trimmed native segments for the
  newly-discovered tail; native fields (`text`, `t0`, `t1`, ...) are preserved
  and each segment is annotated with `windowStartTimestep` so window-local
  timestamps can be mapped to the stream timeline.
- `emit:'full'` emits a single `{ text }` entry with the full running
  transcript (no per-segment timing).

Streaming is mutually exclusive with `transcribe()`. `cancel()` / `unload()` /
`destroy()` are stream-aware and fully unwind any in-flight window decode
before tearing down the addon. Implemented entirely in JavaScript as a
sliding-window driver over the existing `runJob` entrypoint — no native addon
or binding changes.

### New Error Codes

`STREAM_ALREADY_ACTIVE`, `INVALID_STREAM_INPUT`, `INVALID_STREAM_HEADER`, and
`WINDOW_TOO_LARGE` surface stream-specific failures with typed errors. Window
size is validated against the encoder's 3000-frame ceiling.

### Known Limitations

- Inference error codes live in the `26001-27000` range in the current
  implementation.
