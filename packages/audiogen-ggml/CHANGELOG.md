# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `computeQualityScore` generation control: the generated audio codes are
  teacher-forced back through the LM and `stats.qualityScore` reports a
  weighted `[0, 1]` match against the request (caption/lyrics PMI plus
  metadata recall) — made for generating a batch of takes and keeping the
  best. Requires `taskType: 'text2music'`.

### Changed

- Require `speech-cpp` port revision `2026-09-02`, which adds the engine's
  teacher-forced LM quality scoring.

## [0.3.3] - 2026-09-01

### Added

- Support the full `audioCoverStrength` range for `cover-nofsq`. Values below
  `1` follow the source for that fraction of the diffusion run and finish
  freely afterwards; `0.5` starts as a cover and diverges halfway.
- Multi-Track (lego) generation: `taskType: 'lego'` with a `track` option
  (one of the 12 ACE-Step layer names) generates a new isolated instrument
  layer that follows `sourceAudio` and returns only that stem. Requires the
  base DiT model.
- Optional `guidanceScale` generation control for DiT classifier-free
  guidance; `0` (the default) picks the loaded model's preset automatically.

### Changed

- Drop CUDA from the published linux-x64 prebuild so the npm tarball stays
  under the registry size limit. `useGPU: true` uses Vulkan on Linux. CUDA
  remains opt-in at build time via `ENABLE_CUDA=ON`.

- Raise the `speech-cpp` floor to 2026-08-31, which brings in the ACE-Step
  Multi-Track (lego) task and base-model guided sampling.
- Raise the `speech-cpp` floor further to 2026-09-01#2, which brings in
  ggml-speech 2026-09-02. The CUDA backend now skips, at registration, GPUs
  whose compute capability has no compiled code in the fatbin, so a
  `useGPU: true` run on such a card (Turing and older) falls back to Vulkan
  or CPU instead of failing at the first kernel launch. The CUDA fatbin
  now carries native code for every architecture the prebuilds target —
  Turing (7.5), Ampere (8.0, 8.6), Ada (8.9), Hopper (9.0) and Blackwell
  (12.0, 12.1) — with 8.0 PTX for anything newer, so Turing is supported
  again and Blackwell no longer pays a first-use JIT. The roll also brings
  the compute-buffer OOM handling and k-quant GET_ROWS fixes, and fixes two
  multi-GPU faults on a host that mixes supported and unsupported NVIDIA
  cards: backend initialisation no longer aborts when the unsupported card
  enumerates first, and a row-split buffer no longer allocates on the
  skipped card.

## [0.3.2] - 2026-09-01

### Added

- Report why a `useGPU: true` run resolved to the CPU. `stats.gpuFallbackReason`
  carries the engine's reason code for both ACE-Step and MiniMax, with
  `AUDIOGEN_GPU_FALLBACK_REASONS` and `audiogenGpuFallbackReason()` to name it.
- Simple Mode: `simpleMode: true` treats the caption as a short
  natural-language query and the LM composes the complete request before
  synthesis — a detailed caption, full lyrics, and every metadata field left
  unset. Leave `lyrics` unset for LM-written vocals or pass `'[Instrumental]'`
  for an instrumental song.
- `normalizeLoudness` generation control (default `true`): percentile loudness
  normalization of the generated audio matching the reference implementation;
  audio edits are never normalized.

### Changed

- Require `speech-cpp` port revision `2026-09-01`, which adds the engine's
  Simple Mode pipeline, LM progress and cancellation for both phases, and the
  output loudness normalization.

### Fixed

- Restore mobile (Android / iOS) support. The generated `index.js` carried
  `${exports.…}` interpolations that desynchronise `bare-module-lexer`, so
  `bare-pack` stopped discovering imports partway through the file and left
  `binding.js` out of the app bundle. Every on-device model load then failed
  with `MODULE_NOT_FOUND: Cannot find module './binding'`, even though the
  file ships in the tarball. The engine validation message and the registry
  path in `models.js` are now assembled without that construct, and package
  tests assert every relative `require` in the generated scripts stays
  visible to the bundler and that the construct never reappears.

## [0.3.1] - 2026-08-28

### Added

- CUDA GPU acceleration on linux x64: the prebuild now builds with
  `ENABLE_CUDA=ON` and bundles the CUDA backend alongside Vulkan and the
  per-arch CPU variants as runtime-loaded modules; `useGPU: true` prefers
  CUDA on NVIDIA hosts (ACE-Step and MiniMax-Music3). CUDA engages where the
  NVIDIA driver and CUDA 13 runtime libraries (cudart, cuBLAS) are present;
  on every other host the CUDA module is skipped and the addon behaves as
  before (Vulkan or CPU).
- Export `AUDIOGEN_BACKEND_NAMES`, `audiogenBackendName()` and the
  `AudiogenBackendName` type, so a consumer can name a `stats.backendId`
  without copying the code table out of this README.

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
  Pending compute state is unwound after the failure.

## [0.3.0] - 2026-08-27

### Added

- Add desktop CPU support for MiniMax-Music3 through local LM and synthesis
  GGUF files, with engine-specific validation, progress, cancellation, runtime
  statistics, and a skippable model-backed integration regression.
- Add desktop GPU support for MiniMax-Music3 via `config.useGPU`: the model
  pair runs on the first usable ggml GPU backend (CUDA, Vulkan, Metal) with
  CPU fallback, and `stats.backendDevice`/`backendId` report the backend
  actually in use.
- Opt-in CUDA GPU backend on Linux / Windows (NVIDIA). The new `ENABLE_CUDA`
  CMake option appends the `cuda` manifest feature, which pulls
  `speech-cpp[cuda]` and hence `ggml-speech[cuda]`. Off by default because it
  needs `nvcc` on the build host; at runtime only the NVIDIA driver is needed.
  CUDA is additive next to Vulkan, and the engine's validated-GPU preference
  selects CUDA when both backends are compiled in. Apple and Android are
  excluded, matching `speech-cpp`'s own `supports` expression, so every
  existing build resolves exactly as before.

### Changed

- Renamed engine repository references from `qvac-ext-lib-whisper.cpp` to
  `qvac-fabric-speech.cpp` in the package documentation, following the
  upstream repository rename. Old GitHub links keep working via redirect.

- Raise the `speech-cpp` floor to 2026-08-26, which brings in ggml-speech
  2026-08-26. This is the engine half of the MiniMax-Music3 GPU support above:
  MiniMax-Music3 now runs on Vulkan, and the Vulkan `im2col_3d` path handles
  work-group counts past the y-dimension limit. ACE-Step Vulkan generation is
  over 2x faster on AMD Strix Halo (RADV) through tiled `im2col`/`col2im`
  pipelines and a large-tile transpose copy, and CUDA transposed copies now
  cover every type and stay off strided destinations.
- On CUDA the ACE-Step language model now runs on the GPU instead of the CPU,
  by raising the `speech-cpp` floor further to 2026-08-26#1: the bundled ggml
  computes explicit-f32-precision matmuls in true f32 on CUDA, which removes
  the NaN risk for the LM's large activations and lifts its CPU-only
  placement.

### Fixed

- MiniMax-Music3 produced tonal noise instead of music, and a cancellation
  issued right at generation start could stall until the first progress
  event. Both are fixed by requiring `speech-cpp` `2026-08-24#2`.
- `cancel()` no longer hangs forever when the job it targets fails before
  the native engine starts; it now settles as soon as the run settles.
- Expose `binding.js` through the package `exports` map
  (`@qvac/audiogen-ggml/binding.js`), so mobile bundlers that resolve the
  native binding through exports can load the addon.

## [0.2.4] - 2026-08-20

### Changed

- Keep `@qvac/registry-client` as a `^0.6.1` development dependency for registry
  downloads. It is no longer an optional peer, so consumer installs are not
  asked to satisfy a registry-client peer range.

### Added

- Optional `augmentCaptionWithMetadata` generation control. When enabled,
  ACE-Step enriches its internal conditioning caption with BPM/tempo guidance,
  time signature, and key while preserving the original user caption in result
  metadata. The option defaults to `false`.
- Ordered ACE-Step audio editing through `gen.edit(source)`. Operations run in
  chain order and can be mixed or repeated. The source is interleaved stereo PCM
  at 48 kHz (`Float32Array` samples in `[-1, 1]`, or addon-output `Int16Array`).
- FlowEdit (`flowEdit()` / chained `.edit()`), turbo DiT only (`turbo-q4`,
  `turbo-q8`; `sft` is rejected before native dispatch):
  - `from` / `to`: current and target prompts (`caption`, optional `lyrics`;
    lyrics default to `[Instrumental]`)
  - `nMin` / `nMax`: active diffusion window in `[0, 1]` (defaults `0` / `1`)
  - `nAvg`: forward-noise samples averaged per active step (default `1`,
    minimum `1`)
- Repaint (`repaint()`):
  - `caption` / optional `lyrics` (lyrics default to `[Instrumental]`)
  - `start`: region start in seconds (required, `>= 0`, inside the source)
  - `end`: region end in seconds; omit to repaint through the source end
  - the selected range must stay inside the source duration and span at least
    one latent frame (`1/25` s)
  - `mode`: `conservative` | `balanced` | `aggressive` (default `balanced`)
  - `strength`: balanced-mode preservation in `[0, 1]` (default `0.5`)
- `run({ seed })` on the edit session seeds the first operation; each later
  operation uses `seed + index`.

## [0.2.3] - 2026-08-18

### Changed

- Raise the `speech-cpp` floor to 2026-08-18, which brings in ggml-speech
  2026-08-18. The update prevents unsupported wide OpenCL GEMV workgroups on
  Adreno devices and hardens padded DIAG_MASK_INF launches and diagnostics.

### Fixed

- Declare `bare-process` as a runtime dependency for the published benchmark
  runner and its shipped utilities.

## [0.2.2] - 2026-08-17

### Changed

- Raise the `speech-cpp` floor to 2026-08-17, which brings in
  ggml-speech 2026-08-17. The engine sources for this package are unchanged; the
  ggml update fixes an uncatchable abort in the OpenCL elementwise ops on a
  non-contiguous input and speeds up pad, small-M matmul and argmax dispatches
  on Adreno.

## [0.2.1] - 2026-08-14

### Breaking

- Treat `destroy()` as terminal. Replace `await gen.destroy(); await gen.load()`
  with a newly constructed `AudioGen` instance before calling `load()`.
- Remove internal integration tests, mobile tests, and test utilities from the
  published package.

### Added

- RTF (Real-Time Factor) benchmark for the ACE-Step engine, measuring
  generation time against rendered audio duration, plus cold-path latency,
  model load time and process RSS (average, peak, reclaimed after unload).
  Renders use a fixed seed and caption corpus so only the hardware varies.
- `npm run test:benchmark:rtf` benchmarks one (DiT variant, GPU) combination;
  `npm run test:benchmark:rtf:matrix` sweeps several in one process and keeps
  going when an entry fails. Both are configured through
  `QVAC_AUDIOGEN_GGML_BENCHMARK_*` environment variables.
- The same measurement runs on-device as `testRtfBenchmark`, reporting through
  the canonical `[PERF_REPORT_START]` log markers. Desktop and mobile share one
  implementation so their numbers stay comparable.
- `npm run download-models:registry:all` fetches every DiT variant, which a
  full sweep needs.
- `benchmarks/RTF-BENCHMARKS.md` documents the metrics and how to run a sweep;
  `benchmarks/manual-results/` accepts hand-authored records for backends CI
  cannot reach (CUDA, OpenCL).
- `@qvac/audiogen-ggml/test/benchmark-runner` subpath export, so the on-device
  harness can reach the shared benchmark implementation.
- Shared validation of a benchmark result: a non-positive RTF, a missing run, a
  run that rendered no audio, implausible memory or a mean RTF above
  `QVAC_AUDIOGEN_GGML_BENCHMARK_RTF_UPPER_BOUND` now throws before any artifact
  or log record is emitted, on both the desktop and the on-device lane.
- Reports carry the backend that actually executed. A GPU request that fell back
  to CPU is reported as CPU work, with the request preserved as
  `requested_backend` / `requested_execution_provider`.
- A `run-benchmarks` label makes a pull request run the benchmark matrix and
  render the findings table on the run summary. The table was previously
  reachable only from the manual sweep workflow.
- ACE-Step appears in the weekly cross-addon performance report. The aggregator
  can now fetch its own inputs with `--workflow` / `--runs`, folding the last six
  sweeps into one table instead of only reading a directory staged by the run it
  belongs to. Each row keeps the run id of the sweep it came from.
- Expose ACE-Step reference/source audio and cover task controls through the
  JavaScript API (`referenceAudio`, `sourceAudio`, `taskType`,
  `audioCoverStrength`, `coverNoiseStrength`) and forward them to audiogen-cpp.
- Validate ACE-Step GPU generation on Android with a strict mobile smoke test:
  `useGPU: true` must resolve to Vulkan or OpenCL and produce non-silent 48 kHz
  stereo audio. This covers Mali and Adreno devices without accepting a CPU
  fallback.
- Expose ACE-Step LM sampling controls, Haar DCW parameters, and optional frozen
  semantic codes through the JavaScript API for reproducible quality comparisons.
- Export structured AudioGen errors with a CommonJS-compatible error runtime and
  serialize overlapping runs through response settlement.
- Ship the model downloader as `qvac-audiogen-download-models`.

### Changed

- Bump `audiogen-cpp` to `2026-08-11` so native builds pick up cover-nofsq and
  reference-audio support from the official registry.
- Bump `audiogen-cpp` to `2026-08-10`, enabling official sampler-side Haar DCW
  by default and using the validated LM decoding policy on Metal and Vulkan.
- Cancel and settle active responses before unload or destroy, and reject native
  admission failures consistently.
- Exclude internal integration and mobile test utilities from the published
  package and include the downloader runtime dependency.

### Fixed

- On-device benchmark rows now honour their configuration. The mobile CI pushes
  the per-row settings to the device as a `qvacPerfConfig.txt` file, but nothing
  read it, so every Device Farm row silently measured the default `turbo-q4` on
  CPU regardless of the variant and provider it was scheduled for.
- A failed engine unload no longer reports the whole footprint as reclaimed
  memory. Reclaim is reported as unavailable and the engine is left undestroyed
  so the caller's cleanup still runs.
- A GPU request that fell back to CPU no longer disappears from the findings
  table. It keyed identically to a genuine CPU run on the same device and
  variant, so one of the two was dropped as a duplicate and the survivor could be
  the fallback wearing a plain `cpu` label. Rows now key on the requested backend
  as well and render as `cpu (requested vulkan)`.
- Mobile rows report the GitHub run id in the `Run` column. They previously
  carried the shared extractor's per-workflow `run_number`, which sat in the same
  column as the desktop run ids and could not be resolved to a run.

## [0.2.0] - 2026-08-06

### Changed

- Align `@qvac/infer-base` and `qvac-lib-inference-addon-cpp` dependency floors
  with the shared addon runtime validated across the live addon consumer set.

### Pull Requests

- [#3567](https://github.com/tetherto/qvac/pull/3567) - chore:
  test addon-cpp 1.3.3 across consumers

## [0.1.1] - 2026-08-03

### Changed

- Update `ggml-speech` dependency version to align with other packages that also depend on it.

## [0.1.0] - 2026-07-30

### Added

- Initial `@qvac/audiogen-ggml`: text-to-music generation addon (ggml backend)
  wrapping the ACE-Step engine from `audiogen-cpp`. Text prompt in, stereo
  48 kHz audio out.
- `AudioGen` class implementing the shared `@qvac/infer-base` contract —
  `load()`, `run(caption, opts)` returning a `QvacResponse` that streams
  progress ticks + the interleaved-Int16 PCM chunk and resolves with the run
  stats (`audioDurationMs`, `totalTimeMs`, `realTimeFactor`), plus `cancel()` /
  `unload()` / `destroy()`.
- Run stats report the *resolved* backend via `backendDevice` (0 = CPU, 1 = GPU)
  and `backendId` (0 = CPU, 1 = Metal, 2 = CUDA, 3 = Vulkan, 4 = OpenCL,
  99 = other), matching `@qvac/tts-ggml`. The GPU integration smoke asserts on
  them, so a `useGPU: true` run that silently falls back to the CPU now fails
  instead of passing; `QVAC_AUDIOGEN_GPU_SMOKE_RELAX=1` downgrades that to a
  warning. The smoke also checks the rendered audio is non-silent (peak/RMS) and
  close to the requested duration.
- Full ACE-Step pipeline (text-encoder → LM → DiT → Oobleck VAE) with optional
  `lyrics`, `vocalLanguage`, `bpm`, `keyscale`, `timesignature`, `duration` and
  `seed`.
- DiT selection: `models.js` manifest with the fixed text-encoder / LM / VAE
  stages plus a `ditVariant` enum (`turbo-q4` | `turbo-q8` | `sft`), and helpers
  to resolve registry paths / sources. `inferenceSteps` / `shift` auto-tune per
  DiT architecture (turbo vs sft) when unset.
- Optional GPU acceleration (Metal / Vulkan) via `useGPU`, with CPU
  fallback.
- Output peak-normalized to -0.9 dBFS before int16 conversion to avoid clipping.
- Multi-format output encoding via `AudioGen.encode(pcm, formats, opts)`: `pcm`
  and `wav` are dependency-free (pure JS); `flac`, `alac`, `aiff`, `caf`, `m4a`,
  `aac`, `opus`, `ogg`, `ac3`, `wma` and `mp2` are encoded with `bare-ffmpeg`
  (every encoder/muxer verified present in the vendored build). MP3 is not
  offered — that build ships no MP3 encoder. Accepts a single format or an array
  (one file per format, input order); each result carries `{ format, data,
  extension, mimeType }`. `OUTPUT_FORMATS` exports the allowed list.
