# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
