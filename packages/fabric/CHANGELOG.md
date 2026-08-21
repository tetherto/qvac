# Changelog

## [0.7.0] - 2026-08-20

### Changed

- `qvac-fabric` dependency bumped `10069.1.1` -> `10069.2.0` (TurboVec CPU
  support from the fabric runtime; no API change for this package).

## [0.6.0] - 2026-08-18

### Changed

- `qvac-fabric` dependency bumped `10069.1.0` -> `10069.1.1` (Adreno OpenCL MoE
  repack fix; no API change for this package).

## [0.5.0] - 2026-08-17

### Changed

- `qvac-fabric` dependency bumped `10069.0.0` -> `10069.1.0` (VisionPsy Nano
  support and its Flash preprocessing rule; no API change for this package).

## [0.4.0] - 2026-08-10

### Changed

- `qvac-fabric` dependency bumped `9840.1.1` -> `10069.0.0` (b10069 rebase; no
  API change for this package).

### Pull Requests

- [#3621](https://github.com/tetherto/qvac/pull/3621) - Sync all addons with
  fabric v10069.0.0

## [0.3.1] - 2026-07-30

### Changed

- `qvac-fabric` dependency bumped `9840.0.1` -> `9840.1.1`, picking up the
  Vulkan strided `CONCAT` addressing fix with no API change for this package.

## [0.3.0] - 2026-07-28

### Changed

- `qvac-fabric` dependency bumped `9840.0.0` → `9840.0.1` (training weight-repack
  disable, Metal `acc`/`set` threadgroup dispatch fix, and MoE/hybrid training
  loss scaling; no API change for this package).

## [0.1.0] - 2026-05-29

### Added

- Initial release of `@qvac/fabric`: a shared bare addon that hosts the
  `qvac-fabric` runtime (forked `llama.cpp` + `ggml`) as a single prebuilt
  `qvac__fabric@0.bare` shared library, modeled on `@qvac/onnx`.
- Exports the full `llama_* / LLAMA_* / ggml_* / gguf_* / mtmd_*` C API plus the
  `common_*` and `json_schema_to_grammar` C++ symbols (Linux version script
  `symbols.map`, macOS `exports.txt`).
- Ships llama/ggml/common/mtmd headers under `prebuilds/include/` and a
  `find_package(qvac-fabric)` CMake config exposing `qvac-fabric::headers`.
- On **Linux and Android**, stages ggml compute backends as shared libraries under
  `prebuilds/<platform>/qvac__fabric/` for runtime loading via
  `ggml_backend_load_all_from_path()`; on **macOS, Windows, and iOS** the backends
  are static inside the shared `.bare` and self-register on load.
- Consumer integration guide in `INTEGRATION.md`.
