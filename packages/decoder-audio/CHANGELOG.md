# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0]

This is a `[bc]` release that aligns `@qvac/decoder-audio` with the new addon shape used by the rest of the inference packages (NMT, Whisper, OCR, etc.). `FFmpegDecoder` no longer extends `BaseInference`, and the run lifecycle is now driven by `createJobHandler` from `@qvac/infer-base`.

### Changed

- `FFmpegDecoder` is now a standalone class — `extends BaseInference` (`@qvac/infer-base/WeightsProvider/BaseInference`) has been dropped.
- `run()` now uses `createJobHandler({ cancel })` from `@qvac/infer-base` to create and drive the active `QvacResponse`. The legacy `currentJob = { response, audioChunks, isActive, isPaused }` plumbing and the manual `new QvacResponse({ cancelHandler, pauseHandler, continueHandler })` instantiation have been removed.
- `QvacResponse` is now sourced from `@qvac/infer-base` (re-export) instead of the standalone `@qvac/response` package, matching the migration NMT did in earlier releases.
- `run()` is now synchronous (returns `QvacResponse<DecoderOutput>` directly instead of `Promise<QvacResponse<DecoderOutput>>`); decoding still happens asynchronously and is observed through the returned response.

### Added

- New `JOB_CANCELLED` (11012) error code in `@qvac/decoder-audio`'s error table. `response.await()` on a cancelled `run()` now rejects with `QvacErrorDecoderAudio({ code: 11012 })` instead of resolving with a partial buffer; cancellation is also honored once FFmpeg has started decoding (`_processPacket` checks `_cancelled` between packets).
- `unload()` now actively fails an in-flight `run()` with `QvacErrorDecoderAudio({ code: DECODER_NOT_LOADED })` instead of silently leaving the response to resolve after teardown.

### Removed

- Removed the `pause()` and `unpause()` public methods. The new shared `QvacResponse` no longer carries `pauseHandler` / `continueHandler` semantics, and no SDK consumer was using them.
- Removed the `stop()` public method. The standard `QvacResponse.cancel()` path (wired through `createJobHandler`'s `cancel` callback) is the only supported way to abort an in-flight decode. The SDK already calls `decoder.unload()` for teardown.
- Removed the `status()` and `getState()` public methods — neither was called by any consumer.
- Removed the `@qvac/response` runtime dependency from `package.json`. The runtime `require('@qvac/response')` in `index.js` and the type-only import in `index.d.ts` are gone.
- Removed `BaseInference` and `@qvac/response` imports from `index.d.ts`. The class declaration no longer extends `BaseInference`, and `pause`, `unpause`, `stop`, `status`, and `DecoderStatus` have been dropped from the public type surface.

### Notes

This is a `[bc]` release because the public class shape changes (removed methods, removed inheritance, removed dependency, `run()` no longer returns a `Promise`). No current SDK code path breaks — the SDK only calls `load()`, `run()`, and `unload()` and consumes the returned `QvacResponse` via its own `cancel()` / iteration APIs.

## [0.3.9]

### Changed
- Bumped `@qvac/decoder-audio` package version from `0.3.8` to `0.3.9`.

### Removed
- Removed redundant `process` (`npm:bare-process@^4.2.2`) entry from `dependencies` in `package.json`. The `bare-process` package is already declared directly as `bare-process: "^4.2.2"`, and the `process` alias was unused.

## [0.3.8] - 2026-04-28

This release bumps `@qvac/infer-base` from `^0.1.0` to `^0.4.0`. Together with `@qvac/infer-base@0.4.1` (which drops the legacy `@qvac/dl-hyperdrive` peer-dep), this stops `@qvac/dl-*` packages from being pulled into consumers' install trees through `@qvac/decoder-audio`. Public behavior of `FFmpegDecoder` is unchanged.

### Changed

- Bumped `@qvac/infer-base` direct dependency from `^0.1.0` to `^0.4.0`. Consumers using `decoder-audio` no longer carry the legacy `@qvac/infer-base@0.1.x` line — and therefore no longer inherit its `@qvac/dl-hyperdrive` peer-dep — in their dependency tree.

### Notes

The `BaseInference` public surface (constructor signature, lifecycle methods) is identical between `@qvac/infer-base` 0.1.1 and 0.4.x, so `class FFmpegDecoder extends BaseInference` continues to work unchanged. Lint clean + 9/9 brittle-bare unit tests pass against the new range.

## Pull Requests

- [#1761](https://github.com/tetherto/qvac/pull/1761) - QVAC-14392 chore: drop @qvac/dl-hyperdrive peer-dep chain in infer-base + decoder-audio

## [0.3.6]

### Changed

- README: removed outdated GitHub Packages token / `.npmrc` setup instructions for installing `@qvac/decoder-audio`.

## [0.3.5]

Security hardening release from comprehensive security audit.

### Changed
- Replace deprecated `istanbul` with `nyc` for code coverage (#1082)

### Fixed
- Fix coverage script to use `.nyc_output` directory for correct HTML report generation (#1082)

## [0.3.4]

### Added
- `NOTICE` file with full third-party dependency attributions

## [0.3.3]

### Added
- Mobile integration testing with AWS Device Farm (#101)

### Changed
- Updated PR description template with team practices (#103)

### Fixed
- Type definitions for FFmpegDecoder.run() (#106)
- Added DecoderOutput interface export for consumer usage (#106)

## [0.3.2]

### Added
- Runtime statistics tracking for FFmpegDecoder including decode time, input/output bytes, samples decoded, codec name, sample rates, and audio format (#102)

## [0.3.1]

### Removed
- GStreamer/C++ addon code references (#97)
- Prebuild workflow - no longer needed without native addons (#97)
- On PR close workflow - no longer need to delete temporary packages (#100)

### Fixed
- Restored npm publish workflow that was accidentally removed (#99)

## [0.3.0]

### Added
- Windows x64 integration tests (#92)

### Changed
- Updated oss-actions to v1.1.3 and enabled automatic git tag creation on npm publish (#89)

### Removed
- GstDecoder - library now uses FFmpegDecoder only (#94)

## [0.2.10]

### Added
- Corrupted audio test (#87)

### Changed
- Added ai-runtime-merge to CODEOWNERS (#90)

### Fixed
- M4A/MP4 audio format decoding by adding seek support to FFmpegDecoder IOContext (#91)

## [0.2.9]

### Fixed
- F32le audio format producing invalid samples during resampler flush (#88)

## [0.2.8]

### Changed
- Integrated QLOG-based logging across addon and pipeline components (#82)
- Reworked integration tests for both FFmpegDecoder and GSTDecoder (#83)

### Removed
- qvac-lib-inference-addon-cpp submodule (#84)

## [0.2.7]

### Fixed
- Race condition in corrupted audio detection using GStreamer's native bus API (#85)

## [0.2.6]

### Removed
- darwin-x64 (macOS Intel) prebuild support (#86)

## [0.2.5]

### Fixed
- Mobile platform crash by removing bare-worker multi-threading (#81)

## [0.2.4]

### Fixed
- Decoder hanging indefinitely on corrupted or invalid audio files (#78)
