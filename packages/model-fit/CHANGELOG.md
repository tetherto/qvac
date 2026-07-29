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

- Remove the Windows-only `__try/__except` around `llama_params_fit`. It existed
  to contain an integer divide-by-zero on the Windows GPU runner, but the root
  cause was the missing backend registration fixed above: with no device
  registered, a count reached a division as zero. With `llama_backend_init()` in
  place, win32 CI returns a real projection and the SEH filter never fires.
  Removing it also resolves the objection that resuming after a structured
  exception leaves llama's global logger pointing at a dead stack frame.

### Added

- `reason` on the result — `fits`, `does-not-fit`, `model-unreadable` or
  `no-backend-device`. `status` alone could not separate "this hardware cannot
  run it" from "the model could not be read", which left the documented
  proceed-on-unknown path impossible to diagnose.
- `buftOverrides` on the result: the tensor placement the fitter selected. These
  were previously discarded, so a `SUCCESS` could depend on placement the real
  load would not reproduce.
- `FitResult` is now a discriminated union on `status`, with the plan valid only
  on `SUCCESS`, plus a consumer type test (`test/types/`) that checks branch
  narrowing and exhaustiveness — the dts check previously only compiled the
  declaration itself.
- `NOTICE` and `LICENSE`, which `package.json` already listed in `files`.

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
