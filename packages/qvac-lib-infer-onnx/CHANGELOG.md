# Changelog

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
