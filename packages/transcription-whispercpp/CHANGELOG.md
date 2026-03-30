# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.3]

### Changed
- Bumped `qvac-lib-inference-addon-cpp` to `1.1.3`.
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
- Migrated the native addon implementation to `qvac-lib-inference-addon-cpp` 1.x (`IModel` + `AddonJs`/`AddonCpp`), replacing the removed legacy templated addon and jobs-handler path
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
