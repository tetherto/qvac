# Changelog

## [0.14.1] - 2026-04-21

### Fixed

- Patched ONNX Runtime 1.24.2 CoreML EP to fix `!model_path.empty()` crash when loading models with external data files (`.onnx_data` / `.onnx.data`) on macOS/iOS. Root cause: `TensorProtoWithExternalDataToTensorProto` passed the full model file path instead of its parent directory to `ReadExternalDataForTensor`. Backport of [microsoft/onnxruntime#28062](https://github.com/microsoft/onnxruntime/pull/28062). Upstream issue: [microsoft/onnxruntime#28005](https://github.com/microsoft/onnxruntime/issues/28005).

### Changed

- Pinned onnxruntime dependency to `>= 1.24.2#5` in `vcpkg.json` to pick up the CoreML fix from `qvac-registry-vcpkg`.

## [0.14.0] - 2026-03-30

### Changed

- Upgraded the bundled ONNX Runtime toolchain from 1.22.0 to 1.24.2 by pinning `qvac-lib-infer-onnx` to the updated `qvac-registry-vcpkg` baseline
- Restored the default XNNPack-enabled build against the compatible ONNX Runtime 1.24.2 registry revision
- Refreshed package metadata and release documentation to match the new runtime baseline and release version

## [0.13.3] - 2026-03-18

### Changed

- Logging adjustments


## [0.13.2] - 2026-03-16

### Fixed

- Session creation fallback chain now catches `std::exception` (including `std::bad_alloc`) instead of only `Ort::Exception`, fixing DirectML OOM failures on Windows CI machines without a real GPU

## [0.13.1] - 2026-03-16

### Added

- Fallback chain in `OnnxSession` constructor: if session init fails with a non-CPU provider (e.g. DirectML OOM on CI machines without a real GPU), automatically retries with CPU-only configuration

## [0.13.0] - 2026-03-13

### Added

- `runRaw()` method on `OnnxSession` returning `std::vector<Ort::Value>` for zero-copy output access, avoiding the `memcpy` into `OutputTensor` on every inference call
- `inputName(size_t)` and `outputName(size_t)` accessors on `IOnnxSession` and `OnnxSession` for direct O(1) access to cached input/output names without querying the ORT API

### Changed

- `IOnnxSession` interface now requires `inputName()` and `outputName()` pure virtual methods
- Cached `Ort::MemoryInfo` as a class member instead of recreating it on every `run()` call
- Refactored `run()` to delegate to `runRaw()` internally (no behavior change for existing callers)


## [0.12.12] - 2026-03-12

### Fixed

- Windows runtime loading: export `OrtGetApiBase` from the bare module using `/EXPORT` linker flag (a `.def` file overrides `WINDOWS_EXPORT_ALL_SYMBOLS`, suppressing the `bare_*`/`napi_*` auto-exports and causing DLL initialization failure)
- macOS runtime loading: set `INSTALL_NAME_DIR` to `@rpath` so that consumer addons can resolve the companion `qvac__onnx@0.bare` via their `@loader_path` rpath entries (cmake-bare's default empty install_name caused dyld to skip rpath search entirely)


## [0.12.10] - 2026-03-12

### Fixed

- Windows C++20 clang-cl build: replaced legacy `OrtSessionOptionsAppendExecutionProvider_DML` C API with generic `AppendExecutionProvider("DML")`, removing `#include <dml_provider_factory.h>` which pulled in the Windows SDK and caused `byte` ambiguity with `std::byte`


## [0.12.8] - 2026-03-11

### Added

- Android logger

### Fixed

- Added exception handler for com.ms.internal.nhwc schemas issue


## [0.12.1] - 2026-03-05

### Fixed

- Failed CI sanity checks
- CI build errors for android, osx, and ios


## [0.12.0] - 2026-03-04

### Added

- Full bare addon architecture with C++ binding layer and JavaScript API
- New JS API: `configureEnvironment()`, `getAvailableProviders()`, `createSession()`, `getInputInfo()`, `getOutputInfo()`, `run()`, `destroySession()`
- New C++ headers: `OnnxConfig.hpp` (configuration enums/structs)
- INTEGRATION.md consumer guide

### Changed

- Refactored from header-only interface library (`add_library(INTERFACE)`) to bare addon module (`add_bare_module(EXPORTS)`)
- CMake minimum version raised to 3.25
- XNNPack execution provider enabled by default

### Fixed

- Crash issue in session management
- Protobuf build errors
- Build errors encountered by consumer addons
- Package linked as dynamic (not static) for proper runtime behavior

---

### Categories

- **Added** for new features
- **Changed** for changes in existing functionality
- **Deprecated** for soon-to-be removed features
- **Removed** for now removed features
- **Fixed** for any bug fixes
- **Security** in case of vulnerabilities
