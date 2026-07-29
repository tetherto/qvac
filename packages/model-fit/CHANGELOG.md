# Changelog

## [Unreleased]

### Fixed

- Register ggml backends before fitting. `llama_params_fit` only reads ggml's
  global device registry and never populates it, so without an explicit
  `llama_backend_init()` the fitter could project against an empty device list
  and still report `SUCCESS`. An RAII scope now loads the packaged backends
  (new optional `backendsDir`, `BACKENDS_SUBDIR` appended) or falls back to
  ggml's default search path, then initialises and frees the llama backend.

- Serialise fit calls process-wide. `llama.h` documents `llama_params_fit` as
  not thread safe because it mutates global llama logger state, and this addon's
  C++ statics are shared across worklets, so concurrent callers now block. This
  also keeps two backend scopes from overlapping, which is what allows the
  unconditional init/free above to stay correct without reference counting.

- Validate numeric arguments as safe integers within the range of the
  `uint32_t`/`int32_t` they are narrowed to, and check `nUbatch <= nBatch`
  and `nCtxMin <= nCtx`. Previously only finiteness was checked, so fractions
  truncated and negatives wrapped — `marginMiB: -1` became a margin nothing
  could satisfy. Enforced in the native binding as well as the JS wrapper,
  since `./binding.js` is a public export that bypasses the wrapper.

- Accept a negative `nGpuLayers`. `llama.h` defines it as "a negative value
  means all layers" — it is the llama default, and what upstream's fit-params
  prints back as `-ngl -1` — so rejecting it turned documented input into an
  error. The internal "not pinned" marker is now a separate flag rather than an
  `INT32_MIN` sentinel, which also frees that value for real use. The same
  applies when reading the result: a negative `nGpuLayers` means the fitter
  never rewrote the field, which is what happens on a host with no accelerator.
- Default `nCtxMin` to 4096 when unset — upstream's own
  `common_params::fit_params_min_ctx` default — and resolve a fitted context of 0 to the
  model's trained context (read from GGUF KV metadata, no weights loaded), so a
  `SUCCESS` never reports `nCtx: 0`. An explicitly requested context remains a
  hard constraint and is now asserted to come back unchanged.

### Added

- Coverage for what the fitter does under memory pressure. `llama_params_fit`
  assumes host memory is unlimited, so an unsatisfiable device margin is met by
  moving every layer to the host rather than by reporting `FAILURE` — `fits`
  stays true, and the plan rather than the flag is the admission signal. Driven
  by the margin rather than by model size, which keeps it deterministic across
  runners with different VRAM.
- Coverage for the `FAILURE` verdict, which turns out to require a pinned
  constraint. Unpinned, the fitter always has the host to fall back on, so it
  answers even an unsatisfiable margin with `SUCCESS` and zero offload; pinning
  `nGpuLayers` makes offload a hard requirement and produces a real "won't fit".
  Documented, because it means `fits` alone is not an admission signal.
- Documented two crash paths inside `llama_params_fit` that this addon cannot
  contain: a `ggml_abort()` in `graph_reserve` on a large `nCtx`, and the
  Windows divide-by-zero. Both terminate the process.
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
