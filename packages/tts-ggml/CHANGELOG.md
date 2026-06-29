# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Chatterbox now synthesizes correctly on both ARM CPU and the ARM Mali Vulkan
  GPU.** Bumps the `tts-cpp` pin to `2026-06-26` (`qvac-ext-lib-whisper.cpp`
  master `586268bf`, PR #67), consumed from `qvac-registry-vcpkg` (#214), which
  in turn requires `ggml-speech 2026-06-26` (`qvac-ext-ggml` speech `f5727c32`,
  PR #30); the `default-registry` baseline advances to `162f8f7c` so the new pins
  resolve.
  - **GPU (ARM Mali / Vulkan — Google Tensor / Pixel):** the CFM estimator's f32
    `ggml_flash_attn_ext` miscomputed on Mali, blowing the f0 predictor up to NaN
    and collapsing the audio into a clean ~1.3 s followed by a buzzy "blank +
    beeps" break. Chatterbox now runs on Mali via an `is_arm_mali`-gated unfused
    CFM attention (`soft_max` + separate-V matmul, numerically equivalent and
    still on the GPU). Zero change off ARM Mali; CPU output byte-identical.
  - **CPU (ARM SVE — Google Tensor / Pixel):** the SVE leftover-tail of
    `ggml_vec_dot_f32` dropped the main loop's partial sums on inactive lanes
    (`svmad_f32_m` → `svmla_f32_m`), biasing the HiFT `conv_transpose_1d` inner
    dot and producing a constant ~12 kHz Nyquist tone. NEON/x86/RISC-V and all
    non-CPU backends are byte-identical.

## [0.3.6] - 2026-06-25

### Fixed

- **Chatterbox Metal GPU crash on the multilingual model — default KV-cache
  dtype changed from `q8_0` to `f16`.** With the `q8_0` KV cache (the default
  since 0.3.2, QVAC-19557), running the **multilingual** Chatterbox model on a
  **Metal GPU** hard-aborted mid-synthesis with
  `GGML_ABORT("unsupported op 'CONT'")`. The multilingual step graph
  (`eval_step_mtl`, B=2 cond+uncond batched path) issues a `CONT` on the KV
  cache, and the ggml-speech Metal backend only implements a `q8_0`-source
  `CONT` to `f32`/`f16` — not `q8_0`→`q8_0` — so the op fails
  `ggml_metal_device_supports_op` and aborts. The EN **Turbo** model and the
  **CPU** backend were unaffected (different graph / backend supports the op),
  which is why ≤0.2.5 worked on GPU and 0.3.2+ regressed. `f16` (~50% of f32,
  vs `q8_0`'s ~27%) is now the safe cross-backend default; `q8_0` remains
  available opt-in via `kvCacheType: 'q8_0'` for memory-constrained CPU/CUDA
  hosts that implement the op. A proper backend-aware fix (extend
  `chatterbox_resolve_kv_type` to probe `CONT` support, not just flash-attn)
  belongs in `qvac-ext-lib-whisper.cpp` and would let Metal keep `q8_0` storage.

## [0.3.5] - 2026-06-24

### Changed

- **Bump the `tts-cpp` pin to `2026-06-24`** (`qvac-ext-lib-whisper.cpp` master
  `46921668`, PR #65), consumed from `qvac-registry-vcpkg`. Brings QVAC-19557
  **S3TokenizerV2 host-mirror elimination**: the Chatterbox voice-conditioning
  bake no longer holds the ~458 MB S3Tokenizer encoder weights in a host
  `std::vector` mirror *and* the backend (Metal) weight buffer simultaneously —
  `build_encoder_ctx` now streams each encoder tensor straight from the GGUF
  into its backend tensor (8 MiB chunks, no host mirror). This drops the
  ~900 MB dual-residency that dominated the Chatterbox first-`synthesize()`
  peak; on-device (iPhone 17 Pro Max) the first-test peak falls from ~3184 MB to
  ~2772 MB (under the ~3 GB iOS jetsam budget), warm synthesis unchanged, and
  the produced audio is bit-identical (same tensor names/shapes/dtypes). The
  `default-registry` baseline advances to `1130cabb` so the new pin resolves.

## [0.3.4] - 2026-06-23

### Added

- **Chatterbox speaking-rate control (`speed`) (QVAC-21119).** New optional
  `speed` config for the Chatterbox engine — a duration multiplier mirroring
  Supertonic's `speed` (`< 1` slower, `> 1` faster), bounded to `[0.25, 4.0]`.
  Chatterbox's engine exposes no native rate knob (its S3 speech tokens run at
  a fixed 25 Hz and the utterance duration is emergent from the autoregressive
  T3), so the addon applies it as a pitch-preserving WSOLA time-stretch on the
  24 kHz PCM — functionally equivalent to ffmpeg's `atempo`, not a pitch shift.
  Opt-in and backward compatible: when unset (or `1.0`) the raw model output is
  left unchanged — no default slowdown. Works in both batch and native
  streaming (one stretcher threads the overlap-add state across chunks for
  seam-free output, with `O(chunk + window)` memory). Plumbed through
  `ChatterboxConfig::speed`, `JSAdapter`, and `_buildChatterboxParams`
  (mirroring Supertonic). New `examples/chatterbox-adjust-speed.js` (+
  `example:chatterbox-adjust-speed` npm script), C++ WSOLA unit tests, and a JS
  integration test.

### Fixed

- **Chunk-streaming saturation/clipping and per-chunk loudness "wobble" on the
  Chatterbox Multilingual engine (QVAC-21118).** A low `cfmSteps` /
  `streamCfmSteps` (1–2) under-integrated the model's standard 10-step CFM in
  the chunk-streaming path, producing near-full-scale output (~99%, RMS 4–9×
  hotter than batch) with a collapsing tail. The engine now floors the
  streaming CFM step count to the model's `n_timesteps` for standard-CFM
  models; Turbo's meanflow 2-step sampler and the batch step count are
  unaffected. Consumes `tts-cpp` `2026-06-22` (`qvac-ext-lib-whisper.cpp`
  PR #62).

## Pull Requests

- [#2782](https://github.com/tetherto/qvac/pull/2782) - QVAC-21119: add Chatterbox speaking-rate (`speed`) control
- [#2777](https://github.com/tetherto/qvac/pull/2777) - QVAC-21118: consume tts-cpp 2026-06-22 (chunk-streaming CFM-step floor)

## [0.3.3] - 2026-06-22

### Changed

- Windows prebuilds now link the static Visual C++ runtime (`/MT`) instead of
  importing `vcruntime140.dll`, `msvcp140.dll`, or UCRT DLLs from the MSVC
  redistributable. Shared monorepo `vcpkg-overlays/triplets/{x64,arm64}-windows.cmake`
  build dependencies with a static CRT; addon CMake no longer links `msvcrt.lib`,
  which had forced the dynamic runtime. Per-package vcpkg overlays were
  consolidated into the shared `vcpkg-overlays/` tree. No public API change.

## Pull Requests

- [#2722](https://github.com/tetherto/qvac/pull/2722) - QVAC-21100: Switch to static C/C++ windows runtimes

## [0.3.2] - 2026-06-19

### Added

- **Android GPU for Supertonic + Chatterbox (QVAC-20557).** Remove the `#ifdef __ANDROID__`
  guards in `SupertonicModel`/`ChatterboxModel` that forced `useGPU=false`; `useGPU` now flows
  to `tts-cpp` (bumped to registry `2026-06-18` = `b95ad447`), which picks the GPU backend per
  its per-vendor allowlist — Supertonic on Adreno (OpenCL) / Xclipse + Mali (Vulkan); Chatterbox
  on Adreno/Xclipse, with Mali declined by policy (`allow_arm_mali=false`) and surfaced via the
  new `gpuUnsupported` runtime stat. The `default-registry` baseline advances to `6fe4e2b` so the
  new version resolves. Android gpu-smoke skips dropped (Supertonic strict; Chatterbox accepts a
  flagged Mali→CPU fallback).

### Fixed

- **QVAC-19557: Chatterbox iOS peak-memory OOM — cap the T3 context at
  4096 and store the KV cache as q8_0 by default.** tts-cpp allocates
  the T3 KV cache up-front at the GGUF's full `n_ctx`; the Turbo GGUF
  ships `n_ctx=8196`, which costs ~1.6 GB of f32 KV
  (`n_embd(1024) × n_layer(24) × 8196 × 4 B × 2`) and pushed the iOS
  QVAC SDK test process to a ~3.1 GB peak footprint (jetsam kill — the
  `tts-chatterbox-*` e2e variants are currently skipped on iOS Device
  Farm for exactly this).  The addon now passes
  `EngineOptions::n_ctx = 4096` and `kv_cache_type = "q8_0"` (~210 MB
  of KV for ≈160 s of generated audio per `synthesize()` call) unless
  the host overrides them via the new `nCtx` / `kvCacheType`
  constructor options.  `nCtx: 0` restores the uncapped context;
  `kvCacheType: "f32"` restores the bit-exact pre-quantisation
  behaviour; negative `nCtx` and unknown `kvCacheType` values are
  rejected at construction.  Upstream validation
  (qvac-ext-lib-whisper.cpp#43): Turbo greedy token sequences are
  byte-identical across f32/f16/q8_0 on CPU and Metal, and Metal
  decode is 20-30% faster from the KV bandwidth saving.

### Changed

- **`tts-cpp` pinned to `2026-06-19`** (`qvac-ext-lib-whisper.cpp` PR #43 on
  top of master `b95ad447`) for `EngineOptions::kv_cache_type` and the streamed
  (no host-staging) chatterbox GGUF loads. The Android `GGML_BACKEND_DL` symbol
  routing (`ggml_backend_is_cpu` / `ggml_get_type_traits_cpu` → backend registry
  shim + `ggml_quantize_chunk`) now comes from the `b95ad447` base via QVAC-20557
  (PR #54), so this package no longer carries that fix itself.

## [0.3.1] - 2026-06-18

### Fixed

- **End-of-speech robustness for the Chatterbox multilingual engine
  (QVAC-20616).** Fixes the model emitting up to ~20s of random tokens after
  the intended text finishes. Consumes the new `tts-cpp` stop logic: an
  alignment-based EOS analyzer (ports the reference `AlignmentStreamAnalyzer`
  cross-attention signal, extracted from the GGML graph via an in-graph
  attention probe) layered with a heuristic stop controller (EOS confidence,
  n-gram repetition, text-length budget) and per-language calibration. An
  anti-early-truncation `suppress_eos` path keeps very short inputs from being
  clipped. Validated end-to-end on desktop (CPU + Vulkan/RTX) and on real
  mobile GPUs (Android OpenCL + iOS Metal via AWS Device Farm), plus a
  round-trip ASR regression gate (synthesize → Whisper transcribe → compare).

### Added

- Internal RTF + streaming benchmark suite for the Chatterbox and Supertonic GGML engines (`test/benchmark/rtf-benchmark.test.js`, `test/benchmark/streaming-benchmark.test.js`, matrix runner, `scripts/perf-report/aggregate-tts-ggml-rtf.js`), runnable via the `Benchmark RTF (TTS GGML)` GitHub Actions workflow on the `qvac-*-gpu` self-hosted runners (CPU + Vulkan). CI-only; not shipped with the npm package.
- Mobile (Android / iOS) RTF + streaming benchmark leg for the `Benchmark RTF (TTS GGML)` workflow via AWS Device Farm, opt-in through the `include_mobile` dispatch input. CI-only; not shipped with the npm package.
- RTF benchmark reports now surface the desktop GPU hardware name (QVAC-20499). `test/benchmark/rtf-benchmark.test.js` drives the shared performance reporter's `detectDevice()` (via `bare-subprocess`: nvidia-smi / vulkaninfo / system_profiler) to populate `device.gpu` / `device.cpu` in the canonical report and `labels.gpuModel` in the per-config JSON; `scripts/perf-report/aggregate-tts-ggml-rtf.js` renders a `GPU Model` column. Mobile leaves `device.gpu` null (device name is the proxy). CI-only.

### Changed

- Bump the `tts-cpp` pin to `2026-06-18` (`qvac-ext-lib-whisper.cpp` master
  `b95ad447`), consumed straight from `qvac-registry-vcpkg`. Carries QVAC-20616
  (the EOS fix above, PR #53) and QVAC-20557 Supertonic Android GPU (PR #54:
  Adreno OpenCL + Xclipse/Mali Vulkan). The latter reroutes the direct
  Supertonic CPU-backend calls (`ggml_backend_is_cpu` /
  `ggml_get_type_traits_cpu`) to ggml-base + a registry shim — the upstream
  successor to the interim `f7d4d6c` overlay that 0.3.0 carried — so the addon
  `dlopen`s cleanly on Android with no package-local overlay port.

## [0.3.0] - 2026-06-11

### Added

- **Supertonic 3 (31-language) support (QVAC-19305).** Brings the v3 Supertonic
  model to the addon: `index.js` recognises the Supertonic 3 GGUFs in the
  `modelDir` auto-detect / path-resolve paths (the v3 GGUFs are published per
  quant tier with the quant in the filename, e.g. `supertonic3-f16.gguf` /
  `supertonic3-q8_0.gguf`, so the lookup matches any `supertonic3[-<quant>].gguf`).
  The v3 model/inference code lands in `tts-cpp` (`qvac-ext-lib-whisper.cpp` PR
  #42, `master` @ `24eeb028`); `vcpkg.json` bumps the `tts-cpp` pin to
  `2026-06-12`.
- **Supertonic 3 GGUF tooling.** `convert-supertonic2-to-gguf.py --arch
  supertonic3` (text-encoder ConvNeXt dilations + vector-estimator CFG
  numerical-parity fixes; pipeline parity < 2e-4 across en/ko/es/pt/fr) and
  `requantize-gguf.py` q8_0 / q4_0 block-quant support (ConvNeXt pointwise convs
  squeezed to 2-D and re-expanded at load via `supertonic.pwconv_squeezed`,
  fixing the old q4_0 SIGBUS). These are the converters used to produce the
  GGUFs published to the registry.
- **Registry-hosted Supertonic 3 models.** All four tiers are published on the
  QVAC model registry (f16 / f32 @ `2026-06-10`, QVAC-20568; q8_0 / q4_0 @
  `2026-06-15`, QVAC-20686). `download-tts-ggml-models.js` +
  `test/utils/downloadModel.js` fetch every tier from S3 (per-tier build dates).
- **Supertonic 3 integration tests** (`test/integration/supertonic3-quant.test.js`):
  sweep f16 / f32 / q8_0 / q4_0 across the five inherited (en/ko/es/pt/fr) plus
  the new v3-only (de/it/nl) languages; assert load + run + 44.1 kHz output. A
  tier that can't be fetched fails the run (every tier is published on the
  registry). Mobile integration auto-test wiring added.
- **Supertonic GPU support (re-land of QVAC-19255, reverted in 0.2.2).**
  Caller GPU intent (`useGPU` / `nGpuLayers`) is honored again for the
  Supertonic engine on GPU-capable hosts (Metal on Apple, Vulkan/CUDA on
  desktop), matching Chatterbox. The `SupertonicModel::validateConfig` /
  `index.js` "CPU only today" rejection is removed; the cross-field conflict
  check (`useGPU=true` + `nGpuLayers=0`, or vice versa) is preserved.

### Changed

- Resolve `tts-cpp` entirely from the official `tetherto/qvac-registry-vcpkg`
  registry: drop the package-local `ports/tts-cpp` overlay (and the
  `overlay-ports` entry in `vcpkg-configuration.json`) used during development
  as an interim measure, and bump the `default-registry` baseline to `e55f10fb`
  (`tts-cpp` `2026-06-12`, `ggml-speech` `2026-06-15`). The baseline preserves
  the `ggml-speech` Metal residency-set teardown fix that the overlay previously
  pinned (#2645).
- Bumped the `@qvac/infer-base` runtime dependency from `^0.4.0` to `^0.6.0` ([#2636](https://github.com/tetherto/qvac/pull/2636)).

### Notes

- **Android stays CPU-only for Supertonic.** The `#ifdef __ANDROID__`
  force-off in `SupertonicModel::loadLocked` is kept, so `useGPU=true` on
  Android transparently falls back to CPU: Adreno Vulkan/OpenCL `ggml` graph
  compute still aborts (same family as the parakeet Adreno crash). The GPU
  smoke test skips Supertonic on Android accordingly.

## [0.2.2] - 2026-06-09

### Fixed

- **Android: revert the `tts-cpp` `2026-06-05` bump (introduced in 0.2.1)
  that crashed the addon at `dlopen` during bootstrap, taking down every
  Android e2e run.** `tts-cpp` `2026-06-05` pins upstream
  `qvac-ext-lib-whisper.cpp@128dae42` (the QVAC-19254 "sched + cpu_backend
  refactor"), which added direct `ggml_backend_is_cpu` /
  `ggml_get_type_traits_cpu` calls inside the statically-linked `tts-cpp`
  library. On Android the shared `ggml-speech` port builds the CPU backend
  as runtime-`dlopen`'d per-microarch MODULE `.so` variants
  (`GGML_CPU_ALL_VARIANTS=ON` + `GGML_BACKEND_DL=ON`; no static CPU
  archive), so those two symbols are left `UND` in
  `libqvac__tts-ggml.*.so`'s dynamic symbol table with no `DT_NEEDED` able
  to resolve them — the CPU variant libraries are only `dlopen`'d lazily
  inside Engine construction, long after Bare loads the addon. Bare's
  resolver therefore fails to register the addon
  (`ADDON_NOT_FOUND: linked:libqvac__tts-ggml.*.so` / `dlopen failed`) and
  the unhandled rejection aborts the process (SIGABRT) ~1 s into
  bootstrap. iOS and desktop (Linux/macOS/Windows) statically link the CPU
  backend and were never affected. Pin `tts-cpp` back to `2026-06-03#1`
  (the last-known-good revision, the one 0.2.0 shipped) so the Android
  addon loads cleanly again.

### Reverted

- Reverts the 0.2.1 Supertonic GPU enablement (QVAC-19255, #2473) in full:
  the `tts-cpp` pin, the `SupertonicModel.cpp` / `index.js` `useGPU` /
  `nGpuLayers` gate removals, the flipped C++ unit tests and
  `gpu-smoke.test.js` integration test, and the README / `index.d.ts` /
  examples docs. With `tts-cpp` back at `2026-06-03#1` Supertonic is
  CPU-only again, so the rejection gates and the CPU-only contract are
  restored to keep the package internally consistent. The Supertonic GPU
  work should re-land once the Android CPU-backend linkage is fixed
  upstream (QVAC-19254 follow-up against `tts-cpp` / `ggml-speech`, e.g.
  by statically linking `ggml-cpu` into the addon on Android the way
  desktop/iOS already do).

## [0.2.1] - 2026-06-05 — superseded by 0.2.2

> **Broken on Android.** The `tts-cpp` `2026-06-05` dependency this release
> introduced crashes the addon at load time (`dlopen` failure → SIGABRT)
> on Android ARM64; iOS and desktop are unaffected. Reverted in 0.2.2 (see
> above). The entry below describes what 0.2.1 attempted and is retained
> for history.

### Added

- **Supertonic now supports GPU execution.** Consumes `tts-cpp`
  `2026-06-05`, which brings the QVAC-18605 Supertonic Vulkan/Metal
  optimisations (rounds 1-13, ~34× realtime on Apple M-series Metal)
  and the QVAC-19254 sched + cpu_backend refactor for Adreno OpenCL.
  Caller intent (`useGPU` / `nGpuLayers`) is now honoured for Supertonic
  the same way it is for Chatterbox; backend selection follows
  tts-cpp's `init_gpu_backend` tier policy (Adreno 700+ → OpenCL,
  otherwise Vulkan/Metal/CUDA via the registry walk, otherwise CPU).

### Changed

- Removed the validateConfig hard-throw on `useGPU=true` /
  `nGpuLayers != 0` for Supertonic in both `SupertonicModel.cpp` and
  `index.js`. The conflicting-pair check (`useGPU=true` + `nGpuLayers=0`
  or vice versa) is preserved.
- Removed the Android force-off block in `SupertonicModel::loadLocked`.
  Android GPU selection is delegated to tts-cpp's `init_gpu_backend`
  tier policy (Qualcomm Adreno allowlist; Mali / non-Adreno skipped).
- Flipped the C++ unit tests that previously expected GPU rejection
  (`test_supertonic_config.cpp::UseGpuTrueRejectedWithExplanation`,
  `NGpuLayersGreaterThanZeroRejected`) into acceptance tests; added a
  new test asserting the cross-field conflict check is still enforced.
- Flipped the Supertonic entry in `test/integration/gpu-smoke.test.js`
  from "rejected at constructor" to "must engage GPU backend on
  GPU-capable platforms", mirroring the Chatterbox smoke contract.

## [0.2.0] - 2026-06-02

### Changed

- Bumped the `qvac-lib-inference-addon-cpp` vcpkg dependency to `1.2.1`.

## [0.1.4]

### Fixed

- Consume `tts-cpp` `2026-05-20#2`, which keeps BLAS enabled only on
  macOS and disables host BLAS/OpenBLAS auto-linking everywhere else.

## [0.1.3]

### Fixed

- Consume `tts-cpp` `2026-05-20#1`, which disables host BLAS/OpenBLAS
  auto-linking for Linux prebuilds.

## [0.1.2]

### Changed

- **`useGPU` now defaults to `false` for Chatterbox** (was `true` in 0.1.1
  and earlier). Opt in with `config: { useGPU: true }` on GPU-capable
  hosts. The auto-enable was flipped because Android dynamic-backend
  builds OOM on small-RAM devices (e.g. 8 GB Galaxy S23 FE) when the
  Vulkan / OpenCL backend mirrors ~1 GB of f16 `chatterbox-s3gen.gguf`
  into GPU memory on top of the mmap'd CPU copy, tripping the Android
  low-memory killer (`lmkd` SIGKILL). Hosts on capable GPUs (Apple
  Silicon, CUDA desktops, Adreno 700+ phones with enough free RAM)
  should pass `config: { useGPU: true }` explicitly. Supertonic stays
  CPU-only.
- **Android dynamic backend selection** (consumed via tts-cpp
  2026-05-20): the addon now ships `prebuilds/android-arm64/qvac__tts-ggml/`
  with per-arch `libqvac-speech-ggml-cpu-android_armv*_*.so` files plus
  `libqvac-speech-ggml-{vulkan,opencl}.so`, picked up at runtime via
  the new `BACKENDS_SUBDIR` join + the registry walk in
  `tts_cpp::detail::init_gpu_backend()` (Adreno 700+ → OpenCL, every
  other GPU → Vulkan/Metal/CUDA). New `backendsDir` + `openclCacheDir`
  options on the JS surface let hosts point at a non-default prebuilds
  root or persist the OpenCL program-binary cache.

### Fixed

- Metal allocation failure on iOS leading to crash after package was
  unloaded and loaded several times.

## [0.1.1]

### Fixed

- Fixed two issues when loading chatterbox on iOS:
  - gguf_init_from_file race: bake_voice_conditioning() now runs before s3gen_preload_thread is spawned, so the two gguf_init_from_file calls no longer race against ggml's process-global state (previously aborted in ggml_abort on iOS).
  - Metal shared-buffer-type init race when unload is called immediately after load

## [0.1.0]

Initial release of `@qvac/tts-ggml`, a GGML-backed TTS addon wrapping the
`tts-cpp` library. Exposes both `tts_cpp::chatterbox::Engine` and
`tts_cpp::supertonic::Engine` behind a single engine-agnostic JS surface,
intended as a substitute for `@qvac/tts-onnx`.

### Added

- **Chatterbox engine** (English + multilingual via `chatterbox-t3-mtl.gguf` /
  `chatterbox-s3gen-mtl.gguf`). 24 kHz native output. Supports voice cloning
  from a reference wav and baked voice-conditioning tensors via `voiceDir` /
  `voicesDir`.
- **Supertonic engine** (single-file `supertonic.gguf`). 44.1 kHz native
  output. Voice selection via `voice` / `voiceName` (e.g. `'F1'`, `'M1'`).
- **Engine auto-detection** from `files` (chatterbox-\* gguf vs supertonic.gguf),
  with explicit override through the `engine: 'chatterbox' | 'supertonic'`
  option. Static constants `TTSGgml.ENGINE_CHATTERBOX` / `ENGINE_SUPERTONIC`
  and `getEngineType()` method.
- **GPU backend cascade** at load time. Chatterbox routes through Metal /
  CUDA / Vulkan / OpenCL when available; pass `nGpuLayers: 99` to fully
  offload. `useGPU` defaults `true` for Chatterbox. `RuntimeStats` now
  reports the active backend via `backendDevice` (0 = CPU, 1 = GPU) and
  `backendId` (0 = CPU, 1 = Metal, 2 = CUDA, 3 = Vulkan, 4 = OpenCL,
  99 = other-GPU).
- **Streaming APIs** aligned with `@qvac/tts-onnx`:
  - `run({ streamOutput: true, ... })` — sentence-chunked synthesis with
    `onUpdate` PCM emission.
  - `runStream(text, options?)` — convenience wrapper over `run`.
  - `runStreaming(textStream, options?)` — `string | string[] | Iterable |
    AsyncIterable` text input, PCM out per flushed job.
- **Chatterbox-only native streaming knobs:** `streamChunkTokens` (speech
  tokens per native chunk; 25 ≈ 1 s of audio, `0` disables),
  `streamFirstChunkTokens` (smaller first chunk for low TTFB), `cfmSteps`
  (CFM Euler step count; `1` halves cost, `2` matches Python meanflow).
- **Supertonic-only knobs:** `steps` (vector-estimator CFM steps; `0` =
  GGUF default), `speed` (speech-rate factor), `noiseNpyPath` (optional
  `.npy` initial-noise tensor for byte-exact reference reproduction).
- **Cross-compat aliases with `@qvac/tts-onnx`:** `voiceName` (alias of
  `voice`) and `numInferenceSteps` (alias of `steps`) accepted on options
  so call sites migrating from tts-onnx need fewer changes.
- **Output sample-rate control:** `runtimeConfig.outputSampleRate` and
  per-job `TTSRunInput.outputSampleRate` (8000–192000 Hz) resample the
  engine's native rate before emission. `TTSOutputChunk.sampleRate` is
  reported on every chunk.
- **Pre-chunked streaming metadata:** `SentenceStreamChunkMeta.isLast`
  flag on the final chunk of `runStream` / `run({ streamOutput: true })`.
- **Tuning knobs:** `seed` (RNG for CFM initial noise + SineGen
  excitation / Supertonic latent), `threads` (overrides
  `std::thread::hardware_concurrency()`), `nGpuLayers`.
- **File-path inputs:** `TTSGgmlFiles` accepts `modelDir` plus per-component
  GGUF paths (`t3Model`, `s3genModel`, `supertonicModel`) with `*Path`
  long-form and short aliases (`t3`, `s3gen`, `supertonic`).
- **C++ unit tests** (GoogleTest) and `coverage:cpp` target (llvm-cov).
- **Mobile integration test** generator (`test:mobile:generate` /
  `test:mobile:validate`).

### Differences vs `@qvac/tts-onnx`

Call sites migrating from `@qvac/tts-onnx` should be aware of the
following — these are not bugs, just intentional surface differences:

- **No LavaSR enhancer.** `EnhancerConfig` / `LavaSREnhancerConfig`, the
  constructor `enhancer` option, and the per-job `TTSRunInput.enhancer`
  override do not exist in `@qvac/tts-ggml`. There is no neural
  bandwidth-extension or denoiser path in the GGML backend today.
- **`referenceAudio` is a path string**, not `Float32Array | number[]`.
  Pass the absolute wav path; the native layer reads it.
- **`numThreads` → `threads`.** The ONNX-style `numThreads` is not
  accepted; use `threads` instead.
- **`supertonicMultilingual` is removed.** Multilingual mode is driven by
  the loaded GGUF (`chatterbox-*-mtl.gguf`) and engine selection rather
  than a runtime boolean.
- **GPU semantics differ for Supertonic.** `useGPU: true` and any non-zero
  `nGpuLayers` are **rejected at construction time** on Supertonic — the
  engine is CPU-only today. (Chatterbox accepts both and defaults
  `useGPU` to `true`.)
- **ONNX-style `*Path` file aliases are not accepted.** The GGML backend
  is single-GGUF-per-component, so the file set is much smaller; only the
  ggml-native field names listed under `TTSGgmlFiles` are honored.
