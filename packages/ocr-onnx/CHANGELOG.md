# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.2] - 2026-04-14

### Fixed

- Updated README to use current package name (`@qvac/ocr-onnx`) and monorepo paths
- Removed redundant `ensure-npm-public` job from on-merge workflow

## [0.4.0] - 2026-04-08

### Changed

- **Breaking**: No longer extends `BaseInference`. `ONNXOcr` is now a standalone class owning its own lifecycle, logger, and job management.
- Replaced internal job management boilerplate with `createJobHandler()` from `@qvac/infer-base@0.4.0`
- Switched from `@qvac/response` to `@qvac/infer-base` for `QvacResponse`
- Added `@qvac/logging` as direct dependency

### Removed

- `BaseInference` inheritance — addon owns its own `load()`, `run()`, `unload()`, `destroy()`, `getState()`
- `@qvac/dl-hyperdrive`, `@qvac/response`, `bare-path`, `bare-process`, `bare-fetch` dependencies
- `loader` constructor parameter (was never used by OCR — `noAdditionalDownload: true`)
- `static JOB_ID`, `_saveJobToResponseMapping`, `_deleteJobMapping`, `_createResponse` boilerplate


## [0.3.5]
2026-04-08

### Changed

- Bumped `qvac-lib-inference-addon-cpp` vcpkg dependency to >=1.1.5
- DocTR models now download directly from OnnxTR GitHub releases on all platforms
- Removed legacy `scripts/generate-doctr-presigned-urls.sh`

## [0.3.4]
2026-04-08

### Added

- darwin-x64 (macOS Intel) prebuild support with custom vcpkg triplet

### Changed

- Updated `@qvac/onnx` dependency to ^0.14.0 (ONNX Runtime 1.24.2)
- Pinned `qvac-lib-inference-addon-cpp` >= 1.1.4 to pick up cancel race condition fix
- Disabled XNNPACK on Windows CI tests, consistent with all other platforms

## [0.3.3]
2026-03-18

### Added

- Exposed `enableCpuMemArena` and `intraOpThreads` as configurable JS API params
- Shared `windowsOrtParams` helper in test utils for consistent Windows CI ORT configuration across all integration tests

### Changed

- All integration tests use `windowsOrtParams` spread for Windows CI (BASIC + XNNPACK + no arena + 1 thread)
- Updated `@qvac/onnx` dependency to ^0.13.3

### Fixed

- Stale segmap data in `createSegmentationMap`: now zeros both the previous ROI and the current component's expanded ROI before setting values, preventing incorrect bounding boxes when component ROIs overlap with earlier stale data

## [0.3.2]
2026-03-17

### Added

- Configurable ORT session settings from JS API: `graphOptimization` (`'basic'|'extended'|'all'|'disable'`) and `enableXnnpack` (boolean) are now exposed as optional params alongside the existing `useGPU`
- `PipelineConfig` now holds an `onnx_addon::SessionConfig sessionConfig` member, replacing the separate `graphOptimization` field and the hardcoded `enableXnnpack = false` in each step constructor

### Changed

- Refactored all step constructors (`StepDetectionInference`, `StepRecognizeText`, `StepDoctrDetection`, `StepDoctrRecognition`) to accept `const onnx_addon::SessionConfig&` instead of individual `useGPU` + `optimization` parameters
- `AddonJs.hpp` parses `useGPU`, `graphOptimization`, and `enableXnnpack` into `config.sessionConfig` in a single block
- Integration test uses `graphOptimization: 'basic'` on Windows CI to avoid FusedConv OOM from EXTENDED optimization

## [0.3.1]
2026-03-13

### Changed

- Switched all inference steps to `runRaw()` for zero-copy output access, eliminating a full `memcpy` of output tensors per inference call (~50MB saved per detection frame at 2560x2560)
- Replaced `getInputInfo()[0].name` calls with `inputName(0)` in `StepDoctrDetection` and `StepDoctrRecognition`, avoiding ORT API queries and vector allocations on every inference
- `StepDetectionInference::runInference()` now returns `std::vector<Ort::Value>` instead of `std::vector<OutputTensor>`
- Updated `@qvac/onnx` dependency

## [0.3.0]
2026-03-11

### Changed

- Refactored OCR addon to use `@qvac/onnx` shared ONNX Runtime base package instead of bundling ONNX Runtime directly.
- Replaced direct `onnxruntime` vcpkg dependency with `qvac-onnx` CMake package from `@qvac/onnx`.
- Switched from `ORTCHAR_T*` to `std::string&` for model path parameters across Pipeline, detection, and recognition steps.
- Simplified ONNX session management using `onnx_addon::Session` wrapper instead of raw `Ort::Session`.
- Replaced raw `Ort::Value` tensor handling with `onnx_addon::InputTensor`/`onnx_addon::OutputTensor` abstractions.
- Removed custom symbol hiding (version scripts, exported symbols) — now handled by `@qvac/onnx` shared module.
- Simplified vcpkg configuration by removing bundled ONNX Runtime dependencies.

## [0.2.0]
2026-03-04

### Added

- DocTR OCR pipeline with DBNet text detection and CRNN/PARSeq text recognition models.
- Support for 4 DocTR ONNX models: db_resnet50, db_mobilenet_v3_large, parseq, crnn_mobilenet_v3_small.
- Symmetric padding, sigmoid postprocessing, and attention decoding matching Python OnnxTR.
- `straightenPages` option for perspective-corrected text region extraction.
- `decodingMethod` option (`greedy` or `attention`) for recognition decoding.
- DocTR model entries in the registry (models.prod.json).
- S3 presigned URL generation script for DocTR model distribution on mobile.
- DocTR integration tests: basic, French, lab results, and multi-model test suites.
- Bucket validation and jq-based JSON generation in presigned URL scripts.

### Changed

- Pipeline now supports both EasyOCR and DocTR modes, selected via `detectionArch` option.
- Shared ONNX Runtime environment across all sessions for stability.
- Safe tensor shape logging in detection and recognition steps to prevent out-of-bounds crashes.
- XNNPACK execution provider inherits ORT thread pool to prevent session destruction hangs.
- Skip 1200px resize for DocTR mode (uses full resolution).

### Fixed

- Windows ONNX Runtime session stability (XNNPACK threading, session lifecycle).
- `for...in` bug in MockONNXOcr.js language map iteration.
- Typo in bounding box log message.

## [0.1.8]
2026-02-20

### Added

- Performance statistics reporting: detection time, recognition time, total time, and text regions count are now exposed via the stats API.
- Architecture documentation for the OCR pipeline.
- NOTICE file with complete third-party dependency attributions (models, JS, Python, C++).
- Auto-download models via registry-client in examples.

### Changed

- Migrated to new C++ addon architecture for improved stability and maintainability.
- Applied clang-tidy naming conventions across C++ codebase.
- Standardized Apache 2.0 license and copyright headers across all files.
- Replaced hardcoded S3 bucket references with repository secrets in CI workflows and scripts.
- Updated registry key handling and switched to subpath imports for Bare compatibility.

## [0.1.6]
2026-02-09

### Changed

- Replaced fixed-width recognizer preprocessing with EasyOCR-style dynamic-width resizing for improved OCR accuracy. Images are now resized proportionally to model height with LANCZOS4 interpolation instead of aspect-preserving resize to a fixed 512px width.
- Switched to dynamic-width recognizer models (`rec_dyn`). Batch inference now uses per-batch proportional width instead of fixed `RECOGNIZER_MODEL_WIDTH`.
- Updated default model path from `rec_512` to `rec_dyn` across tests, benchmarks, and scripts.
- Replaced English recognizer with Latin recognizer in unit tests (`recognizer_english.onnx` → `recognizer_latin.onnx`).
- Added `--model-dir` CLI option to batch OCR CLI, evaluate script, and QVAC OCR backend for configurable model directory.

### Fixed

- Improved Portuguese OCR accuracy (minor punctuation corrections in test expected outputs).

## [0.1.2]
2026-01-16

### Changed

- Increased detector MAX_IMAGE_SIZE from 512 to 2560 for better text detection accuracy on high-resolution images.

## [0.1.0]
2026-01-13

### Added

- Internal image resizing: images larger than 1200px on longest side are automatically resized before processing, with bounding box coordinates returned in original image space.

### Changed

- **BREAKING**: Changed recognizer model width from 2560 to 512. This version only works with new recognizer models exported with 512 width input.
- Updated integration tests to use rec_512 models.

## [0.0.8]
2026-01-09

### Added

- Typescript type definitions
- CI job preventing merging unless TS checks pass

### Changed

- `test:dts` NPM script so it uses config defined in the `tsconfig.dts.json` file

## [0.0.7]
2026-01-09

### Added

- Linker version script (`symbols.map`) to hide internal symbols including ONNX runtime
- macOS support for symbol hiding via `-exported_symbol` linker flags
- Export `addonLogging` module in package.json for SDK integration

### Fixed
- Symbol collision when loading multiple ONNX-based addons (e.g., OCR and TTS) in the same process

## [0.0.6]
2026-01-08

### Added

- Expose all optional parameters via JS/TypeScript interface: `magRatio`, `defaultRotationAngles`, `contrastRetry`, `lowConfidenceThreshold`, `recognizerBatchSize`
- Android logcat support (ALOG macros) alongside QLOG for native Android logging
- On-demand image preparation to prevent OOM on memory-constrained devices

### Changed

- Default `contrastRetry` changed to `false` to reduce memory usage on mobile devices
- Default batch size reduced to 32 for better memory management
- Images are now prepared per-batch instead of all upfront, significantly reducing peak memory usage

### Fixed

- OOM crash on Android when processing large numbers of text regions (e.g., 300+ boxes)
- Memory spike from 1.7GB to 8GB during image preparation phase

## [0.0.5]
2025-12-23

### Added

- JavaScript tests and lint (#141)

### Changed

- Freeze vcpkg version on macOS (#140) - Improve build reproducibility

### Fixed

- QVAC-9777: Resolve failed test on darwin-arm64 (#139)

## [0.0.4]
2025-12-22

### Added

- Batch support for recognizer models to enable parallel processing (#130)
- Automatic benchmarking framework (#130)

### Fixed

- Simplified pipeline to sequential execution, fixing race conditions (#130)
- QVAC-10063: Fix existing examples (#131)

## [0.0.3]
2025-12-17

### Added

- PNG and JPG image format support (#127)
- Publish OCR addon on npm within @qvac namespace (#119)

### Changed

- Aligned hyperparameters to EasyOCR (#127)
- Use ccache and build only release to increase prebuild speed (#133)
- Added more permissions to workflows (#134, #135, #136)
- DEVOPS-916: Add ai-runtime-merge to CODEOWNERS (#128)

### Fixed

- End of job fix (#124)

## [0.0.2]
2025-10-29

### Added

- GPU support for OCR on Windows (#115)
- GPU sample code (#116)
- Qase API token integration (#113)
- Clang-format pre-commit check (#111)
- Approval-check-worker workflow (#82)
- CODEOWNERS file (#80)
- C++ lint and static analysis checks (#75, #74)
- Format check (#73)

### Changed

- Update production-workflows-tag to v1.1.0 (#117, #118)
- Continue workflow to next step (#112)
- Remove prebuild dependency on cpp-lint (#109, #110)
- Sync macOS version in tests with prebuild (#106)
- QVAC-5908: Enable GPU and CPP addon fixes (#101)
- Xcode with UIKit enable verification (#104)
- Add bare to engines (#105)
- Upgrade error lib (#91)
- QVAC-4215: Fix all lint errors, adjust checks (#78)
- Strip android libraries before building the addon (#81)
- YAML formatting (#84)
- QVAC-4665: Disable ERROR macro from wingdi.h (#77)
- Ensure correct C++ tooling is present in Ubuntu runner (#76)
- QVAC-3729: Addon renaming (use new onnx base package) (#72)

### Fixed

- Integration test fix (#114)
- PR workflow fixes (#89, #90)
- Install g++ in runner (#94)
- Missing prebuilds (#88)
