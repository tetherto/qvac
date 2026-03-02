# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.2] - 2026-02-27

### Changed
- Logger type in `TranscriptionWhispercppArgs` now uses `LoggerInterface` from `@qvac/logging` instead of a package-specific type, aligning with the shared logging interface used across all addons

## [0.4.1] - 2026-02-18

### Added
- HuggingFace model download support for standard Whisper and Silero VAD models
- Download script `scripts/download-models.sh` for interactive model downloads
- Auto-download of models in test helpers (`ensureWhisperModel`, `ensureVADModel`)
- Architecture documentation

### Removed
- Legacy P2P data loader peer dependency and dev dependency
- Legacy examples (`transcription.hd.js`, `exampleVad.hd.js`)

## [0.4.0] - 2026-02-11

### Removed
- `TranscriptionFfmpegAddon` module (`transcription-ffmpeg.js`, `transcription-ffmpeg.d.ts`, `examples/example.ffmpeg.js`)
- `@qvac/util-transcription` dependency

## [0.3.18] - 2026-02-11

### Added
- Windows platform support with PowerShell-specific CI configurations
- Prebuild package renaming from `tetherto__*` to `qvac__*` format

### Fixed
- Whisper.cpp API compatibility updated to new 4-parameter `whisper_full()` API

### Changed
- Integration tests now use `bare@1.26.0` for build consistency

## [0.3.17] - 2026-02-01

### Fixed
- Spurious linux-x64 prebuild compilation issue

## [0.3.16] - 2026-02-01

### Changed
- Audio decoder dependency updated to use FFmpeg (`@qvac/decoder-audio` v0.3.3) instead of GStreamer
- `@qvac/util-transcription` updated to v0.1.4, replacing all GStreamer references with FFmpeg

## [0.3.15] - 2026-02-01

### Changed
- Linux x64 builds switched to Ubuntu 22.04 for wider glibc compatibility
- Integration test matrix expanded to include Ubuntu 22.04 and 24.04
- Vulkan SDK installation improved for x64 and arm64 Linux architectures

### Removed
- Unnecessary Vulkan SDK installation from integration tests
- Custom vcpkg installation step no longer needed with standard Ubuntu runners

## [0.3.14] - 2026-02-01

### Changed
- Debug symbols stripped from native addon binaries on Linux and macOS for smaller prebuilt artifacts

### Removed
- Redundant Android artifact replication step

## [0.3.13] - 2026-01-15

### Fixed
- Type declarations: `Loader` and `QvacResponse` now correctly imported from `@qvac/infer-base`
- `test:dts` now passes

## [0.3.12] - 2026-01-13

### Added
- TypeScript type declarations for `addonLogging` subpath export

### Fixed
- `test:dts` script now references `transcription-ffmpeg.d.ts` instead of deleted `transcription-addon/index.d.ts`

## [0.3.11] - 2026-01-07

### Added
- Runtime statistics support for Whisper model performance tracking
  - New `runtimeStats()` method exposing detailed metrics (totalTime, realTimeFactor, tokensPerSecond, audioDurationMs, etc.)
  - Integration test validating stats are populated when `opts.stats=true`

## [0.3.10] - 2026-01-06

### Added
- Linux ARM64 prebuild support using `ubuntu-24.04-arm` runner (#386)
- Linux ARM64 integration tests (#390)

### Changed
- Updated CODEOWNERS (#380)
- Updated PR description template with team practices (#391)

## [0.3.9] - 2025-12-30

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

## [0.3.8] - 2025-12-15

### Added
- AraDiaWER metric for Arabic dialect speech recognition benchmarking (#358)

### Fixed
- FFmpeg example to correctly pass audio format (#363)

## [0.3.7] - 2025-12-09

### Changed
- Updated util-transcription dependency version (#360)

## [0.3.6] - 2025-12-09

### Changed
- Updated decoder dependency version (#359)

## [0.3.5] - 2025-12-04

### Added
- Unit tests for Whisper model file validation (#352)
- Model file and VAD path validation logic (#352)

## [0.3.4] - 2025-12-03

### Fixed
- Job ID return value (#353)

### Changed
- Reorganized examples and cleaned up unnecessary files (#356)

## [0.3.3] - 2025-12-03

### Added
- Addon logging JS interface export (#357)

## [0.3.2] - 2025-12-02

### Added
- Enhanced C++ logging for WhisperModel and job handlers (#349)
- DEBUG-level logs for job queue and audio input handling (#349)

### Fixed
- Configuration errors in examples (#341)
- Updated Bare runtime version requirement to >= 1.24.2 (#354)

### Changed
- Reworked integration tests to use TranscriptionWhispercpp (#345)
- Updated documentation to reflect current codebase structure (#354)
