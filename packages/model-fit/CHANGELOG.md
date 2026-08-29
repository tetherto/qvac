# Changelog

## [Unreleased]

### Fixed

- Mobile integration test bundling. The two raw-fitter cases in
  `test/integration/fit.test.js` reached the private `binding-internal.js`
  surface, which the mobile test framework does not shim into its generated
  `backend/` tree, so `bare-pack` failed with `MODULE_NOT_FOUND` and no mobile
  suite could build on either platform. Those cases now live in
  `test/integration/fit-internal.test.js`, which is excluded from the generated
  mobile suite via `scripts/mobile-integration-exclusions.js`. Both still run on
  desktop; no assertion changed. Broken since 0.6.0.

- `bare-url` is now declared. `test/mobile/integration-runtime.cjs` requires it
  and nothing in this package listed it.

## [0.7.0] - 2026-08-24

### Changed

- `qvac-fabric` dependency bumped `10069.2.0` -> `10297.0.0` (b10297 rebase with updated llama.cpp/ggml runtime; no API change for this package).

### Fixed

- Load-fit config normalization now uses the b10297 `load_mode` field, accepts
  `load-mode` directly, and preserves legacy `no-mmap` behavior without relying
  on the removed `common_params::use_mmap` member.

## [0.6.0] - 2026-08-22

### Added

- Disposable-process protocol v2, carrying an explicit
  `loadKind: 'completion' | 'embedding'` so the runner can select the matching
  normalization policy internally. `encodeFitLlamaProcessRequest(loadKind,
  config)` encodes it; `parseFitProcessResponse` answers both versions.
  Protocol v1 is unchanged and still accepted.

- Fit-relevant completion and embedding load normalization — backend selection,
  context/batch settings, split policy, flash/KV defaults, SWA and CPU
  placement — so a raw llama load config can be projected the way the addon
  that will run it would resolve it. This duplicates `llm-llamacpp` and
  `embed-llamacpp` for now; shared ownership can be revisited separately.

- `FitLlamaResult` and `FitLlamaReason` in `./process`, adding the
  `unsupported-config` outcome for a configuration the normalization cannot
  represent (mobile, streaming, sharded, multimodal, finetune, LoRA, RoPE/YaRN,
  unknown keys). The result is advisory and must never be used to deny a load.

  Deliberately a separate type: `fitParams()` cannot produce that outcome, so
  `FitResult` and `FitReason` are unchanged and existing low-level consumers
  narrow nothing new. Every `FitResult` is assignable to `FitLlamaResult`.

### Changed

- Raw load-parameter normalization stays private to the disposable process
  runner. `./binding.js`, which is a public export, now re-exports `paramsFit`
  explicitly rather than the whole addon, and the runner reaches the load-config
  fitter through the unexported `./binding-internal.js`. The package root
  continues to expose only the existing low-level `fitParams()` API.

- The C++ unit targets behind `BUILD_TESTING` now run in CI via
  `cpp-tests-model-fit.yml` and the `test:cpp` scripts, and their translation
  units are linted, so the normalization above is covered by the PR gate rather
  than by a local step.

### Fixed

These are all divergences between what this package projected and what the load
would actually do. Each was found by review of the normalization above and is
fixed against the behaviour of `llm-llamacpp` / `embed-llamacpp`:

- `llama_model_params::devices` is a NULL-terminated list, and neither list this
  package built carried the terminator. The single-GPU list read one element
  past its allocation on every fit; the CPU path passed an empty vector, which
  is not the same as an empty list — `common_model_params_to_llama` forwards
  only a non-empty one — so fabric fell back to default device selection,
  enumerating every GPU and skipping the host-memory check that is the only real
  constraint on a CPU load.

- The CPU path no longer pins `n_gpu_layers` to 0. The addons leave the field
  alone, and forcing it made `common_fit_params` abort when the projection
  needed to adjust it.

- An unset embedding context is pinned to the model's trained context, and an
  oversized one is capped rather than rejected, matching
  `embed-llamacpp`. Leaving it at 0 invited the fitter to report a reduced
  context, and a correspondingly reduced memory figure, for a load that runs at
  the full trained context.

- `flash-attn` is recognised as enabled on `on` only, as `llm-llamacpp` does.
  Accepting any truthy spelling fired the q8_0 KV auto-default where the real
  load keeps f16, under-estimating KV memory by roughly 2x.

- `ctx-size: '0'` no longer becomes a 4096 context floor. Fabric encodes "do not
  reduce the context" as `UINT32_MAX` in a signed field, and clamping that at
  zero inverted the one configuration that explicitly forbids reduction.

- Conflicting key aliases (`gpu-layers`/`n-gpu-layers`,
  `kv-offload`/`no-kv-offload`, `op-offload`/`no-op-offload`) are rejected
  instead of resolved by hash-bucket order, which made the verdict depend on
  internal hashing rather than on the request.

- `no-host` is a valueless flag upstream, so `no-host: 'false'` now reports
  `unsupported-config` instead of projecting the opposite weight placement.
  `host`, `extra-bufts` and `no-extra-bufts` leave the supported set for the
  same reason: qvac-fabric registers no such option, so no load can express
  them.

### Pull Requests

- [#3930](https://github.com/tetherto/qvac/pull/3930) - QVAC-22630 feat[api]:
  add config normalization to model-fit addon

## [0.5.0] - 2026-08-20

### Changed

- `qvac-fabric` dependency bumped `10069.1.1` -> `10069.2.0` (TurboVec CPU
  support from the fabric runtime; no API change for this package).

## [0.4.0] - 2026-08-18

### Changed

- `qvac-fabric` dependency bumped `10069.1.0` -> `10069.1.1` (Adreno OpenCL MoE
  repack fix; no API change for this package).

### Pull Requests

- [#3929](https://github.com/tetherto/qvac/pull/3929) - QVAC-23195 fix: bump
  qvac-fabric to 10069.1.1 across consumers

## [0.3.0] - 2026-08-18

### Changed

- `qvac-lib-inference-addon-cpp` dependency floor moves `1.2.1` -> `1.3.3`,
  bringing this package onto the same shared-runtime floor every other addon
  consumer already builds against. `model-fit` was the last one left behind.

  No source change is needed here. The addon uses only the header-only JS
  boundary (`inference-addon-cpp/Errors.hpp`, `JsInterface.hpp`, `JsUtils.hpp`)
  and its binding is synchronous — it never constructs an `AddonCpp`, a
  scheduler or an `OutputQueue` — so 1.3.0's two breaking changes (the
  `JobRunner` -> `SingleJobScheduler` rename with the `JobRunner.hpp` forwarding
  header removed, and `OutputQueue::clear()` returning job-tagged entries) reach
  nothing this package compiles.

  What the floor does pick up is the run of lifecycle fixes released between the
  two versions: the `dlclose()` self-pin that makes `Worklet.terminate()` safe on
  Android bionic (1.2.2), the `JsLogger` teardown and re-`setLogger` crash fixes
  and their concurrent-env ownership hardening (1.2.3, 1.2.4), and the
  `JsAsyncTask` teardown-thread and capture-release fixes (1.3.2, 1.3.3). The
  first three matter to `model-fit` in particular: it is designed to run in a
  short-lived isolated worklet, which is exactly the load/terminate cycle those
  fixes cover.

### Pull Requests

- [#3926](https://github.com/tetherto/qvac/pull/3926) - chore[notask]: bump
  model-fit to inference-addon-cpp 1.3.3

## [0.2.1] - 2026-08-18

Records a fix that was left out of `0.2.0`. It merged (#3890) before the
`model-fit-v0.2.0` tag was cut, so the code already shipped in `0.2.0` — this
release carries no source change of its own, only the entry that should have
been in that one.

### Fixed

- Reject a successful fit whose context could not be resolved. `runFit` already
  rewrote a fitted `nCtx` of 0 — llama's encoding for "use the trained context"
  — to the model's declared context length, but when that GGUF metadata was
  itself unavailable the zero survived and the caller was handed a `SUCCESS`
  carrying `nCtx: 0`: a verdict with no load plan it could replay. Such a result
  is now `ERROR` / `model-unreadable`, which is what the missing metadata
  actually means. The resolution moved out of `runFit` into
  `detail::finalizeFitContext` (`addon/src/fit/FitResultContext.cpp`) so it can
  be tested without a model, covered by a new `ModelFitContextUnit` test built
  under `BUILD_TESTING`.

- Reject a malformed successful response in the process codec.
  `parseFitProcessResponse` accepted a `completed` result with `status: 0` and a
  non-positive `nCtx`, so a child that answered with an unresolved context put
  it straight into a supervisor's hands. Defence in depth rather than a live
  path: with the fix above the runner can no longer produce one.

### Pull Requests

- [#3890](https://github.com/tetherto/qvac/pull/3890) - QVAC-22630 fix: reject
  unresolved successful fit contexts

## [0.2.0] - 2026-08-17

### Changed

- `qvac-fabric` dependency bumped `10069.0.0` -> `10069.1.0` (VisionPsy Nano
  support and its Flash preprocessing rule; no API change for this package).

## [0.1.0] - 2026-08-12

### Added

- Initial release of `@qvac/model-fit`, a memory-fit **preflight** addon that
  wraps llama.cpp's `llama_params_fit` C API to project — without loading any
  weights — whether a GGUF model fits available device memory, and if so with
  what offload plan (layers / context / tensor split). Intended to run in a
  short-lived isolated worklet before handing a model to `@qvac/llm-llamacpp`.
  (The wrapped entry point became `common_fit_params` before this first
  publish — see *Changed* below.)
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
- `@qvac/model-fit/process`, a boundary for running a projection in a child that
  can be thrown away. The subpath exports a versioned NDJSON codec
  (`encodeFitProcessRequest`, `parseFitProcessResponse`) and resolves a private
  one-shot runner to spawn with a Bare executable. It exists because the crash
  paths above terminate whoever calls the fitter, so the only way to survive
  them is to ask the question from a process that is expendable. Spawning and
  supervision are deliberately left to the caller.
- The runner answers with one line on stdout, and that line rather than the exit
  code is the result: `completed` for a projection, `invocation-error` for a
  request that threw or never reached the fitter, and no line at all when native
  code aborted. A missing or unparseable line is a failure whatever the status —
  exit 0 does not prove delivery, and exit 2 arrives both with and without a
  response. The outcome table in the README is the full contract.
- The addon is loaded only once a request has parsed, so a malformed or oversized
  request costs a spawn and never backend registration. The runner imposes no
  timeout of its own; bounding and cancelling the child is the supervisor's job.
- Two platform constraints a supervisor has to honour. On Windows the child's
  stdio must be created as overlapped pipes (`stdio: ['overlapped', ...]`), or
  the runner — itself a libuv program handed synchronous handles — never
  observes the request and hangs with no output and no diagnostic; the flag is a
  no-op elsewhere, so set it unconditionally. On darwin a cold child recompiles
  the embedded Metal library during backend discovery, which costs roughly ten
  seconds against a quarter of a second on linux and Windows, so a deadline must
  be sized for discovery rather than for the projection.

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
