# Changelog

## [0.1.0] - 2026-07-27

### Added

- Initial release of `@qvac/fit-llamacpp`, a memory-fit **preflight** addon that
  wraps llama.cpp's `llama_params_fit` C API to project — without loading any
  weights — whether a GGUF model fits available device memory, and if so with
  what offload plan (layers / context / tensor split). Intended to run in a
  short-lived isolated worklet before handing a model to `@qvac/llm-llamacpp`.
