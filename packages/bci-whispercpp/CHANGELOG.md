# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
