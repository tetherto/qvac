# Changelog

## [Unreleased]

### Fixed

- Register ggml backends before fitting. `llama_params_fit` only reads ggml's
  global device registry and never populates it, so without an explicit
  `llama_backend_init()` the fitter could project against an empty device list
  and still report `SUCCESS`. An RAII scope now loads the packaged backends
  (new optional `backendsDir`, `BACKENDS_SUBDIR` appended) or falls back to
  ggml's default search path, then initialises and frees the llama backend.

### Added

- `nDevices` and `nGpuDevices` on the result — the device inventory the
  projection was actually made against. Zero registered devices now returns
  `ERROR` instead of a verdict. `maxDevices` is a build-time bound and must not
  be read as a detection result.

## [0.1.0] - 2026-07-27

### Added

- Initial release of `@qvac/model-fit`, a memory-fit **preflight** addon that
  wraps llama.cpp's `llama_params_fit` C API to project — without loading any
  weights — whether a GGUF model fits available device memory, and if so with
  what offload plan (layers / context / tensor split). Intended to run in a
  short-lived isolated worklet before handing a model to `@qvac/llm-llamacpp`.
