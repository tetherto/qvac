# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.4] - 2026-02-19

### Added
- `NOTICE` file with full third-party dependency attributions

## [0.3.3] - 2026-01-14

### Added
- Mobile integration testing with AWS Device Farm (#101)

### Changed
- Updated PR description template with team practices (#103)

### Fixed
- Type definitions for FFmpegDecoder.run() (#106)
- Added DecoderOutput interface export for consumer usage (#106)

## [0.3.2] - 2026-01-06

### Added
- Runtime statistics tracking for FFmpegDecoder including decode time, input/output bytes, samples decoded, codec name, sample rates, and audio format (#102)

## [0.3.1] - 2025-12-23

### Removed
- GStreamer/C++ addon code references (#97)
- Prebuild workflow - no longer needed without native addons (#97)
- On PR close workflow - no longer need to delete temporary packages (#100)

### Fixed
- Restored npm publish workflow that was accidentally removed (#99)

## [0.3.0] - 2025-12-18

### Added
- Windows x64 integration tests (#92)

### Changed
- Updated qvac-devops to v1.1.3 and enabled automatic git tag creation on npm publish (#89)

### Removed
- GstDecoder - library now uses FFmpegDecoder only (#94)

## [0.2.10] - 2025-12-16

### Added
- Corrupted audio test (#87)

### Changed
- Added ai-runtime-merge to CODEOWNERS (#90)

### Fixed
- M4A/MP4 audio format decoding by adding seek support to FFmpegDecoder IOContext (#91)

## [0.2.9] - 2025-12-15

### Fixed
- F32le audio format producing invalid samples during resampler flush (#88)

## [0.2.8] - 2025-12-08

### Changed
- Integrated QLOG-based logging across addon and pipeline components (#82)
- Reworked integration tests for both FFmpegDecoder and GSTDecoder (#83)

### Removed
- qvac-lib-inference-addon-cpp submodule (#84)

## [0.2.7] - 2025-12-08

### Fixed
- Race condition in corrupted audio detection using GStreamer's native bus API (#85)

## [0.2.6] - 2025-12-08

### Removed
- darwin-x64 (macOS Intel) prebuild support (#86)

## [0.2.5] - 2025-12-03

### Fixed
- Mobile platform crash by removing bare-worker multi-threading (#81)

## [0.2.4] - 2025-12-02

### Fixed
- Decoder hanging indefinitely on corrupted or invalid audio files (#78)
