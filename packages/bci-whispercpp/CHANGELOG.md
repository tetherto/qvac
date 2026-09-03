# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.2] - 2026-09-01

### Changed

- Drop CUDA from the published linux-x64 prebuild so the npm tarball stays
  under the registry size limit. `use_gpu: true` uses Vulkan on Linux. CUDA
  remains opt-in at build time via `ENABLE_CUDA=ON`.

- Raise the `speech-cpp` floor to 2026-09-01#2, which brings in ggml-speech
  2026-09-02. The CUDA backend now skips, at registration, GPUs whose
  compute capability has no compiled code in the fatbin, so a
  `use_gpu: true` run on such a card (Turing and older) falls back to
  Vulkan or CPU instead of failing at the first kernel launch. The CUDA
  fatbin now carries native code for every architecture the prebuilds
  target — Turing (7.5), Ampere (8.0, 8.6), Ada (8.9), Hopper (9.0) and
  Blackwell (12.0, 12.1) — with 8.0 PTX for anything newer, so Turing is
  supported again and Blackwell no longer pays a first-use JIT. The roll
  also brings the compute-buffer OOM handling and k-quant GET_ROWS fixes, and
  fixes two multi-GPU faults on a host that mixes supported and unsupported
  NVIDIA cards: backend initialisation no longer aborts when the unsupported
  card enumerates first, and a row-split buffer no longer allocates on the
  skipped card.

## [0.8.1] - 2026-08-28

### Added

- CUDA GPU acceleration on linux x64: the prebuild now builds with
  `ENABLE_CUDA=ON` and bundles the CUDA backend alongside Vulkan and the
  per-arch CPU variants as runtime-loaded modules; `use_gpu: true` prefers
  CUDA on NVIDIA hosts. CUDA engages where the NVIDIA driver and CUDA 13
  runtime libraries (cudart, cuBLAS) are present; on every other host the
  CUDA module is skipped and the addon behaves as before (Vulkan or CPU).

### Changed

- Raise the `speech-cpp` floor to 2026-08-28, which brings in ggml-speech
  2026-08-28. Unused IQ / Q1_0 / MXFP4 / NVFP4 and training Vulkan shader
  payloads are replaced with tiny no-ops so the published natives stay
  under the npm tarball size limit. CUDA fatbins keep Ampere and Ada
  (`80-virtual;86-real;89-real`) and drop Turing sm75 and Blackwell
  sm120/121.

### Fixed

- Vulkan device-loss and fence failures now return a graph-compute error
  instead of aborting the process or continuing with an unusable device.
  Transcription surfaces the error rather than empty output, and pending
  compute state is unwound after the failure.

## [0.8.0] - 2026-08-27

### Added

- Opt-in CUDA GPU backend on Linux / Windows (NVIDIA). `bci-whispercpp[cuda]`
  forwards to `speech-cpp[cuda]`, gated behind the new `ENABLE_CUDA` CMake
  option and the `npm run build:cuda` / `build:native:cuda` scripts. Opt-in
  because it needs `nvcc` on the build host, which the published prebuilds
  are built without; at runtime only the NVIDIA driver plus CUDA runtime
  libraries are needed. On linux-x64 the `cuda` feature flips ggml into
  hybrid dynamically-loaded backend mode: CPU-variant, Vulkan and CUDA
  backends ship as `.so` modules next to the addon, only the CUDA module
  depends on the CUDA runtime, and hosts that cannot resolve it fall back to
  Vulkan or CPU. The native backend loader now also runs on desktop Linux
  (previously Android and linux-arm64 only) so those modules register before
  `whisper_init`. ggml registers CUDA ahead of Vulkan, so `use_gpu: true`
  prefers CUDA when a supported NVIDIA device is present.

### Changed

- Renamed engine repository references from `qvac-ext-lib-whisper.cpp` to
  `qvac-fabric-speech.cpp` in the package documentation, following the
  upstream repository rename. Old GitHub links keep working via redirect.

- Raise the `speech-cpp` floor to 2026-08-26#1, aligning all speech addons
  (`asr-ggml`, `tts-ggml`, `audiogen-ggml`, `bci-whispercpp`) on the same
  port and ggml-speech cut. Relative to 2026-08-26 the bundled ggml computes
  explicit-f32-precision matmuls in true f32 on CUDA and adds CONCAT support
  for all scalar and quantized types. The earlier 2026-08-26 bump brought in
  Vulkan `im2col`/`col2im` tiling, CUDA kernels and launch guards for the
  `conv_transpose_1d`, `im2col` and `pad` paths, and Adreno OpenCL launch
  validation with GEMV work-group limits; the Whisper engine sources are
  unchanged.

## [0.7.2] - 2026-08-18

### Changed

- Raise the `speech-cpp` floor to 2026-08-18, which brings in ggml-speech
  2026-08-18. The update prevents unsupported wide OpenCL GEMV workgroups on
  Adreno devices and hardens padded DIAG_MASK_INF launches and diagnostics.

## [0.7.1] - 2026-08-17

### Changed

- Raise the `speech-cpp` floor to 2026-08-17, which brings in
  ggml-speech 2026-08-17. The engine sources for this package are unchanged; the
  ggml update fixes an uncatchable abort in the OpenCL elementwise ops on a
  non-contiguous input and speeds up pad, small-M matmul and argmax dispatches
  on Adreno.

## [0.7.0] - 2026-08-06

### Changed

- Align `@qvac/infer-base` and `qvac-lib-inference-addon-cpp` dependency floors
  with the shared addon runtime validated across the live addon consumer set.

### Pull Requests

- [#3567](https://github.com/tetherto/qvac/pull/3567) - QVAC-18397 chore[notask]:
  test addon-cpp 1.3.3 across consumers

## [0.6.0] - 2026-08-03

### Changed
- Update `ggml-speech` dependency version to align with other packages that also depend on it.

## [0.5.1] - 2026-07-20

### Changed

- Migrated the runtime wrapper and type declarations to TypeScript. Sources now live under `src/` and the published root JavaScript entrypoints (`index.js`, `bci.js`, `configChecker.js`, `addonLogging.js`, `lib/*.js`) and `.d.ts` declarations are generated from them and committed. Public API, CommonJS export shape, and transcription output are unchanged.
- Faster desktop neural-signal preprocessing on the GPU (Vulkan) and CPU paths. Public API and transcription output are unchanged.
- Desktop linux-arm64 prebuilds now ship per-arch ggml CPU variants (`whisper-cpp` override 1.9.1#3, pulling `ggml-speech` 2026-07-14): the previous armv8-a-baseline build compiled out the ARM dotprod/fp16 kernels. The addon now loads the dynamically-loadable ggml backends on linux-arm64 (previously Android-only).
- Bumped the `whisper-cpp` override from `1.9.1#3` to `1.9.1#4` (registry PR [tetherto/qvac-registry-vcpkg#253](https://github.com/tetherto/qvac-registry-vcpkg/pull/253)), consuming the QVAC-21623 Adreno OpenCL whisper base/small q8_0 decode optimization: `1.9.1#4` pins `tetherto/qvac-fabric-speech.cpp` master `d95e742b` ([#91](https://github.com/tetherto/qvac-fabric-speech.cpp/pull/91), fused-QKV decoder repack + vocab-logits slice) and floors `ggml-speech` to `2026-07-15`, which pins `tetherto/qvac-ext-ggml` speech `d7e27ac7` ([#42](https://github.com/tetherto/qvac-ext-ggml/pull/42), ggml-opencl Adreno FLASH_ATTN partial-KV NaN fix + q8_0 SOA `get_rows` + faster f16 GEMV/GEMM; FA-on-GPU decode routing opt-in via `GGML_OPENCL_FA_ADRENO`). Registry baseline unchanged; the delta is OpenCL-only (non-Adreno / Vulkan / Metal / CPU byte-identical).
- Refactored the JS and native internals to the team coding standards: extracted loops and large functions into named helpers, replaced magic numbers and repeated string literals with named constants (shared stream-header layout and addon-event names), and removed tracker-coupled comments. Behavior-preserving; public API and transcription output are unchanged.

## [0.5.0] - 2026-07-14

### Fixed

- Bumped the `qvac-lib-inference-addon-cpp` vcpkg dependency to `1.2.4` (JsLogger concurrent-env ownership hardening fix, QVAC-21544 follow-up).

## [0.4.1] - 2026-07-03

### Fixed

- Bumped the `qvac-lib-inference-addon-cpp` vcpkg dependency to `1.2.3` (JsLogger teardown / re-`setLogger` crash fix, QVAC-21544, tetherto/qvac#2932).

## [0.4.0] - 2026-07-01

### Changed

- Bumped the `qvac-lib-inference-addon-cpp` vcpkg dependency to `1.2.2` (self-pin fix for safe `Worklet.terminate()` on Android).
- Bumped the `whisper-cpp` vcpkg override from `1.8.5#5` to `1.9.1`, which pulls
  the latest from upstream `ggml-org/whisper.cpp` v1.9.1 into our fork
  `tetherto/qvac-fabric-speech.cpp` (master `cb91a378`,
  [#73](https://github.com/tetherto/qvac-fabric-speech.cpp/pull/73)). The
  registry baseline is left unchanged; the override resolves the new version
  forward of the pinned baseline against
  [tetherto/qvac-registry-vcpkg#219](https://github.com/tetherto/qvac-registry-vcpkg/pull/219)
  (`whisper-cpp 1.9.1` port, REF `cb91a378`). This release ships it as `0.4.0`.

## [0.3.3] - 2026-06-24

### Changed

- Bumped the `whisper-cpp` vcpkg override from `1.8.5#3` to `1.8.5#5`, which
  refreshes the bundled `ggml-speech` from `2026-06-04` to `2026-06-15` (speech
  branch tip `7bb9f229`), keeping it consistent with the other speech-stack
  addons (`tts-cpp` already pins `ggml-speech 2026-06-15`). The `whisper-cpp`
  C++ source is unchanged between port-versions `#3` and `#5`, so this only
  moves `ggml-speech`. The registry baseline is left unchanged; the override
  resolves the new port-version forward of the pinned baseline (QVAC-21323,
  registry [tetherto/qvac-registry-vcpkg#210](https://github.com/tetherto/qvac-registry-vcpkg/pull/210)).

## Pull Requests

- [#2849](https://github.com/tetherto/qvac/pull/2849) - QVAC-21323 bci-whispercpp: consume ggml-speech 2026-06-15 (whisper-cpp 1.8.5#5)

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
