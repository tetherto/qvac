# Changelog

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
