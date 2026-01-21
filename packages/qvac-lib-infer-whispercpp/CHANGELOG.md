# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[Unreleased] - 2026-01-13
- Improved the test coverage for C++ code
- Showing C++ test results in the PR comments

## [Unreleased] - 2026-01-12
- add mobile integration tests for mobile

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

---

## How to Update This Changelog

When releasing a new version:

1. Move items from `[Unreleased]` to a new version section
2. Add the version number and date: `## [X.Y.Z] - YYYY-MM-DD`
3. Keep the `[Unreleased]` section at the top for ongoing changes
4. Group changes by category: Added, Changed, Deprecated, Removed, Fixed, Security

### Categories

- **Added** for new features
- **Changed** for changes in existing functionality
- **Deprecated** for soon-to-be removed features
- **Removed** for now removed features
- **Fixed** for any bug fixes
- **Security** in case of vulnerabilities

