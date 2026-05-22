# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
