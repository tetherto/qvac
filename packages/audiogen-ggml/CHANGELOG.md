# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial `@qvac/audiogen-ggml`: text-to-music generation addon (ggml backend)
  wrapping the ACE-Step engine from `audiogen-cpp`. Text prompt in, stereo
  48 kHz audio out.
- `AudioGen` class with an async facade — `activate()`, `generate(caption, opts)`,
  `cancel()`, `destroy()` — and a native output callback delivering interleaved
  Int16 PCM chunks plus a trailing stats event (`audioDurationMs`, `totalTimeMs`).
- Full ACE-Step pipeline (text-encoder → LM → DiT → Oobleck VAE) with optional
  `lyrics`, `vocalLanguage`, `bpm`, `keyscale`, `timesignature`, `duration` and
  `seed`.
- DiT selection: `models.js` manifest with the fixed text-encoder / LM / VAE
  stages plus a `ditVariant` enum (`turbo-q4` | `turbo-q8` | `sft`), and helpers
  to resolve registry paths / sources. `inferenceSteps` / `shift` auto-tune per
  DiT architecture (turbo vs sft) when unset.
- Optional GPU acceleration (Metal / CUDA / Vulkan) via `useGpu`, with CPU
  fallback.
- Output peak-normalized to -0.9 dBFS before int16 conversion to avoid clipping.
- WAV and raw-PCM output encoding via `AudioGen.encode`.
- Unit tests for the model manifest and a registry existence check (no download).
