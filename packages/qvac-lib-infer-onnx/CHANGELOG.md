# Changelog

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
