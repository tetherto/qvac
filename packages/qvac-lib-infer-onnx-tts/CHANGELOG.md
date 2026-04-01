# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.1]

### Changed

- README: removed outdated npm Personal Access Token / `.npmrc` setup instructions for installing `@qvac/tts-onnx`.

## [0.7.0]

This release moves Supertonic onto the official Supertone ONNX graphs and multilingual Hugging Face weights, expands the JS surface and tooling for multilingual runs, and hardens benchmark and native build paths. Consumers using Supertonic should plan for updated models and configuration aligned with the new graphs.

## Breaking Changes

### Supertonic graphs and weights

Supertonic inference now targets the official Supertone ONNX graphs and multilingual Hugging Face weight layout bundled with this line of work. Existing model directories or download scripts built for the previous graph or artifact layout may no longer load. Prefer the updated `ensure-models` / download flows, `example-supertonic-multilingual-tts.js`, and the current Supertonic config types in `index.d.ts` when migrating.

## Features

### Multilingual Supertonic

The native Supertonic path gains multilingual support and related stabilization (including work to address stuttering), with integration and benchmark updates so non-English datasets and clients can exercise the addon consistently.

### Examples and TypeScript

A dedicated multilingual example script documents the new flow, and `index.d.ts` is expanded so Supertonic options and multilingual parameters are described accurately for TypeScript consumers.

## [0.6.6]

Security hardening release from comprehensive security audit.

### Fixed
- Add 1 MB request body size limit to benchmark server to prevent DoS via memory exhaustion (#1102)
- Validate `modelDir` path in benchmark server to prevent directory traversal outside allowed directories (#1103)
- Remove filesystem paths from C++ error messages in `FileUtils.hpp` to prevent path leakage (#1105)

## [0.6.5]

This release improves TypeScript support for consumers of the ONNX TTS package. Runtime statistics that the native addon already exposes when `opts.stats` is enabled are now described in `index.d.ts`, and `run()` is typed so inference responses carry structured output chunks.

## New APIs

### `RuntimeStats` and related types in `index.d.ts`

The `ONNXTTS` namespace now exports **`RuntimeStats`**, matching the keys returned by `TTSModel::runtimeStats()` in the addon: `totalTime`, `tokensPerSecond`, `realTimeFactor`, `audioDurationMs`, and `totalSamples`. **`TTSOutputChunk`** (`outputArray`) and **`TTSRunInput`** describe the `run()` input and streamed output shape. **`run()`** is declared to return **`Promise<QvacResponse<ONNXTTS.TTSOutputChunk>>`**, with documentation that `response.stats` aligns with **`RuntimeStats`** when stats collection is turned on at construction time.

## [0.6.4]

Fix q4f16 chatterbox models for linux-arm64

## [0.6.3]

This release fixes a logging issue in the JS layer where two log statements during model load were bypassing the addon logging pipeline.

## Bug Fixes

### JS Layer Logs Now Routed Through Addon Logger

Two `console.log` calls in the `_load()` method — logging the active engine type and language — were writing directly to stdout instead of going through the addon's logger. This meant those messages would not be captured or filtered by the logging infrastructure used everywhere else in the package. Both calls have been replaced with `this.logger.info(...)`, consistent with all other logging in the file.

## Pull Requests

- [#875](https://github.com/tetherto/qvac/pull/875) - QVAC-14098 fix: route JS layer logs through addon logger

## [0.6.2]

Fix Chatterbox models with FP16 quantization not working on linux-arm64 platform.

## [0.6.1]

This release fixes CMake configuration errors that were preventing the TTS addon from building correctly with updated onnxruntime dependencies, and pins onnxruntime to a minimum version constraint to avoid future compatibility issues.

## Bug Fixes

### CMake Configuration Errors in onnxruntime Integration

Fixed build failures caused by incorrect onnxruntime target configuration in `CMakeLists.txt`. Three issues were resolved:

- A duplicate `find_package(onnxruntime CONFIG REQUIRED)` call was removed, which was causing the `safeint_interface` target to be defined twice and result in a build conflict.
- An `add_library(onnxruntime ALIAS onnxruntime::onnxruntime_static)` statement was removed — the `onnxruntime::onnxruntime_static` target does not exist in the package, making this ALIAS definition invalid.
- The `target_link_libraries` reference was corrected from `onnxruntime::onnxruntime_static` to `onnxruntime::onnxruntime`, matching the actual exported target name from the onnxruntime package.

### onnxruntime Version Constraint

Instead of bumping the vcpkg registry baseline, a `version>=: "1.24.2"` constraint has been added to all four `onnxruntime` dependency entries in `vcpkg.json`. This ensures a known-compatible minimum version is used across all platform-specific feature variants (NNAPI, DirectML, CoreML, and the default Linux build) without unnecessarily updating unrelated dependencies.

## [0.6.0]

### Changed
- Migrated the native addon implementation to `qvac-lib-inference-addon-cpp` 1.x (`IModel` + `AddonJs`/`AddonCpp`), replacing the removed legacy templated addon API
- Updated JS/native runtime flow to `createInstance` + `runJob` semantics while preserving package-level behavior

### Fixed
- Removed nested `exclusiveRun` locking paths that could deadlock `run()`, `reload()`, or `unload()` when `exclusiveRun: true`

## [0.5.5]

### Added
- Fp16 quantization support for Chatterbox ONNX models (English and multilingual) in the C++ inference path; `Fp16Utils` module for fp16↔fp32 conversion and type-aware tensor read/write
- Refactored `ChatterboxEngine::synthesize()` into smaller, testable helpers; `IOnnxInferSession` interface and `OrtTypes.hpp` for clearer boundaries and session factory injection in tests
- Unit tests for `Fp16Utils`, ChatterboxEngine helpers, `OnnxInferSessionMock`, and factory injection; integration tests for `OnnxInferSession` and full Chatterbox synthesis (with optional model download via `models:ensure` script)
- C++ coverage and CI: workflow publishes test results to Checks, writes coverage summary to job summary; LLVM coverage symlinks and correct coverage paths in TTS C++ coverage workflow
- `models:ensure` script to download Chatterbox (en/multilingual, fp32/fp16) and Supertonic models; respects `CHATTERBOX_VARIANT`, `CHATTERBOX_LANGUAGE`; use `TTS_ENSURES=all` to ensure all variants

### Changed
- Checkout step in `cpp-test-coverage-qvac-lib-infer-onnx-tts.yml` and `integration-test-qvac-lib-infer-onnx-tts.yml` now uses `PAT_TOKEN` for PR/fork compatibility

## [0.5.4]

### Added
- Lazy ONNX session loading to reduce peak memory usage during synthesis, preventing out-of-memory kills on memory-constrained devices
  - Sessions created on demand during `synthesize()` and released when no longer needed
  - Controlled via `lazySessionLoading` option, defaults to `true` on iOS and `false` on other platforms

## [0.5.3]

### Added
- Multilingual support to the Chatterbox TTS engine, enabling speech synthesis in Spanish, French, Italian, German, Portuguese, and other languages

## [0.5.2]

### Added
- Test for automatic engine-type detection

### Changed
- Unit tests renamed and updated to use Supertonic engine configuration exclusively
- Regenerated NOTICE file

### Removed
- Legacy Piper engine references from the test suite
- eSpeak-specific JSDoc from `tts.js`

## [0.5.1]

### Changed
- README now covers both Chatterbox and Supertonic TTS engines with full usage guides, API references, and comparison

### Removed
- Legacy Piper and eSpeak-ng references from the benchmark suite
- `@qvac/dl-hyperdrive` dependency

## [0.5.0]

### Added
- Supertonic TTS engine with automatic engine detection based on configuration
- `SupertonicTTSArgs` TypeScript type and expanded `ONNXTTSArgs` union type
- Windows support for Supertonic
- Example script `examples/example-supertonic-tts.js`

## [0.4.0]

### Changed
- Addon now exclusively uses the Chatterbox engine
- Integration tests improved with real reference audio for voice cloning validation
- Consolidated test WAV utilities into `test/utils/wav-helper.js`

### Removed
- Piper TTS engine and all associated dependencies (`PiperTTSArgs`, `ENGINE_PIPER`, `TashkeelDiacritizer`, Piper vcpkg dependencies)
- Piper-specific examples and model downloads from CI workflows

## [0.3.0]

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

## [0.2.12]

### Changed
- Linux x64 build environment switched from Ubuntu 24.04 to Ubuntu 22.04 for oldest LTS compatibility
- Integration tests now run on both Ubuntu 22.04 and 24.04

## [0.2.11]

### Changed
- Debug symbols stripped from prebuilt binaries on Linux and macOS, reducing binary size
- Internal ONNX Runtime symbols hidden from dynamic symbol table to prevent conflicts with other native modules

### Removed
- Unnecessary Android artifact replication step from workflow

## [0.2.10]

### Added
- TypeScript type declarations for `addonLogging` subpath export

## [0.2.9]

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

## [0.2.8]

### Added
- Addon logging JS interface export (#93)
