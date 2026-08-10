# Changelog

## [Unreleased]

### Changed

- `qvac-fabric` dependency bumped `9840.1.1` -> `10069.0.0`, joining the rest of
  the addon consumers on the b10069 rebase. `common/fit.h` is unchanged between
  the two, so `common_fit_params` keeps its signature and behaviour here.

- The JS API is now generated from TypeScript. `src/index.ts` is the single
  hand-written copy; root `index.js` and `index.d.ts` are emitted by
  `npm run build:ts` and committed, matching `@qvac/embed-llamacpp`. Previously
  the runtime, the JSDoc and the declarations were three files kept in sync by
  hand, and they had already drifted: `index.d.ts` and the README carried
  `reason`, `nDevices`, `nGpuDevices`, `buftOverrides` and the placement fields
  while the JSDoc `@returns` still described the older, smaller result object.
  `npm run check:generated` rebuilds and fails on any difference from what is
  committed, so the same drift cannot recur silently. No runtime behaviour
  changes.

- Reject a relative `modelPath`. The API documented the field as absolute but
  only checked that it was a non-empty string, so a relative path resolved
  against the process working directory — which nothing in a worklet controls,
  making the same call name a different file, or no file, depending on where the
  host was launched. Enforced in the wrapper and again in `runFit`, so
  `./binding.js` cannot bypass it. Matches `files.model` in
  `@qvac/embed-llamacpp`. The path is still not required to exist: a missing
  model remains the documented `ERROR` / `model-unreadable` outcome.

- Bound `nCtxMin` by the model's declared `context_length`. The `nCtx` guard was
  bypassable through the floor: `nCtxMin <= nCtx` is only checked when `nCtx` is
  concrete, and `nCtx: 0` is the documented way to let the fitter choose, so
  `{ nCtx: 0, nCtxMin: 75000000 }` reached `common_fit_params` unchecked. An
  explicit floor above the declared length now throws. The 4096 default is
  clamped to the declared length instead of throwing, since it is this package's
  value rather than the caller's — and a floor above the top of the reduction
  range constrained nothing anyway.

- Correct the package description: this addon wraps `common_fit_params`, not
  `llama_params_fit`, since the fabric 9840.1.1 port below.

- Bump `qvac-fabric` to 9840.1.1, in lockstep with the rest of the monorepo, and
  port to the API the fitter now lives behind. Upstream moved it out of the core
  llama ABI into libcommon (ggml-org/llama.cpp#22171, "move fit params
  implementation to libcommon"): `llama_params_fit` in `llama.h` became
  `common_fit_params` in `common/fit.h`, and `llama_params_fit_status` became
  `common_params_fit_status`. The parameter list and the 0/1/2 status values are
  unchanged, so this is a rename plus linking `llama::llama-common`. Worth
  knowing: fabric's `llama.h` still carries the old declaration, so the previous
  version compiled and linked and failed only at `dlopen` with
  `undefined symbol: llama_params_fit`.

- Default `backendsDir` to this package's own `prebuilds` directory when the
  caller does not pass one, mirroring `@qvac/llm-llamacpp`'s addon.js. Since
  9840 the ggml backends ship as separate shared libraries rather than static
  archives, and ggml's default search path (executable directory, cwd) does not
  cover an npm package's prebuilds — so the CPU backend never loaded and every
  fit failed with "no CPU backend found". An explicitly passed `backendsDir`
  still wins, including a bad one, so a caller's stated intent fails loudly
  rather than being silently replaced.

- `model-fit` is now covered by the `verify-qvac-fabric-lockstep` action, which
  checks a hardcoded file list that did not include it. The gate was passing
  vacuously while this package sat on 8828.1.2. (`ocr-ggml`, `vla-ggml` and
  `fabric` are still absent from that list.)

### Fixed

- Register ggml backends before fitting. `llama_params_fit` only reads ggml's
  global device registry and never populates it, so without an explicit
  `llama_backend_init()` the fitter could project against an empty device list
  and still report `SUCCESS`. Every fit now loads the packaged backends (new
  optional `backendsDir`, `BACKENDS_SUBDIR` appended) or falls back to ggml's
  default search path, then initialises the llama backend. Registration is
  never undone: `llama_backend_free()` is not the inverse of
  `llama_backend_init()` — it releases the process-global IQ dequantisation
  tables shared by every llama consumer, which would corrupt inference running
  concurrently in `@qvac/llm-llamacpp` (which reference-counts to avoid exactly
  that). Leaving the backends registered is free, since ggml's registry
  de-duplicates.

- Validate `backendsDir` before it reaches `ggml_backend_load_all_from_path`,
  which `dlopen`s every backend library it finds there. It must now be an
  absolute path, and is canonicalised (collapsing `..`, following symlinks) and
  required to resolve to an existing directory — so resolution never depends on
  the process working directory, and the directory scanned is the real one
  rather than an alias. Documented as application-controlled input in
  `index.d.ts` and the README.

- Reject an unsatisfiable `LLAMA_SPLIT_MODE_NONE` placement. NONE puts the whole
  model on one GPU, and llama then requires `mainGpu` to index its device list;
  with no GPU registered it rejects every index, the default 0 included. The
  fitter performs that load internally, so the whole call came back as a bare
  `ERROR`/"failed to load model" — indistinguishable from a genuine "does not
  fit" and impossible for a caller to act on. A pinned NONE is now rejected up
  front when no GPU is registered, or when `mainGpu` is past the ones that are.
  Only NONE is checked, since it is the only mode under which llama reads
  `mainGpu`; the checks live in `runFit` rather than the binding because the
  valid range is unknown until backends are registered.

- Serialise fit calls process-wide. `llama.h` documents `llama_params_fit` as
  not thread safe because it mutates global llama logger state, and this addon's
  C++ statics are shared across worklets, so concurrent callers now block. This
  also keeps two backend registrations from overlapping, which is what allows
  the unconditional setup above to stay correct without reference counting.

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

- Reject an `nCtx` above the context length the model declares. llama.cpp only
  warns, because RoPE scaling lets a caller exceed the trained length — but this
  addon exposes none of those knobs, so the model's own declared length is the
  most it can legitimately be asked for, and a YaRN-extended model already
  reports its extended figure there. This also keeps the values that reproduce
  the documented abort out of llama's hands, though it is a guard against
  nonsense input rather than a fix: the fault is KV-cache placement, which a
  large model on a small device can still hit at an ordinary context.

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
