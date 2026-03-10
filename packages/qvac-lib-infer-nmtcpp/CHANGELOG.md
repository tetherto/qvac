# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-03-05

### Added
- Cancellation support for pivot translation by implementing `IModelCancel` in `PivotTranslationModel`.

### Changed
- Aligned pivot translation internals with the shared addon model lifecycle and updated model interface wiring for `PivotTranslationModel`.
- Updated native build integration so pivot translation sources are compiled and linked consistently across package targets.

## [0.4.0] - 2026-03-05

This release adds pivot translation support so a single request can be translated through an intermediate language using two configured models. It also aligns the translation model with the shared `IModel` interface to improve consistency with other inference add-ons. Together, these updates make multi-hop translation flows easier to configure while preserving existing single-model usage.

## Features

Pivot translation is now available through a dedicated `PivotTranslationModel` that chains two `TranslationModel` instances and supports both single-text and batch processing flows. The JavaScript addon creation path now detects optional `pivotModel` configuration and automatically initializes either the pivot pipeline or the existing single-model pipeline based on user configuration. Build integration was updated to compile and link the new pivot model implementation as part of the addon.

## Other

The package API surface was cleaned up by promoting `processBatch` to the public `TranslationModel` interface to support pivot composition, and by removing unused includes in translation model headers and implementation files.

## [0.3.9]
2026-02-25

### Fixed
- Batch run API fix for correct batch translation handling (#549)
- Replaced inline sanity-checks with shared reusable action for fork PR compatibility (#521)
- Updated addon-cpp version constraint to match actual 1.x API usage (#520)

## [0.3.1]
2026-01-13

### Added
- TypeScript type declarations for `addonLogging` subpath export

## [0.3.0]
2025-01-08

### Added
- TypeScript type declarations (`index.d.ts`) - migrated from `@qvac/sdk` and aligned with runtime API
- CI job for type declaration validation (`ts-checks`)
- `test:dts` script for type checking

## [0.2.1]
2026-01-03

### Added
- Batch Support in Bergamot Wrapper (#429) - Add batch translation API for improved performance
- Performance Logging (#448) - Add tokens/second performance logging
- Addon Logging JS Interface (#412) - Add logging interface from C++ to JS
- Enable and test 6 IndicTrans model variants
- Bergamot batch evaluation with FLORES dataset (#445)
- Bergamot backend test integration on Android (#444)
- iOS test workflow (#441) - Make test runs available on iOS via workflow
- Android integration tests (#420) - Add automatic tests on mobile platforms
- Model conversion test workflow (#381)
- Bergamot benchmarking (#433)
- IndicTrans model integration tests - Test English to Hindi translation
- Re-enable C++ unit tests for IndicTrans - Previously disabled due to model loading issues

### Changed
- C++ lint stage (#442) - Add clang-tidy linting to CI
- Freeze vcpkg version on macOS (#432) - Improve build reproducibility
- Add core team to CODEOWNERS (#447, #427)

## [0.2.0]
2025-12-20

### Added
- Bergamot NMT backend with multi-platform build support (#422)

## [0.1.10]
2025-11-27

### Added
- 16 KB page size support for Android 15+ compatibility (Google Play requirement)
- Linker flags for ARM64 Android and Linux builds to support both 4 KB and 16 KB page sizes

### Changed
- Updated bare dependencies to latest versions (bare-fs 4.5.1, bare-process 4.2.2, bare-stream 2.7.0, bare-subprocess 5.2.1)
- Updated GitHub workflows to use ubuntu-24.04 runners for prebuild jobs
- Updated Vulkan SDK repository from jammy to noble for Ubuntu 24.04 compatibility
- Added NDK environment configuration for Android builds (ANDROID_NDK_LATEST_HOME)

## [0.1.8]
2025-11-24

### Changed
- update cmake-bare version for better react-native-bare-kit compatability.

## [0.1.7]
2025-11-21

### Added
- Support for multilingual models with language prefix tokens (e.g., en-roa for Portuguese translation)
- Conversational dataset support for benchmarking
- Bergamot translator integration for quality benchmarking comparisons

### Fixed
- C++ linting errors (clang-tidy) - added NOLINT markers for FFI code compatibility
- C++ test workflow now fails if no tests are generated or executed (prevents false positive passes)

## [0.1.6]
2025-11-18

### Fixed
- Android addon loading by disabling Vulkan to avoid libvulkan.so dependency issues

### Changed
- Disabled Vulkan support for non-Apple platforms to improve Android compatibility
- Updated Vulkan configuration in whisper-cpp overlay to disable GGML_VULKAN on Android
- Set useGpu to false by default for CPU-only mode (GPU can still be enabled via config)

## [0.1.5]
2025-11-15

### Added
- Android ARM64 build support with Vulkan GPU acceleration
- Hyperparameter presets for benchmark workflow (default, fast)
- C++ test coverage reporting with llvm-cov
- Temperature parameter testing with deterministic behavior validation

### Changed
- Benchmark workflow uses preset-based hyperparameter configuration
- CI pipeline now properly fails when C++ tests fail (removed `continue-on-error`)
- Added cpp-quality checks to merge-guard for PR enforcement
- Increased integration test GCC version to match prebuild environment (GCC 13)

### Fixed
- Benchmark workflow triggering issue (GitHub Actions 10-input limit exceeded)
- GLIBCXX version mismatch in integration tests by installing libstdc++-13-dev
- Variable shadowing in nmt.cpp (g_optimal_threads)

## [0.1.4]
2025-01-10

### Added
- Portuguese model support
- Benchmarking with SDK integration
- Evaluation tools and metrics

### Changed
- Performance optimizations in NMT core
- Thread management improvements

### Fixed
- Various NMT core fixes and stability improvements
