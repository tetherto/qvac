# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.0] - 2026-07-01

### Changed

- Bumped the `qvac-lib-inference-addon-cpp` vcpkg dependency to `1.2.2` (self-pin fix for safe `Worklet.terminate()` on Android).
- Bumped the `whisper-cpp` vcpkg override from `1.8.5#5` to `1.9.1`, which pulls
  the latest from upstream `ggml-org/whisper.cpp` v1.9.1 into our fork
  `tetherto/qvac-ext-lib-whisper.cpp` (master `cb91a378`,
  [#73](https://github.com/tetherto/qvac-ext-lib-whisper.cpp/pull/73)). The
  registry baseline is left unchanged; the override resolves the new version
  forward of the pinned baseline against
  [tetherto/qvac-registry-vcpkg#219](https://github.com/tetherto/qvac-registry-vcpkg/pull/219)
  (`whisper-cpp 1.9.1` port, REF `cb91a378`). This release ships it as `0.11.0`.

## [0.10.2] - 2026-06-24

### Changed

- Bumped the `whisper-cpp` vcpkg override from `1.8.5#3` to `1.8.5#5`, which
  refreshes the bundled `ggml-speech` from `2026-06-04` to `2026-06-15` (speech
  branch tip `7bb9f229`), keeping it consistent with the other speech-stack
  addons (`tts-cpp` already pins `ggml-speech 2026-06-15`). The `whisper-cpp`
  C++ source is unchanged between port-versions `#3` and `#5`, so this only
  moves `ggml-speech`. The registry baseline is left unchanged; the override
  resolves the new port-version forward of the pinned baseline (QVAC-21321,
  registry [tetherto/qvac-registry-vcpkg#210](https://github.com/tetherto/qvac-registry-vcpkg/pull/210)).

## Pull Requests

- [#2845](https://github.com/tetherto/qvac/pull/2845) - QVAC-21321 transcription-whispercpp: consume ggml-speech 2026-06-15 (whisper-cpp 1.8.5#5)

## [0.10.1] - 2026-06-22

### Changed

- Windows prebuilds now link the static Visual C++ runtime (`/MT`) instead of
  importing `vcruntime140.dll`, `msvcp140.dll`, or UCRT DLLs from the MSVC
  redistributable. Shared monorepo `vcpkg-overlays/triplets/{x64,arm64}-windows.cmake`
  build dependencies with a static CRT; addon CMake no longer links `msvcrt.lib`,
  which had forced the dynamic runtime. Per-package vcpkg overlays were
  consolidated into the shared `vcpkg-overlays/` tree. No public API change.

## Pull Requests

- [#2722](https://github.com/tetherto/qvac/pull/2722) - QVAC-21100: Switch to static C/C++ windows runtimes

## [0.10.0]

### Changed

- Bumped the `@qvac/infer-base` runtime dependency from `^0.4.0` to `^0.6.0` ([#2638](https://github.com/tetherto/qvac/pull/2638)).
- `vcpkg.json` now selects `whisper-cpp[metal]` on **iOS** as well as
  macOS (QVAC-20687). The separate featureless `ios` dependency entry is
  merged into the `osx` entry as a single `"platform": "osx | ios"` block
  requesting `["metal"]`, so Apple GPU backend selection is declarative
  and at parity with `transcription-parakeet`. Supersedes the 0.9.0 note
  that iOS shipped without the `[metal]` feature pending the iOS
  Metal/MTLCompiler XPC crash investigation.

### Added
- iOS Metal assertion in the mobile perf integration test
  (`test/integration/mobile-perf-runner.js`): with `use_gpu=true` on iOS
  the runner now asserts `backendId === 1` (Metal), mirroring the
  existing Android GPU-backend assertion. The on-PR iOS device-farm run
  thus guards that whisper engages Metal (and that the historical
  MTLCompiler XPC init crash has not regressed) instead of silently
  falling back to CPU.

## [0.9.0]

### Added
- New runtime stat keys for the active backend, populated once per
  `load()` and reported in every `runtimeStats()` snapshot (used by
  Android device-farm assertions):
  - `backendDevice` — post-fallback device class: `0` CPU, `1` GPU.
    Mirrors `transcription-parakeet`'s `backendDevice`.
  - `backendId` — `BackendId` enum: `0` CPU, `1` Metal, `2` CUDA, `3`
    Vulkan, `4` OpenCL, `99` other. Kept in lock-step with
    `transcription-parakeet`'s `BackendId` so the same integer means
    the same backend family across both speech-stack addons.
  - `gpuMemTotalMb` — total memory of the active GPU device in MiB (or
    `-1` if the backend does not expose memory accounting).
    Whisper-specific extra; parakeet does not expose this.
  - `gpuMemFreeMb` — free memory of the active GPU device in MiB (or
    `-1` if the backend does not expose memory accounting).
- `WhisperModel::captureActiveBackendInfo()` mirrors
  `whisper.cpp`'s own `whisper_backend_init_gpu()` selection (only
  `GGML_BACKEND_DEVICE_TYPE_GPU`, honour `gpu_device` index when
  set, otherwise first GPU in enumeration order) instead of a generic
  "first GPU/IGPU" walk, so the reported backend matches what
  whisper actually initialised against. Emits a `WARNING` through the
  addon logger when `use_gpu=true` was requested but no GPU device
  registered (silent CPU fallback case, parity with
  `ParakeetModel::loadModel()`).
- `BackendId` enum exported from `index.d.ts` (CPU / Metal / CUDA /
  Vulkan / OpenCL / Other), backing the new `RuntimeStats.backendDevice`
  / `backendId` fields.
- `metal` feature on the consumed `whisper-cpp` port (QVAC-19236). The
  `vcpkg.json` `osx | ios` dep entry now reads
  `whisper-cpp[metal]` for `osx` so the Apple GPU backend selection
  is declarative just like `[vulkan]` (linux/windows) and `[vulkan,
  opencl]` (android). iOS continues to ship without the `[metal]`
  feature until the separate iOS Metal/MTLCompiler XPC crash is
  resolved.

### Changed
- Bumped `whisper-cpp` to `1.8.5#0`:
  - Pure upstream-sync of `whisper.cpp` + bundled `ggml` to
    `ggml-org/whisper.cpp` master (~149 upstream commits, no
    tetherto-specific behavior change). Lands the v1.8.5 version
    string.
  - Switches the port from `add_subdirectory(ggml)` to
    `find_package(ggml CONFIG REQUIRED)` via
    `WHISPER_USE_SYSTEM_GGML=ON`, so `whisper-cpp`, `parakeet-cpp` and
    `tts-cpp` all link the **same** `ggml-speech` instance instead of
    bringing three separate ggml builds (QVAC-18992). The bundled
    `qvac-ext-lib-whisper.cpp/ggml/` directory is no longer walked at
    configure time.
  - GPU backend selection, dynamic-backend `.so` packaging on Android,
    per-arch CPU MODULE variants, Vulkan-Headers download and the
    spirv-headers `-isystem` shim are all owned by the `ggml-speech`
    port now; the whisper-cpp portfile shrank from ~160 lines to ~55.
- The `WhisperModel` native addon now `#include <ggml-backend.h>`
  unconditionally (was: `#if defined(__ANDROID__)` only) so the new
  `captureActiveBackendInfo()` enumerates devices on every platform,
  not just Android.

### Fixed
- `captureActiveBackendInfo()` now mirrors whisper.cpp's
  `whisper_backend_init_gpu()` selection exactly: it considers BOTH
  `GGML_BACKEND_DEVICE_TYPE_GPU` and `GGML_BACKEND_DEVICE_TYPE_IGPU`
  (was: GPU only). ggml-vulkan reports *integrated* GPUs — Mali,
  Adreno-via-Vulkan, Intel iGPU — as `IGPU`, so the previous GPU-only
  walk reported `backendDevice=0`/`backendId=0` and logged a spurious
  "fell back to CPU" warning on every Mali device even though whisper
  was actually running on the GPU via Vulkan (Metal/OpenCL/CUDA were
  unaffected — those backends report `GPU`). `gpu_device` is now
  treated as an index into the filtered GPU/IGPU list (default `0`),
  matching whisper's own indexing, instead of a raw device index.
- Adreno GPUs (Android) now use OpenCL instead of Vulkan. On Adreno ggml
  registers both a Vulkan and an OpenCL device for the same GPU, and
  `ggml_backend_load_all_from_path()` loads Vulkan first, so whisper's
  default (`gpu_device=0`) landed on the Adreno Vulkan device — whose driver
  SIGSEGVs in `vkCmdBindPipeline` during ggml compute. `load()` now detects a
  registered **Adreno** OpenCL device and steers `contextParams.gpu_device`
  to it. The detection mirrors `llm-llamacpp`'s `BackendSelection`
  (`isOpenCl && isAdreno`): the device's backend must be OpenCL AND its
  description must be an Adreno GPU, so a Mali/Intel OpenCL ICD would not
  trigger it and Mali stays on Vulkan. No-op on Mali / desktop, so the
  Mali→Vulkan and Metal paths are untouched. `captureActiveBackendInfo()` now
  takes the EXACT `use_gpu` / `gpu_device` the context was created with, so
  the reported backend always matches whisper's actual pick.
- Whisper/ggml native logs are redirected to JS through the addon logger
  (`QLOG`) with verbosity preserved (QVAC-19783). The previous
  `whisper_log_set(<no-op>)` swallowed every whisper.cpp and ggml log line;
  they are now forwarded via `whisper_log_set()` (the correct hook — whisper
  re-applies the callback to ggml during `whisper_backend_init_gpu()`, so a
  raw `ggml_log_set()` would be clobbered). `ggmlLevelToPriority()` maps each
  `ggml_log_level` to the matching logger `Priority` (ERROR/WARNING/INFO/DEBUG)
  so the JS-side logger level controls how much is shown — e.g.
  `ggml_vulkan: Found N Vulkan devices…` at DEBUG and
  `whisper_backend_init_gpu: using <name> backend` at INFO. Each callback is
  forwarded immediately (no cross-call buffering), mirroring `llm-llamacpp`'s
  `LlamaModel::llamaLogCallback`, so it is deterministic regardless of newline
  termination (whisper/ggml error paths emit lines without a trailing `\n`) —
  no message is held pending or merged into a later one at the wrong priority,
  and there is no unbounded buffer or partial line lost at shutdown. Nothing
  shows unless the host raises the level via `binding.setLogger()` /
  `--native-logs`. The forwarder is JS-free (`GgmlLogForwarding.hpp`) and
  unit-tested; it never throws back into ggml's C log path.

### Removed
- `transcription-whispercpp`-side `spirv-headers` / `vulkan-headers` /
  `vulkan-loader` registry routings related to whisper-cpp are no
  longer required by this addon's deps (parakeet/tts already routed
  them and they remain for those consumers). `whisper-cpp` now pulls
  Vulkan deps transitively through `ggml-speech[vulkan]`.

## [0.8.0]

### Added
- `whisperConfig.backendsDir` config option: absolute path to the root of the
  per-arch ggml backend `.so` modules (defaults to the package's `prebuilds/`
  folder). The native addon appends `<bare-target>/<module-name>` and feeds
  the result to `ggml_backend_load_all_from_path()`. Consumed only on Android;
  no-op everywhere else. Mirrors `transcription-parakeet`'s
  `parakeetConfig.backendsDir`.

### Changed
- Bumped `whisper-cpp` to `1.8.4.3#0`:
  - Syncs upstream `ggml-org/whisper.cpp` master up to v1.8.4.3, including
    the bundled-ggml bump to v0.10.2 and the upstream PR #3677 VAD streaming
    API (`whisper_vad_detect_speech_no_reset`, `whisper_vad_reset_state`).
  - Adds the `opencl` feature (Adreno OpenCL backend on Android).
  - Switches the Android build to full dynamic-backend mode
    (`GGML_BACKEND_DL=ON` + `GGML_CPU_ALL_VARIANTS=ON`): the addon `.bare`
    prebuild now ships one `libggml-cpu-android_armv*_*.so` per microarch
    plus dynamically-loaded `libggml-vulkan.so` / `libggml-opencl.so`, and
    ggml's loader picks the best CPU variant + GPU backend per device at
    runtime.
- Re-pinned the default-registry baseline to
  `a9d7e924de8cb7133c54c5b1d446e4d9c0508ec8`
  ([qvac-registry-vcpkg PR #152](https://github.com/tetherto/qvac-registry-vcpkg/pull/152)).
- Added `spirv-headers` to the `microsoft/vcpkg` registry routing — required
  because upstream whisper.cpp v1.8.4.3 unconditionally `#include`s
  `spirv/unified1/spirv.hpp` in `ggml-vulkan.cpp` and ggml's CMake does not
  `find_package(SpirvHeaders)`, so the standalone tree must be on the include
  path.
- GPU features (`opencl`, `vulkan`) are now selected entirely through
  `vcpkg.json` platform-gated `whisper-cpp` deps (matches
  `transcription-parakeet`'s pattern); the `ENABLE_VULKAN` / `ENABLE_OPENCL`
  CMake option indirection in `CMakeLists.txt` was removed. Override the
  feature set via `VCPKG_MANIFEST_FEATURES` if you need a non-default mix.

### Fixed
- Android E2E `SIGABRT` inside `whisper_init_from_file_with_params`
  (`ggml_abort` → `ggml_backend_dev_backend_reg+48` →
  `whisper_init_with_params_no_state+480`). With `GGML_BACKEND_DL=ON` the
  bundled ggml-base no longer defines `GGML_USE_CPU`, so the static
  `ggml_backend_registry` constructor registers zero backends and whisper's
  `ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr)` returns
  NULL → trips `GGML_ASSERT(device)`. The addon now hands
  `path.join(__dirname, 'prebuilds')` to the native side as
  `configurationParams.backendsDir`; on Android `WhisperModel::load` joins it
  with the compile-time `BACKENDS_SUBDIR` (`<bare_target>/<module_name>`)
  and calls `ggml_backend_load_all_from_path()` exactly once per process
  (`std::once_flag`). Mirrors
  `packages/{diffusion-cpp,llm-llamacpp,classification-ggml,…}`.
- `bare-make generate` on `android-arm64` failed with
  `get_target_property() called with non-existent target
  "ggml::ggml-cpu-android_armv8.0_1"`. With dynamic-backend mode the per-arch
  CPU + GPU backends are MODULE libraries that upstream ggml's
  `install(TARGETS … EXPORT)` skips; materialise a `SHARED IMPORTED` target
  locally from each `.so` under vcpkg's `bin/` before adding it to
  `BACKEND_DL_LIBS`. Mirrors `packages/diffusion-cpp`.
- Android APK consumers silently lost CPU init when the addon was packaged
  with `useLegacyPackaging=false` (the AGP ≥ 3.6 default). ggml's
  `ggml_backend_load_best()` directory iterator finds nothing inside
  compressed APK libs, and its on-disk filename fallback did not compose the
  per-arch `libggml-cpu-android_armv*_*.so` names that
  `GGML_CPU_ALL_VARIANTS=ON` produces. The upstream `whisper-cpp` bump now
  tries the bare backend name and all seven known `cpu-android_armv*_*`
  variants, then picks the highest-scoring one the device's HWCAP supports.
- `whisper-cpp[vulkan]` failed to build on `x64-windows` with `c1xx: fatal
  error C1083: Cannot open source file: '.../x64-windows/include'`. The
  spirv-headers include shim was emitting `-isystem <path>` into
  `CMAKE_CXX_FLAGS`, which MSVC's `cl.exe` treats as a positional source
  argument. The port now emits `/I<path>` on MSVC and keeps `-isystem
  <path>` on GCC/Clang.

### Removed
- Reverted the whisper-local `WhisperOutputCallBackJs` workaround introduced in `0.7.0`:
- Deleted `addon/src/addon/WhisperOutputCallbackJs.hpp` and its `#include` from `addon/src/addon/AddonJs.hpp`.
- `createInstance` in `addon/src/addon/AddonJs.hpp` now constructs the upstream `qvac_lib_inference_addon_cpp::OutputCallBackJs` directly.
- Removed the two `setImmediate` defense-in-depth yields (and their explanatory comment) from `WhisperInterface.destroyInstance()` in `whisper.js`.

## [0.7.0]

### Fixed
- iOS bare-kit hard-crash on `transcribe()` after `unload()` (Mach exception 309 / EXC_BAD_ACCESS / PAC failure inside `js_delete_reference` / `js_open_handle_scope`) caused by `qvac-lib-inference-addon-cpp` 1.1.6+ deferring `js_delete_reference()` into a `uv_close` close-callback that races worklet `js_env_t*` invalidation:
  - Added a whisper-local `WhisperOutputCallBackJs` (`addon/src/addon/WhisperOutputCallbackJs.hpp`) that subclasses `OutputCallBackInterface` and synchronously deletes the JS references in its destructor (1.1.5-style ordering), keeping only the no-op `uv_async_t` teardown deferred. Wired into `createInstance` in `addon/src/addon/AddonJs.hpp` instead of the upstream `OutputCallBackJs`.
  - Defense-in-depth: `WhisperInterface.destroyInstance()` (`whisper.js`) now yields twice via `setImmediate` after the native `destroyInstance` returns, guaranteeing a full libuv iteration boundary (and therefore the close phase) elapses before `unload()` resolves to the SDK.

### Changed
- Bumped `qvac-lib-inference-addon-cpp` to `1.1.7#1`.
- Bumped `whisper-cpp` to `1.8.4.2#1`.

## [0.6.8]

### Changed
- Reverted `qvac-lib-inference-addon-cpp` to `1.1.5#1` due to iOS crash. It will be updated again in 0.7.0.

## [0.6.7]

### Changed
- Bumped `qvac-lib-inference-addon-cpp` to `1.1.6`.

## [0.6.6]

### Removed
- Removed redundant `path` (`npm:bare-path`) and `process` (`npm:bare-process@^4.2.2`) entries from `dependencies` in `package.json`. The `bare-path` package is already declared directly as `bare-path: "^3.0.0"`, and `process` was unused.

## [0.6.5]

### Added
- Added opt-in conversation streaming events to `runStreaming()`. Callers can pass `emitVadEvents`, `endOfTurnSilenceMs`, and `vadRunIntervalMs` to receive `{ type: "vad" }` state updates and `{ type: "endOfTurn" }` silence boundary events alongside transcript segments.
- Added native `VadStateUpdate` and `EndOfTurnEvent` output handlers so VAD and end-of-turn events flow through the existing addon output queue without changing the default transcript-only streaming behavior.
- Added `examples/example.mic-conversation.js`, a microphone streaming example that logs VAD state, end-of-turn signals, and transcript output from live audio.
- Added C++ unit coverage for `StreamingProcessor` conversation events, JS unit coverage for event forwarding, and a live-stream integration variant that verifies VAD events are emitted with transcript output.

### Changed
- Extended `runStreaming(audioStream, opts?)` TypeScript declarations to include the new conversation streaming options and output event types.

## [0.6.4]

### Changed
- Fixed bug that prevented Vulkan from being turned on by default on linux and windows

## [0.6.3]

### Added
- Vulkan GPU acceleration enabled by default in CMakeLists.txt for Linux, Android, and Windows (macOS/iOS use Metal)
- Dynamic ggml backend library installation in CMakeLists.txt for Android/Linux (matching the LLM addon pattern)
- Vulkan SDK installation on Windows integration test runner so `vulkan-1.dll` is available at runtime
- `atexit` cleanup handler in `binding.cpp` that clears streaming sessions before C++ static destructors run
- Vulkan GPU smoke test in integration test workflow for Linux GPU runners
- RTF performance benchmark workflow with multi-model/multi-audio matrix support

### Changed
- GPU usage is now opt-in: `use_gpu` defaults to `false` in `toWhisperContextParams` instead of inheriting the upstream default (`true`). Callers must explicitly set `use_gpu: true` to enable GPU acceleration.

### Fixed
- Fixed SIGSEGV (exit code 139) at process exit on Linux GPU runners caused by ggml Vulkan backend static destructor ordering (upstream whisper.cpp#2373)
- Fixed "The specified module could not be found" error on Windows integration tests by installing the Vulkan runtime
- Fixed `t.skip()` calls in GPU smoke test (brittle does not support `t.skip`, replaced with `t.pass`)

## [0.6.2]

### Changed
- Fixed chunking issue re-introduced in 0.6.0 in which the inference output was not streamed but instead returned as a single batched result of the end.

## [0.6.1]

### Changed

- Changed `@qvac/transcription-whispercpp` package visibility on NPM from private to public

## [0.6.0]

This release is a significant interface modernisation. The constructor switches to a local-files map, model download is removed from the load path, concurrent inference runs are serialised instead of rejected, and the class no longer extends `BaseInference`.

## Breaking Changes

### Constructor now takes a `files` map instead of loader + model name

The old API accepted a `loader`, `modelName`, `vadModelName`, and `diskPath`. Those are all removed. Pass local file paths directly:

```typescript
// Before
new TranscriptionWhispercpp({ loader, modelName: 'ggml-tiny.bin', diskPath: '/models' }, config)

// After
new TranscriptionWhispercpp({ files: { model: '/models/ggml-tiny.bin', vadModel: '/models/silero-vad.bin' } }, config)
```

`files.model` is required; `files.vadModel` is optional. No download step occurs — files must already exist on disk before calling `load()`.

### `TranscriptionWhispercpp` no longer extends `BaseInference`

The class is now standalone. `instanceof BaseInference` checks and any BaseInference-only APIs (`getApiDefinition`, `downloadWeights`, loader helpers) are no longer available on this class.

### Weight download removed from `_load`

`_load` previously triggered a `WeightsProvider` download when a loader was supplied. That path is gone. Load preparation is now the caller's responsibility.

## New APIs

### `runStreaming(audioStream)` is now part of the public API

The VAD-based live streaming path was previously internal. It is now a documented public method with its own TypeScript declaration, accepting the same audio stream types as `run()`.

```typescript
const response = await model.runStreaming(audioStream)
for await (const segment of response) { /* ... */ }
```

### Concurrent runs serialise instead of throwing

When `exclusiveRun` is enabled (the default), a second call to `run()` or `runStreaming()` while a transcription is in progress will **wait** for the first to complete rather than throwing a `JOB_ALREADY_RUNNING` error. This makes it safe to call `run()` from concurrent contexts.

### New typed exports

`TranscriptionWhispercppFiles` and `InferenceClientState` are now exported from the `TranscriptionWhispercpp` namespace. Lifecycle methods (`load`, `unload`, `destroy`, `cancel`, `pause`, `unpause`, `stop`, `status`, `getState`) are now explicitly declared in `index.d.ts`.

## [0.5.6]

### Changed
- Fixed chunking issue introduced in 0.5.0 in which the inference output was not streamed but instead returned as a single batched result of the end.

## [0.5.5]

### Changed
- Bumped `inference-addon-cpp` to `1.1.5`.
- Restored JS-owned job ID routing after addon-cpp reverted the accidental `1.1.3` native callback `jobId` contract and `cancel(jobId)` API break.

### Added
- Regression coverage for JS-owned cancel handling of active, buffered, and stale wrapper job IDs.

### Removed
- References of s3 bucket throughout documentation and helper scripts

## [0.5.4]

### Changed

- README: removed outdated npm Personal Access Token / `.npmrc` setup instructions for installing `@qvac/transcription-whispercpp`.

## [0.5.3]

### Changed
- Bumped `inference-addon-cpp` to `1.1.3`.
- Updated the JS wrapper to consume the shared addon-cpp native job-id callback contract so late cancel/error events remain attached to the cancelled job instead of a newer accepted run.

### Added
- Regression coverage for rejected runs and stale cancel callbacks in the addon inference tests.

## [0.5.2]

Security hardening release from comprehensive security audit.

### Fixed
- Replace global streaming state with per-instance map to eliminate race condition and dangling pointer risk (#1079)
- Add 500 MB buffer limit to audio accumulation to prevent OOM from unbounded buffering (#1080)
- Add SHA-256 integrity verification to model download scripts using HuggingFace LFS checksums (#1081)
- Validate `suppress_regex` parameter — ban grouping constructs (parentheses) and enforce 512-char length limit to prevent ReDoS (#1083)
- Sanitize error messages to remove filesystem paths from thrown errors (#1084)
- Wrap job ID counter at `Number.MAX_SAFE_INTEGER` to prevent precision loss (#1085)
- Harden benchmark server: add library allowlist, restrict file paths to allowed directories, remove dynamic `npm install`, add body size limit, restrict CORS to localhost (#1086)

## [0.5.1]

This release documents runtime statistics and transcription output shapes in TypeScript so consumers can type `response.stats` and `run()` results against the native addon.

## New APIs

### `RuntimeStats` and related types in `index.d.ts`

The `TranscriptionWhispercpp` namespace now exports **`RuntimeStats`**, aligned with `WhisperModel::runtimeStats()` (`totalTime`, `realTimeFactor`, `tokensPerSecond`, `audioDurationMs`, `totalSamples`, `totalTokens`, `totalSegments`, `processCalls`, and Whisper-internal timing fields through `totalWallMs`). **`WhisperTranscriptionSegment`** and **`WhisperRunOutput`** describe transcription payloads passed to `onUpdate`. **`run()`** is typed to return **`Promise<QvacResponse<WhisperRunOutput>>`**, with a note that **`response.stats`** matches **`RuntimeStats`** when stats collection is enabled via `opts.stats`.

## [0.5.0]

### Changed
- Migrated the native addon implementation to `inference-addon-cpp` 1.x (`IModel` + `AddonJs`/`AddonCpp`), replacing the removed legacy templated addon and jobs-handler path
- Updated the JS/native execution path to `createInstance` + `runJob` with parity-focused cancel/output lifecycle handling

### Added
- Expanded C++/JS parity coverage for addon-cpp runtime behavior, including dedicated `AddonCpp` tests

## [0.4.2]

### Changed
- Logger type in `TranscriptionWhispercppArgs` now uses `LoggerInterface` from `@qvac/logging` instead of a package-specific type, aligning with the shared logging interface used across all addons

## [0.4.1]

### Added
- HuggingFace model download support for standard Whisper and Silero VAD models
- Download script `scripts/download-models.sh` for interactive model downloads
- Auto-download of models in test helpers (`ensureWhisperModel`, `ensureVADModel`)
- Architecture documentation

### Removed
- Legacy P2P data loader peer dependency and dev dependency
- Legacy examples (`transcription.hd.js`, `exampleVad.hd.js`)

## [0.4.0]

### Removed
- `TranscriptionFfmpegAddon` module (`transcription-ffmpeg.js`, `transcription-ffmpeg.d.ts`, `examples/example.ffmpeg.js`)
- `@qvac/util-transcription` dependency

## [0.3.18]

### Added
- Windows platform support with PowerShell-specific CI configurations
- Prebuild package renaming from `tetherto__*` to `qvac__*` format

### Fixed
- Whisper.cpp API compatibility updated to new 4-parameter `whisper_full()` API

### Changed
- Integration tests now use `bare@1.26.0` for build consistency

## [0.3.17]

### Fixed
- Spurious linux-x64 prebuild compilation issue

## [0.3.16]

### Changed
- Audio decoder dependency updated to use FFmpeg (`@qvac/decoder-audio` v0.3.3) instead of GStreamer
- `@qvac/util-transcription` updated to v0.1.4, replacing all GStreamer references with FFmpeg

## [0.3.15]

### Changed
- Linux x64 builds switched to Ubuntu 22.04 for wider glibc compatibility
- Integration test matrix expanded to include Ubuntu 22.04 and 24.04
- Vulkan SDK installation improved for x64 and arm64 Linux architectures

### Removed
- Unnecessary Vulkan SDK installation from integration tests
- Custom vcpkg installation step no longer needed with standard Ubuntu runners

## [0.3.14]

### Changed
- Debug symbols stripped from native addon binaries on Linux and macOS for smaller prebuilt artifacts

### Removed
- Redundant Android artifact replication step

## [0.3.13]

### Fixed
- Type declarations: `Loader` and `QvacResponse` now correctly imported from `@qvac/infer-base`
- `test:dts` now passes

## [0.3.12]

### Added
- TypeScript type declarations for `addonLogging` subpath export

### Fixed
- `test:dts` script now references `transcription-ffmpeg.d.ts` instead of deleted `transcription-addon/index.d.ts`

## [0.3.11]

### Added
- Runtime statistics support for Whisper model performance tracking
  - New `runtimeStats()` method exposing detailed metrics (totalTime, realTimeFactor, tokensPerSecond, audioDurationMs, etc.)
  - Integration test validating stats are populated when `opts.stats=true`

## [0.3.10]

### Added
- Linux ARM64 prebuild support using `ubuntu-24.04-arm` runner (#386)
- Linux ARM64 integration tests (#390)

### Changed
- Updated CODEOWNERS (#380)
- Updated PR description template with team practices (#391)

## [0.3.9]

### Added
- darwin-x64 (macOS Intel) prebuild support (#378)
- Windows x64 integration tests (#371)
- Full benchmark scripts (#372)
- vcpkg and ccache caching in prebuilds workflow for ~35% faster builds (#383)

### Fixed
- Eliminated cold start delay - first transcription now runs 3x faster (#385)
- CI workflow fixes for linux-x64 prebuild on GPU runner (#375)
- Permission fix for workflows (#376)

### Changed
- Freeze vcpkg version on macOS for build reproducibility (#377)

## [0.3.8]

### Added
- AraDiaWER metric for Arabic dialect speech recognition benchmarking (#358)

### Fixed
- FFmpeg example to correctly pass audio format (#363)

## [0.3.7]

### Changed
- Updated util-transcription dependency version (#360)

## [0.3.6]

### Changed
- Updated decoder dependency version (#359)

## [0.3.5]

### Added
- Unit tests for Whisper model file validation (#352)
- Model file and VAD path validation logic (#352)

## [0.3.4]

### Fixed
- Job ID return value (#353)

### Changed
- Reorganized examples and cleaned up unnecessary files (#356)

## [0.3.3]

### Added
- Addon logging JS interface export (#357)

## [0.3.2]

### Added
- Enhanced C++ logging for WhisperModel and job handlers (#349)
- DEBUG-level logs for job queue and audio input handling (#349)

### Fixed
- Configuration errors in examples (#341)
- Updated Bare runtime version requirement to >= 1.24.2 (#354)

### Changed
- Reworked integration tests to use TranscriptionWhispercpp (#345)
- Updated documentation to reflect current codebase structure (#354)
