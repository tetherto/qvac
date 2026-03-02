# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.4] - 2026-02-24

### Added
  - Lazy ONNX session loading to reduce peak memory usage during synthesis, preventing out-of-memory kills on memory-constrained devices
  - Sessions created on demand during `synthesize()` and released when no longer needed
  - Controlled via `lazySessionLoading` option, defaults to `true` on iOS and `false` on other platforms

## [0.5.3] - 2026-02-20

### Added
- Multilingual support to the Chatterbox TTS engine, enabling speech synthesis in Spanish, French, Italian, German, Portuguese, and other languages

## [0.5.2] - 2026-02-19

### Added
- Test for automatic engine-type detection

### Changed
- Unit tests renamed and updated to use Supertonic engine configuration exclusively
- Regenerated NOTICE file

### Removed
- Legacy Piper engine references from the test suite
- eSpeak-specific JSDoc from `tts.js`

## [0.5.1] - 2026-02-18

### Changed
- README now covers both Chatterbox and Supertonic TTS engines with full usage guides, API references, and comparison

### Removed
- Legacy Piper and eSpeak-ng references from the benchmark suite
- `@qvac/dl-hyperdrive` dependency

## [0.5.0] - 2026-02-16

### Added
- Supertonic TTS engine with automatic engine detection based on configuration
- `SupertonicTTSArgs` TypeScript type and expanded `ONNXTTSArgs` union type
- Windows support for Supertonic
- Example script `examples/example-supertonic-tts.js`

## [0.4.0] - 2026-02-13

### Changed
- Addon now exclusively uses the Chatterbox engine
- Integration tests improved with real reference audio for voice cloning validation
- Consolidated test WAV utilities into `test/utils/wav-helper.js`

### Removed
- Piper TTS engine and all associated dependencies (`PiperTTSArgs`, `ENGINE_PIPER`, `TashkeelDiacritizer`, Piper vcpkg dependencies)
- Piper-specific examples and model downloads from CI workflows

## [0.3.0] - 2026-02-13

### Added
- Chatterbox TTS engine with voice cloning from reference audio
- Automatic engine detection based on configuration parameters
- Seven language support: English, Spanish, French, German, Italian, Portuguese, and Russian
- Expanded TypeScript definitions (`ChatterboxTTSArgs`, `ONNXTTSArgs`)
- `OnnxInferSession` universal ONNX model inference session wrapper
- Example application for Chatterbox TTS
- Comprehensive integration and unit tests for Chatterbox

### Changed
- CI/CD pipeline now auto-installs Rust targets for iOS and Android cross-compilation
- Updated `tokenizers-cpp` (v0.1.1), vcpkg baseline, `qvac-lib-inference-addon-cpp` to v0.12.2

### Fixed
- Windows-specific build issues
- Reference audio handling in integration tests

## [0.2.12] - 2026-02-01

### Changed
- Linux x64 build environment switched from Ubuntu 24.04 to Ubuntu 22.04 for oldest LTS compatibility
- Integration tests now run on both Ubuntu 22.04 and 24.04

## [0.2.11] - 2026-02-01

### Changed
- Debug symbols stripped from prebuilt binaries on Linux and macOS, reducing binary size
- Internal ONNX Runtime symbols hidden from dynamic symbol table to prevent conflicts with other native modules

### Removed
- Unnecessary Android artifact replication step from workflow

## [0.2.10] - 2026-01-13

### Added
- TypeScript type declarations for `addonLogging` subpath export

## [0.2.9] - 2026-01-06

### Added
- Mobile device farm integration testing for AWS Device Farm (#118)
- Linux ARM64 prebuild support using `ubuntu-24.04-arm` runner (#117)
- vcpkg and ccache caching in prebuilds workflow for dramatically faster build times (#116)
- Reload functionality for TTS model with example and integration tests (#112)
- WER (Word Error Rate) tests (#109)
- Workflow dispatch to integration tests (#107)
- Unit tests for TTS interface (#98)

### Fixed
- Error reporting using @qvac/error package for consistent error handling (#114)
- Workflow dispatch on integration test (#111)
- Permissions for workflows (#110)
- Sanity checks workflow (#106)
- Use Hugging Face to download models (#96)

### Changed
- Freeze vcpkg version on macOS for build reproducibility (#113)
- Updated CODEOWNERS with ai-runtime-merge team (#99)

## [0.2.8] - 2025-12-03

### Added
- Addon logging JS interface export (#93)
