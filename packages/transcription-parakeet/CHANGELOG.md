# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Bumped the `parakeet-cpp` `version>=` constraint to `2026-06-10` (whisper.cpp `1c75d6e9`), which refreshes the bundled `ggml-speech` to the current speech-branch tip `bec032cd`. The registry baseline is left unchanged. The `parakeet-cpp` C++ tree is unchanged since the previous `128dae42` pin, so this only moves `ggml-speech`; prebuilds and the desktop RTF benchmark now build against the latest speech stack (QVAC-20614).
- Performance reports now surface the desktop GPU hardware name. `test/integration/helpers.js` injects `bare-subprocess` into the shared performance reporter's `configure()` so `_detectGpu()` can shell out to nvidia-smi / vulkaninfo / system_profiler and populate `device.gpu` (e.g. "NVIDIA RTX 4000 SFF Ada") on GPU desktop runners (QVAC-20499). Mobile (Device Farm) reports continue to leave `device.gpu` null — the device name is the proxy there.
- RTF benchmark now reports GGML backends. `test/benchmark/rtf-benchmark.test.js` resolves the requested GPU backend family to the parakeet.cpp cascade (Metal on darwin/ios, Vulkan on linux/win32, Vulkan/OpenCL on android) instead of the stale ONNX names (coreml/nnapi/auto-gpu), and now captures the *actual* backend the engine ran on via `stats.backendId` / `stats.backendDevice` (`labels.activeBackend`, `summary.backendId`). `scripts/perf-report/aggregate-parakeet-rtf.js` GPU-backend coverage map updated to the GGML set (vulkan/metal/opencl/cuda).

### Fixed

- The desktop RTF benchmark now actually runs. `integration-test-transcription-parakeet.yml` gained the `run_rtf_benchmarks` input + an RTF benchmark step (per-`(modelType, useGPU)` matrix via `scripts/run-rtf-benchmark-matrix.js`, Vulkan on GPU runners) that `benchmark-performance-transcription-parakeet.yml` already expected but which did not exist, so the orchestrator previously passed an undefined input and produced no results. The matrix runner is now resilient (a single model-type/backend failure no longer sinks the whole leg), and the orchestrator's summarize no longer `merge-multiple`-clobbers same-platform runners. CI-only; not shipped with the npm package.

## [0.7.2]

This release fixes Android Parakeet stability on devices where Vulkan or OpenCL backend discovery can abort the process before CPU inference starts. Android Parakeet already forces CPU inference while GPU support is disabled, so the prebuild packaging now matches that runtime policy by staging only CPU ggml backend modules.

## Bug Fixes

### Android CPU Backend Packaging

Android prebuilds now stage only the CPU ggml backend `.so` files for Parakeet while `useGPU` is forced off on Android. This prevents Vulkan and OpenCL modules from being discovered during CPU model loading, avoiding native aborts on affected Mali and Adreno devices while keeping desktop and non-Android backend packaging unchanged.

## Pull Requests

No linked pull request numbers were found in the package-scoped commit messages for this release.

## [0.7.1] - 2026-06-02

### Changed

- Bumped the `qvac-lib-inference-addon-cpp` vcpkg dependency to `1.2.1`.

## [0.7.0]

In this release we validate the duplex-streaming end-of-utterance (EOU) surface of `parakeet-cpp` end-to-end and bump the native dependency to the latest port (`2026-05-26`), which carries the streaming-EOU plumbing plus the AOSC review-fixup follow-ups. There are no public addon API changes; the JS surface is unchanged and the bump is a runtime/native-dep upgrade plus mobile provisioning catch-up for the new Sortformer-Streaming v2.1 GGUF.

### Added
- **`test/integration/duplex-streaming-eou.test.js`** — duplex-streaming + EOU integration test. The existing `eou-streaming.test.js` covers the offline `runStreamingProcess_` path that calls `finalize()` on every `process()` invocation, and `duplex-streaming.test.js` covers the duplex `runStreaming()` path but only with the TDT model. This new test closes the gap: it loads the EOU model, drives it through the duplex `runStreaming()` API end-to-end (the same path `@qvac/sdk`'s `transcribeStream({ parakeetStreamingConfig })` uses), and asserts that at least one segment carries `isEndOfTurn === true`. Catches regressions where mid-stream `feed_pcm_f32` calls fail to reach `eou_decode_window` without an explicit `finalize()`, or where `ParakeetStreamingProcessor::onAsrSegment_` drops the `is_eou_boundary` flag.
- **Sortformer-Streaming v2.1 mobile provisioning.** `scripts/provision-mobile-models.sh` now stages the `diar_streaming_sortformer_4spk-v2.1.q8_0.gguf` GGUF for Device Farm runs, so mobile suites can exercise the v2.1 + AOSC code path that landed in `0.6.0`.
- **Mobile wiring for the duplex-streaming EOU test.** `test/mobile/integration.auto.cjs` and `.github/workflows/integration-mobile-test-transcription-parakeet.yml` are updated so the new duplex-streaming EOU test is picked up by the Device Farm runner alongside the existing mobile integration suite.

### Changed
- **parakeet-cpp dep bumped** to `version>= 2026-05-26` (was `2026-05-20#2`) across all three platform branches in `vcpkg.json` (macOS/iOS, Android, and the catch-all desktop branch). The new port revision ships the duplex-streaming EOU surface validated by this release together with the AOSC review-fixup follow-ups already integrated in `qvac-registry-vcpkg`'s latest `parakeet-cpp` revision.

## [0.6.0]

In this release we reestablish the GGML implementation from `0.4.0` with extra additions. The main features are exposing the v2.1 streaming Sortformer model with NeMo-port AOSC (Audio-Online Speaker Cache) through the addon's public API and overhaul the Android prebuild to ship the ggml backends as separately-loadable MODULE `.so` files. v2.1 becomes the recommended streaming Sortformer model; v1 stays the offline-batch default. On the Android side, Vulkan and OpenCL ship as runtime-discovered `.so` files (qvac-ext-ggml@speech's `GGML_BACKEND_DL=ON`), alongside per-arch CPU variants (`libqvac-speech-ggml-cpu-android_armv{8.0,8.2,8.6,9.0,9.2}_*.so`); inference still runs on CPU there pending Vulkan/Mali + OpenCL/Adreno driver fixes (`useGPU` is overridden at the engine boundary), but the GPU `.so` files are in place for when the override is lifted.

### Added
- **AOSC config knobs.** `ParakeetConfig` gains six optional fields — `streamingSpkCacheEnable` (default `true`), `streamingSpkCacheLen` (188), `streamingFifoLen` (188), `streamingChunkLeftContextMs` (80), `streamingChunkRightContextMs` (560), `streamingSpkCacheUpdatePeriod` (144) — forwarded into `parakeet::SortformerStreamingOptions` for both the in-process Mode-3 streaming path (`ParakeetModel::runStreamingProcess_`) and the duplex `runStreaming()` processor (`ParakeetStreamingProcessor`). Mirrored as per-call overrides on `StreamingRunConfig` (`spkCacheEnable`, `spkCacheLen`, `fifoLen`, `chunkLeftContextMs`, `chunkRightContextMs`, `spkCacheUpdatePeriod`). parakeet-cpp ignores these on v1 / v2 Sortformer GGUFs and on non-Sortformer engines, so always-forward is safe.
- **v2.1 Sortformer auto-detection.** When a `diar_streaming_sortformer_4spk-v2.1.*` GGUF is loaded, parakeet-cpp's engine recognises it from the GGUF metadata tag `parakeet.model_variant == "sortformer-streaming-v2.1-aosc"` and enables AOSC by default. Setting `streamingSpkCacheEnable: false` forces the v1 sliding-window code path on a v2.1 model (A/B comparison).
- **`examples/live-mic-diarized-aosc.js`** — v2.1-focused dual-stream live mic example mirroring `live-mic-diarized.js`'s ASR + Sortformer pattern, with CLI flags for every AOSC knob (`--spk-cache-enable`, `--spk-cache-len`, `--fifo-len`, `--chunk-left-context-ms`, `--chunk-right-context-ms`, `--spk-cache-update-period`).
- **`test/integration/sortformer-aosc-streaming.test.js`** — covers default-AOSC streaming and `streamingSpkCacheEnable=false` fallback. The full AOSC slot-stability contract (same physical speaker → same `Speaker N` tag across non-contiguous re-entries) is verified at C++ level in `parakeet-cpp/test/test_sortformer_aosc_speakers.cpp`; this JS-level test focuses on wiring correctness — that the override actually reaches the engine and the engine emits well-formed segments in both modes.
- **`MODEL_CONFIGS.sortformerStreaming`** entry in `test/integration/helpers.js` pointing at `diar_streaming_sortformer_4spk-v2.1.q8_0.gguf`. Tests skip cleanly when the GGUF isn't staged via `npm run setup-models` / `QVAC_TEST_GGUF_*`.
- **`backendsDir` ParakeetConfig field.** Directory the native addon scans for dynamically-loaded ggml backend libraries (`libqvac-speech-ggml-vulkan.so`, `libqvac-speech-ggml-opencl.so`, per-arch `libqvac-speech-ggml-cpu-android_armv*_*.so`).
- **`openclCacheDir` ParakeetConfig field.** Persistent directory for ggml-opencl's `clCreateProgramWithBinary` cache.
- **CMake install plumbing for dynamic ggml backends.** Two complementary install paths cover the full backend set that the `ggml-speech` vcpkg port emits on Android.
- **`BACKENDS_SUBDIR` compile define** on the addon target. Derived from cmake-bare's `bare_target()` + `bare_module_target()` so the addon can join `<bare-target>/<module-name>` onto the host-provided `backendsDir` root without the host needing to know the per-target shape.
- **Mobile dynamic-backend coverage.** `test/mobile/integration-runtime.cjs` now sets `NO_GPU=false` so Device Farm runs `gpu-smoke` and `mobile-perf-*-gpu` tests that exercise backend dlopen / discovery (Vulkan, OpenCL, and per-arch CPU `.so` loading). On Android, inference still runs on CPU (`useGPU` is overridden at the engine boundary and gpu-smoke passes early); iOS may engage Metal when `useGPU: true`.

### Changed
- **parakeet-cpp dep bumped** to `version>= 2026-05-20#2` (was `2026-05-05#1`) across all three platform branches in `vcpkg.json`. The new port (qvac-registry-vcpkg PR #156 + the `ggml-speech#3` follow-up) pulls in PRs #22 + #24 of `qvac-ext-lib-whisper.cpp`, which introduce the v2.1 Sortformer support, AOSC engine implementation, strict variant detection via the `parakeet.model_variant` GGUF tag, and review-fixup cleanups (magic-number elimination, dead-code removal, test utility consolidation, Windows `<algorithm>` include), and tightens the `ggml-speech` constraint to the per-arch Android CPU build (`GGML_CPU_ALL_VARIANTS=ON`).
- **`index.js::_buildConfigurationParams()`** now forwards the 6 new AOSC fields (and explicit defaults for unset values) into `createInstance` / `reload`. Without this, JSDoc + native plumbing would exist but JS-layer overrides would never reach C++.
- **`examples/live-mic-diarized.js`** header: recommends the v2.1 GGUF as `--diar-model` and notes that `streamingHistoryMs` is superseded by AOSC on v2.1 models (kept for v1 back-compat). Points to the new `live-mic-diarized-aosc.js` for explicit knob control.
- **`examples/diarized-transcribe.js`** header: notes v1 remains the recommended OFFLINE diarization model — AOSC's slot-stability benefit only applies to continuous streaming and is wasted in batch mode.
- **`README.md`** — extended Model Variants table with v1 (offline default) and v2.1 + AOSC (streaming default) rows; new `streamingSpkCache*` rows in the ParakeetConfig table; dedicated "Sortformer Streaming Diarization (v2.1 + AOSC)" section explaining the v1-drift problem AOSC solves, the model-variant auto-detection, and when to leave the defaults alone.

## [0.5.0]

- Temporarily reverted back to ONNX implementation of `0.3.3` to ensure stability in SDK `0.11.*`.
- Bumped `inference-addon-cpp` dependency version to `1.1.7#1`.
- Bumped `onnx` dependency version to `0.15.0`.

## [0.4.0]

In this release, we have replaced the onnxruntime backend with a pure C++/ggml engine, added a duplex-streaming entry point that bypasses the framework's batch-then-process lifecycle for live use cases, and surfaced two new per-segment signals (`isEndOfTurn`, `startsWord`) so consumers can build cleaner live transcripts. The release also exposes per-engine backend stats (`backendDevice`, `backendId`) so callers can verify the GPU path actually engaged, and consolidates the examples / docs / mock fixtures into a single duplex-aware surface.

### Changed (BREAKING for model files)
- Replaced the onnxruntime backend with the parakeet-cpp backend. The native addon no longer ships ONNX Runtime; the ggml dependency is now provided by the dedicated `ggml-speech` vcpkg port (separate from the `parakeet-cpp` port itself), with a `qvac-speech-` library prefix so it can coexist with the fabric/llm `qvac-` and the diffusion `qvac-diffusion-` ggml flavours on the same Android device.
- Models now load from a single `.gguf` file per checkpoint instead of the legacy multi-file ONNX layout. Tokenizer + hyperparameters travel inside the GGUF metadata; no side-loaded files.
- `loadWeights({ filename, chunk, completed })` now expects a single `.gguf` filename. Non-`.gguf` filenames are ignored with a warning for back-compat with callers still iterating an ONNX file list.
- `Engine::transcribe_stream` and `StreamSession` are wired through the new backend; existing `is_eou_boundary` + `eot_confidence` slots on `StreamingSegment` now reflect parakeet-cpp's native EOU `<EOU>` token detection.
- `runtimeStats()` now returns (`encoderMs`, `decoderMs`, `melSpecMs`, `totalEncodedFrames`, `backendDevice`, `backendId`) besides existing stats. `backendDevice` (0 = CPU, 1 = GPU) and `backendId` (`BackendId` enum: 0=CPU, 1=Metal, 2=CUDA, 3=Vulkan, 4=OpenCL, 99=other) are captured once at `loadModel()` from `parakeet::Engine::backend_device()` / `backend_name()` and reflect the post-fallback truth -- a `useGPU: true` request that silently falls back to CPU at runtime surfaces as `backendDevice: 0` / `backendId: 0`.

### Added
- **Duplex streaming entry point.** `TranscriptionParakeet.runStreaming(audioStream, streamingConfig?)` opens a long-lived `parakeet::StreamSession` (or `SortformerStreamSession`) on the C++ side and feeds each pushed chunk straight in -- bypassing the `run()` path's append-buffer-then-process lifecycle. Per-chunk segments surface through the regular `onUpdate(...)` channel as soon as the engine emits them, with full streaming session state (rolling encoder context, EOU detector, Sortformer history) preserved across chunks. The lower-level `startStreaming` / `appendStreamingAudio` / `endStreaming` / `cancelStreaming` methods are exposed on `ParakeetInterface` for callers that want to drive the session manually. New `StreamingRunConfig` type for per-call `chunkMs` / `historyMs` / `leftContextMs` / `rightLookaheadMs` / `emitPartials` / `emitEnergyVad` overrides.
- **C++ `ParakeetStreamingProcessor`** (mirrors transcription-whispercpp's `StreamingProcessor`): a worker-thread-driven class that owns the duplex session lifetime, drains audio from a `pending_` queue under `mtx_+cv_`, calls `feed_pcm_f32` directly, and queues per-segment `Transcript`s into `addonCpp->outputQueue` so the JS `onUpdate` channel surfaces them with no batching. New binding entry points wire in via `qvac_lib_infer_parakeet::{startStreaming,appendStreamingAudio,endStreaming,cancelWithStreaming,destroyInstanceWithStreaming}` in `AddonJs.hpp`.
- `TranscriptionSegment.isEndOfTurn` boolean field. EOU streaming sessions set this on every segment whose chunk contained an `<EOU>` token, so consumers can detect end-of-turn boundaries independently of segment text. CTC / TDT / Sortformer always leave the field `false`. Replaces the never-fired synthetic `<EOU>` text marker that earlier 0.4.0 builds attempted to surface.
- `TranscriptionSegment.startsWord` boolean field. Forwarded from the upstream `parakeet::StreamingSegment::starts_word` flag, which is set true when the segment's first token is a SentencePiece word-start (the piece begins with the `▁` U+2581 marker). Streaming consumers building a running transcript can use it to gate the inserted separator: concatenate verbatim when `startsWord === false` to rejoin chunk-boundary wordpiece splits like `["pun", "ctuation"]` into `"punctuation"` instead of `"pun ctuation"`. Default `true` so callers that ignore it see no behaviour change.
- `streamingLeftContextMs` and `streamingRightLookaheadMs` config knobs. Forwarded to `parakeet::StreamingOptions::left_context_ms` / `right_lookahead_ms`. ASR sessions only (Sortformer ignores them). `-1` keeps parakeet-cpp's defaults (10000 / 2000 ms). `right_lookahead_ms` adds directly to the per-segment latency floor; tune lower for snappier live transcripts at the cost of chunk-boundary accuracy.
- Long-form audio support for the TDT engine carries over from 0.3.3 (`runEncoderChunked`-style mel-spectrogram windowing) but is now handled natively by the parakeet-cpp engine's `transcribe_samples` / `StreamSession` paths -- no addon-side chunked driver needed.
- Four flag-driven examples that replaced the old per-model quickstart: `examples/transcribe.js` (any GGUF, all engine types), `examples/diarized-transcribe.js` (combined Sortformer + ASR), `examples/live-mic.js` (default-device live transcription via `sox`, now using `runStreaming` for sub-second latency), and `examples/live-mic-diarized.js` (live mic with parallel Sortformer + ASR for speaker-tagged transcripts).
- `scripts/download-models.sh` (downloads upstream NeMo `.nemo`) and `scripts/convert-nemo.sh` (wraps qvac-parakeet.cpp's `convert-nemo-to-gguf.py`); `npm run setup-models` runs both.
- `test/integration/eou-streaming.test.js` covering the EOU streaming session's `isEndOfTurn` boundary detection.
- `test/integration/duplex-streaming.test.js` -- end-to-end coverage for `runStreaming()`: asserts segments arrive BEFORE the input is exhausted (genuine streaming-out, not batched in JS) and that the response settles cleanly after `endStreaming`.
- `test/integration/gpu-smoke.test.js` -- flips `useGPU: true` across all four model types (CTC / TDT / EOU / Sortformer) and gates strictly on `response.stats.backendDevice` + `backendId`. `QVAC_PARAKEET_GPU_SMOKE_RELAX=1` downgrades the gate to a warning (Adreno-6xx phones where ggml-opencl rejects the device by design, Android emulator / iOS simulator without GPU support, Linux / Windows hosts without a Vulkan-capable GPU or Vulkan SDK).
- `test/unit/streaming-duplex.test.js` -- mock-binding unit coverage for the JS duplex plumbing (`runStreaming` round-trips through `startStreaming` / `appendStreamingAudio` / `endStreaming` without buffering, `cancel` routes through the streaming-aware C++ shim, append without an active session throws).
- English-CTC accuracy assertion in `test/integration/accuracy-multilang.test.js` (was previously TDT/EOU only); WER coverage for all three ASR heads now lives there.
- `BackendId` enum exported from `index.d.ts` (CPU / Metal / CUDA / Vulkan / OpenCL / other), backing the new `RuntimeStats.backendDevice` / `backendId` fields. See `index.d.ts` for the numeric codes and the per-platform GPU policy.
- `examples/decode-audio.js` -- same flag surface as `examples/transcribe.js`, but pipes audio through `@qvac/decoder-audio` (FFmpeg) before inference so any container / codec FFmpeg supports (mp3, m4a, ogg, flac, mp4, ...) works, not just 16 kHz mono `.wav` / raw s16le PCM.
- `scripts/setup-venv.sh` + `scripts/requirements.txt` -- idempotent local Python venv bootstrap for `convert-nemo-to-gguf.py` (CPython 3.10+; pins `nemo_toolkit`, `huggingface_hub`, `sentencepiece`, ...). Driven by `npm run setup:venv` and transitively by `npm run setup-models`.

### Removed
- `@qvac/onnx` peer dependency; `eigen3`, `qvac-onnx` cmake config, ONNX file-name lists in `examples/utils.js`.
- `@qvac/dl-base` and `@qvac/dl-filesystem` devDependencies, and `bare-buffer` -- no longer needed: weights flow through the framework's `loadWeights` callback against the single `.gguf` file, and `bare-buffer` was only an examples-side helper.
- `examples/quickstart-{ctc,eou,sortformer,diarized,ggml}.js` and `examples/quickstart.js` (folded into `examples/transcribe.js`).
- `examples/example.decoder.js` (superseded by `examples/decode-audio.js`).
- `examples/samples/two-speakers-16k.wav`, replaced by `examples/samples/jfk.wav` and `examples/samples/sample_mp3.mp3` so the new decode + live-mic examples have non-WAV input fixtures.
- 4 ONNX-specific integration tests (`external-data-staging`, `individual-file-paths`, `named-paths-all-models`, `named-paths-reload`).
- `test/integration/addon.test.js` (legacy generic addon-lifecycle integration test; superseded by `addon-multimodel.test.js` and `eou-streaming.test.js`).
- `test/mocks/loader.fake.js` and `test/mocks/test.models.json` -- unused after the constructor `loader` argument was dropped in 0.3.0 and the multi-file ONNX model manifest stopped existing.
- `DEVELOPMENT.md`, `CONTRIBUTING.md`, `QUICKSTART.md` (folded into the README).
- `addon/CMakeLists.txt` -- the addon subproject is now driven directly from the top-level `CMakeLists.txt`.
- Dead code: `addon/src/model-interface/parakeet/ParakeetHandlers.{hpp,cpp}` (unused handler maps + `MiscConfig` + `computeOptimalThreads()`), `JSAdapter::loadMap`, and the `JSValueVariant` typedef -- no consumers anywhere in the package since the JSAdapter rewrite went direct via `getOptionalProperty<>()`.

### Fixed
- **Data race in `ParakeetModel::cancel()`.** `asr_session_` / `diar_session_` reads now sit under a dedicated `session_mutex_` so they cannot race against `openStreamingSession_()` / `closeStreamingSession_()` / `endOfStream()` / `~ParakeetModel`. The framework documents `cancel()` as concurrent with `process()`/`unload()`/`reload()`, and the previous unsynchronised access could deref a torn `unique_ptr`. `closeStreamingSession_()` uses a snapshot-and-release pattern (move ownership out under the lock, run the session destructor outside) so a concurrent `cancel()` can never observe a half-destroyed session.
- **Double-join race in `ParakeetStreamingProcessor`.** `end()` / `cancel()` / `~ParakeetStreamingProcessor`'s fallback `cancel()` now serialise through a `std::once_flag teardown_once_` so `thread_.join()` runs at most once across the three paths. Without this, a race between `end()` and `cancel()` (or two `cancel()` calls) could pass `thread_.joinable()` simultaneously and the loser's `join()` would raise `std::system_error`.
- **`runAsrProcess_` encoder-time mis-attribution.** Per-stage timings now record verbatim from `parakeet::EngineResult`. The earlier wall-clock fallback (substitute `transcribe_samples`'s total when `encoder_ms == 0`) silently rolled mel + decoder time into the encoder bucket, inflating it roughly 3-5x on the first call.
- **`_runInternal` / `_runStreamingInternal` job leak on synchronous kickoff failure.** `_runInternal` now wraps the `_normalizeAudioStream` call in `try/catch` -> `_job.fail(error); throw` so a synchronous throw (e.g. `null` input) doesn't leave `_job.active === true` for the next `run()`. `_runStreamingInternal` similarly wraps the `await this.addon.startStreaming(...)` call so a rejected `startStreaming` (engine not loaded, `dynamic_cast` failure, session already populated, ...) fails the job before propagating.

### Changed (docs / behaviour clarifications)
- **Cross-call streaming-state scope**, spelled out everywhere it was implied: `index.d.ts`, `index.js`, `parakeet.js`, README's `streaming` row, `ParakeetConfig.hpp`'s comment, and the inline comment in `runStreamingProcess_`. Within a single `run()` call the streaming session preserves state (Sortformer speaker history, EOU rolling window, partial decode state); across separate `run()` calls on the same model instance, the session is closed and reopened, so cross-call state is lost. For continuous live capture, drive a single long-running `run()` from a pushable stream, or use `runStreaming()` (which owns one streaming session for the lifetime of the call regardless of append count).
- **`endStreaming()` synthetic `JobEnded` now reports real stats.** The C++ `cleanupStreamingSession()` returns `{ cleaned, audioDurationMs, totalSamples }` captured from `ParakeetStreamingProcessor::audioSeconds()` right after the worker thread joins. JS plumbs those into the synthetic `JobEnded` payload so consumers reading `response.stats.audioDurationMs` / `totalSamples` after a duplex `runStreaming()` get a non-zero value (the framework's `RuntimeStats` path is bypassed by the duplex processor entirely).
- **`ParakeetModel::reload()`** now throws an explicit `InternalError` when `cfg_.modelPath` is empty -- the in-memory `gguf_buffer_` is dropped on `unload()`, so a model originally loaded from streamed bytes without a temp file would otherwise fail mid-load with a less obvious error.
- **ASR streaming default `chunk_ms`** is now 2000 (was 1000) when `streamingChunkMs <= 0`, matching the documented default in README / `index.d.ts` / `index.js`.
- **`streamingHistoryMs` warning** logged when set on a non-Sortformer (CTC / TDT / EOU) instance, since the option is silently ignored for ASR streaming sessions.
- **`parakeet.js` `_addonOutputCallback`** event mapping trusts explicit `'Output' / 'JobEnded' / 'Error'` event strings verbatim and only falls back to data-shape sniffing when the event is unrecognised, preventing silent misclassification if a future framework event happens to share a key name.
- **`parakeet.js` `pause()` / `status()`** JSDoc now explicitly notes these are JS-side state-machine flips that don't reach the native engine; use `cancel()` / `stop()` to actually abort an inference call.
- **`index.d.ts`** Vulkan doc now reflects reality (`enabled on Linux / Windows / Android via parakeet-cpp[vulkan]`) instead of "not yet enabled".
- **README's Stage-a-Model section** lists `sentencepiece` as a venv requirement (matching `scripts/requirements.txt`); `convert-nemo-to-gguf.py` raises a clear actionable error if `huggingface_hub` is missing instead of opaque `ImportError` (with a pointer at `download-models.sh`, the documented entry point that needs no Python deps for download).
- **README's Run Inference section** calls out the 500 MiB `MAX_BUFFERED_BYTES` cap on a single `run()` call (~4 hours of 16 kHz int16 audio) so consumers picking `run()` over `runStreaming()` for very long captures know to split into sequential calls (or use `runStreaming` instead, which has no per-call buffer cap).
- **`ParakeetModel::addTranscription`** now annotated as test-only.
- **`ParakeetModel::endOfStream` / `isStreamEnded`** now annotated as framework-only -- the duplex `runStreaming()` path (`ParakeetStreamingProcessor`) owns its own session and never sets `stream_ended_`, so consumers must not gate cleanup on `isStreamEnded()` after `runStreaming()`.
- **`package.json` dependency reshuffle.** `bare-subprocess` added as a runtime dependency (the new `live-mic*` examples spawn `sox` through it). `bare-process` moved from `dependencies` to `devDependencies` (examples / tests only). `typescript` added as a devDependency so `test:dts` can lint both `index.d.ts` and `addonLogging.d.ts` under `--lib es2018 --esModuleInterop --skipLibCheck`. The old `path` / `process` npm aliases (`path: npm:bare-path`, `process: npm:bare-process`) are gone -- consumers should `require('bare-path')` / `require('bare-process')` directly.

## [0.3.3]

This release adds long-form audio support to the Parakeet TDT pipeline. Audio inputs that previously failed against the encoder's static positional-encoding ceilings are now transcribed by streaming the mel-spectrogram through the encoder in overlapping windows.

### Added

- **Long-form audio support for the TDT encoder.** The exported encoder graph has hard-coded positional-encoding length ceilings (a long-range bucket of 9999 frames and a tighter relative bucket of 3000 frames). Inputs longer than ~240s of audio (~24000 mel frames, the binding 3000-frame bucket × 8× subsampling) previously could not be transcribed in a single TDT call. A new `runEncoderChunked` path slides over the mel-spectrogram in ~200s windows with ~20s of shared context, runs the existing encoder per window, trims half of the overlap from each interior boundary so the concatenated output is gap-free and duplicate-free along the time axis, and feeds a single merged `[ENCODER_DIM, T]` buffer to `greedyDecode`. Short audio (≤ one window) keeps the original single-pass path with zero overhead. Cancellation is honored between windows. The chunk/overlap constants are guarded by a compile-time `static_assert` against the encoder's positional-encoding ceiling so future tuning fails to build rather than silently producing invalid windows.

## [0.3.2]

### Fixed
- Fixed model activation failure on Windows when the user lacks `SeCreateSymbolicLinkPrivilege`. The external data staging in `loadTDTSessions` and `loadCTCSessions` now uses a symlink → hardlink → copy fallback chain. Staging directories are created next to the model files so hardlinks stay on the same volume, avoiding unnecessary multi-GB copies.

### Added
- Integration test `external-data-staging.test.js` that validates model loading with external data files (`.onnx.data`) via the staging fallback mechanism.

## [0.3.1]

### Added
- Registered ONNX Runtime execution providers for GPU acceleration when `useGPU: true` is set. The `useGPU` config flag was previously accepted but never applied to session creation. Platform EPs are now active: CoreML (macOS/iOS), DirectML (Windows), NNAPI (Android). Falls back to CPU automatically if the GPU provider fails.

### Changed
- Session options are now built via `onnx_addon::buildSessionOptions()` from `@qvac/onnx`, replacing manual `Ort::SessionOptions` construction. This aligns Parakeet with the same EP registration logic used by the OCR package.

## [0.3.0]

This release replaces the two-argument `TranscriptionParakeet` constructor with a clean single-options interface, removes the external loader dependency, and simplifies the internal job-management pipeline.

## Breaking Changes

### Unified constructor interface — `new TranscriptionParakeet({ files, config })`

The constructor signature has changed from the legacy two-argument form `(args, config)` to a single `opts` object. The old `args` accepted `loader`, `modelName`, and `diskPath`; the old `config` held all named file paths at the top level. The new interface groups model file paths under a `files` map and non-path settings under `config`.

**BEFORE:**
```javascript
const model = new TranscriptionParakeet(
  { loader, modelName, diskPath },
  {
    encoderPath: '/path/to/encoder-model.onnx',
    decoderPath: '/path/to/decoder_joint-model.onnx',
    vocabPath: '/path/to/vocab.txt',
    preprocessorPath: '/path/to/preprocessor.onnx',
    parakeetConfig: { modelType: 'tdt', maxThreads: 4, useGPU: false }
  }
)
```

**AFTER:**
```javascript
const model = new TranscriptionParakeet({
  files: {
    encoder: '/path/to/encoder-model.onnx',
    decoder: '/path/to/decoder_joint-model.onnx',
    vocab: '/path/to/vocab.txt',
    preprocessor: '/path/to/preprocessor.onnx'
  },
  config: {
    parakeetConfig: { modelType: 'tdt', maxThreads: 4, useGPU: false }
  }
})
```

### `downloadWeights()` removed

The public `downloadWeights()` method has been removed. External weight downloading is no longer part of this package's responsibility. Use the `files` map to supply pre-downloaded model paths directly.

### `BaseInference` inheritance removed

`TranscriptionParakeet` no longer extends `BaseInference` and no longer depends on `WeightsProvider`. It is now a self-contained class that manages its own logger, run queue, and job lifecycle.

## New APIs

### `TranscriptionParakeetFiles`

A new exported `TranscriptionParakeetFiles` interface captures all model file paths accepted by the constructor:

```typescript
interface TranscriptionParakeetFiles {
  encoder?: string;      // TDT encoder-model.onnx
  encoderData?: string;  // TDT encoder-model.onnx.data
  decoder?: string;      // TDT decoder_joint-model.onnx
  vocab?: string;        // TDT vocab.txt
  preprocessor?: string; // TDT preprocessor.onnx
  model?: string;        // CTC model.onnx
  modelData?: string;    // CTC model.onnx_data
  tokenizer?: string;    // CTC/EOU tokenizer.json
  eouEncoder?: string;   // EOU encoder.onnx
  eouDecoder?: string;   // EOU decoder_joint.onnx
  sortformer?: string;   // sortformer.onnx
}
```

### `status()`, `pause()`, `unpause()`

Three new public methods expose addon lifecycle control: `status()` queries the native addon status, `pause()` suspends inference, and `unpause()` resumes it.

## Other

Job management is now handled by `createJobHandler()` from `@qvac/infer-base ^0.4.0`, replacing the manual `_hasActiveResponse` flag and `_failAndClearActiveResponse()` helper. `_resolveFilePath()` now takes only a `filename` argument. Dead helpers `_hasNamedPaths()` and `_getModelFilePath()` have been removed.

## [0.2.7]

### Changed
- Bumped `inference-addon-cpp` to `1.1.5`.
- Restored JS-owned job ID routing after addon-cpp reverted the accidental `1.1.3` native callback `jobId` contract and `cancel(jobId)` API break.

### Added
- Regression coverage for JS-owned cancel handling of active, buffered, and stale wrapper job IDs.

## [0.2.6]

### Changed
- Switched ONNX Runtime linkage from direct vcpkg dependency to `@qvac/onnx` shared module, aligning with the OCR package pattern for consistent cross-addon runtime sharing

## [0.2.5]

### Changed
- Switched desktop Parakeet prebuilds to static ONNX Runtime linking so packaged platform artifacts stay as a single `.bare` addon plus exports file
- Aligned the secondary native build path and Linux linkage behavior with the desktop packaging update to keep runtime loading working after removing bundled shared libraries

### Fixed
- Apple prebuild compatibility by replacing the `std::ranges::find` sample-rate check with a `std::find` implementation that works on the current Xcode toolchains

## [0.2.4]

Security hardening release from comprehensive security audit.

### Fixed
- Add 500 MB buffer limit to audio accumulation to prevent OOM from unbounded buffering (#1080)
- Add SHA-256 integrity verification to model download scripts using HuggingFace LFS checksums (#1081)
- Sanitize error messages to remove filesystem paths from thrown errors (#1084)
- Wrap job ID counter at `Number.MAX_SAFE_INTEGER` to prevent precision loss (#1085)
- Harden benchmark server: add library allowlist, restrict file paths to allowed directories, remove dynamic `npm install`, add body size limit, restrict CORS to localhost (#1086)

## [0.2.3]

### Added
- RTF benchmark integration test (`rtf-benchmark.test.js`) that captures Real-Time Factor and 12 other timing metrics from the C++ addon's `runtimeStats` callback
- `test:benchmark:rtf` npm script for on-demand RTF benchmark runs
- RTF benchmark step in integration test CI workflow (non-blocking, all 6 runners) with JSON artifact upload

## [0.2.2]

This release documents Parakeet runtime statistics and transcription output in TypeScript so consumers can type `response.stats` and `run()` results against the native addon.

## New APIs

### `RuntimeStats` and `ParakeetRunOutput` in `index.d.ts`

The `TranscriptionParakeet` namespace now exports **`RuntimeStats`**, aligned with `ParakeetModel::runtimeStats()` (throughput, audio duration, token and transcription counts, pipeline timing fields through `totalEncodedFrames`). **`ParakeetRunOutput`** is **`TranscriptionSegment[] | TranscriptionSegment`**, matching array or single-segment updates from the addon. **`run()`** is typed to return **`Promise<QvacResponse<ParakeetRunOutput>>`**, with documentation that **`response.stats`** matches **`RuntimeStats`** when stats collection is enabled via `opts.stats`.

## [0.2.1]

This release fixes `reload()` for setups that use per-file model paths (TDT, CTC, EOU, Sortformer), so the native addon keeps receiving the same paths after a reload as on the initial load.

## Bug Fixes

### reload() missing named path passthrough

`reload()` rebuilt configuration without the individual file paths (`encoderPath`, `decoderPath`, `vocabPath`, and the other named path fields). After `reload()`, the addon no longer saw those paths and could not load the model correctly. `reload()` now builds configuration through the same `_buildConfigurationParams()` helper as `_load()`, so named paths are always included. When named paths are in use, `reload()` also skips streaming weights via `_loadModelWeights`, matching initial load behavior and avoiding redundant large file reads.

## Added

### Integration coverage for reload with named paths

A new integration test exercises `TranscriptionParakeet` with TDT named paths: transcribe, call `reload()` with updated `parakeetConfig`, then transcribe again and verify output quality.

## [0.2.0]

### Changed
- Migrated the native addon implementation to `inference-addon-cpp` 1.x (`IModel`/`IModelCancel` + `AddonJs`/`AddonCpp`), replacing the removed legacy templated addon API
- Updated the JS/native pipeline to `createInstance` + `runJob` while preserving public transcription API behavior and output semantics
- Hardened cancel/reload/job lifecycle behavior in runtime and integration paths to match expected production behavior

### Added
- Dedicated `AddonCpp` test coverage plus expanded cancellation and lifecycle regression coverage for the addon-cpp runtime path

## [0.1.11]

### Changed
- All model types (TDT, CTC, EOU, Sortformer) now require named file paths — buffer-based `_loadModelWeights` fallback removed
- `_hasNamedPaths()` unified to cover all model types; `_hasAnyNamedPaths()` removed
- `_load()` passes all named paths (TDT, CTC, EOU, Sortformer) to C++
- `JSAdapter` parses CTC (`ctcModelPath`, `ctcModelDataPath`, `tokenizerPath`), EOU (`eouEncoderPath`, `eouDecoderPath`), and Sortformer (`sortformerPath`) path properties
- `loadTDTSessions` requires `encoderPath` and `decoderPath`, removes buffer fallback
- `loadCTCSessions` requires `ctcModelPath`, loads with C++-side temp staging for ONNX external data, reads tokenizer from `tokenizerPath`
- `loadEOUSessions` requires `eouEncoderPath` and `eouDecoderPath`, reads tokenizer from `tokenizerPath`
- `loadSortformerSessions` requires `sortformerPath`

## [0.1.10]

### Added
- CTC model support (`parakeet-ctc-0.6b`) with tokenizer.json-based vocabulary decoding
- End-of-Utterance (EOU) streaming model support (`parakeet-eou-120m-v1`) for real-time transcription
- Sortformer speaker diarization model support (`sortformer-4spk-v2`) with per-speaker labelled output
- Named file path parameters for CTC (`ctcModelPath`, `ctcModelDataPath`), EOU (`eouEncoderPath`, `eouDecoderPath`), and Sortformer (`sortformerPath`) models
- Shared `tokenizerPath` config for CTC and EOU tokenizer.json loading
- `modelType` configuration parameter (`'tdt'`, `'ctc'`, `'eou'`, `'sortformer'`) to select inference pipeline
- Integration tests for all model types (desktop and mobile)
- `nlohmann-json` vcpkg dependency for tokenizer.json parsing

### Changed
- C++ `ParakeetModel` refactored to support multiple model architectures with shared mel-spectrogram and encoder pipeline
- `_resolveFilePath` extended to map CTC/EOU/Sortformer file names to named config paths
- `_hasAnyNamedPaths()` added to detect any named path override (TDT or non-TDT)
- `_loadModelWeights` routes weight files by model type using `getRequiredModelFiles()`
- Mobile integration tests hardened with explicit `unloadWeights()` and `destroyInstance()` cleanup in `finally` blocks

### Fixed
- Tokenizer vocabulary validation rejects empty vocab after parsing
- JobEnded/Output race condition in C++ job tracker

## [0.1.9]

### Changed
- Logger type in `TranscriptionParakeetArgs` now uses `LoggerInterface` from `@qvac/logging` instead of a package-specific type, aligning with the shared logging interface used across all addons

## [0.1.7]

### Added
- Native C++ support for loading ONNX sessions directly from individual file paths (`encoderPath`, `encoderDataPath`, `decoderPath`, `vocabPath`, `preprocessorPath`)
- Encoder external data staging via temporary symlink directory, cleaned up after session creation
- Vocabulary loading directly from `vocabPath` when named paths are provided

### Changed
- `_load()` skips buffer-based `_loadModelWeights` when named paths are detected, reducing memory overhead
- `_downloadWeights()` short-circuits when named paths are provided

## [0.1.6]

### Added
- Individual named file path parameters (`encoderPath`, `encoderDataPath`, `decoderPath`, `vocabPath`, `preprocessorPath`) as alternative to `filePaths` map

### Fixed
- Removed unused `Loader` type and `Readable` import from type declarations; `loader` argument now typed as `unknown`

## [0.1.5]

### Added
- `NOTICE` file with full third-party dependency attributions
- `LICENSE` and `NOTICE` now included in the published npm package

### Changed
- S3 download script now requires `MODEL_S3_BUCKET` environment variable instead of hardcoded bucket

### Removed
- `@qvac/dl-hyperdrive` from `devDependencies` and `peerDependencies`

## [0.1.2]

### Added
- Unified `transcribe.js` script with CLI flags (`--file`, `--model`) replacing individual language scripts

### Changed
- Replaced multiple `if` status checks with `std::ranges::find` in `Addon.cpp`
- Extracted `computeFeatures()` and `runInferencePipeline()` helper functions in `ParakeetModel.cpp`
- Updated `README.md`, `QUICKSTART.md`, and `download-models-s3.sh` documentation

### Removed
- Individual language transcription scripts (`es-transcribe.js`, `fr-transcribe.js`, `hr-transcribe.js`)
