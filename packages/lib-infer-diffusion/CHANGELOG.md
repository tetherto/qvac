# Changelog

## [0.3.0] - 2026-04-15

This release migrates the diffusion addon off `BaseInference` inheritance and onto the composable `createJobHandler` + `exclusiveRunQueue` utilities from `@qvac/infer-base@^0.4.0`. The constructor signature is replaced with a single object whose `files` field carries absolute paths for every model component, mirroring the parallel embed and LLM addon refactors. This is a breaking change — every caller must update.

### Breaking Changes

#### Constructor signature: single object with `files` instead of `(args, config)`

`ImgStableDiffusion` now takes a single `{ files, config, logger?, opts? }` object. The old `diskPath` + `modelName` + per-component filename pattern is gone — callers pass absolute paths directly via `files`. Companion model fields are renamed (`clipLModel` → `clipL`, `clipGModel` → `clipG`, `t5XxlModel` → `t5Xxl`, `llmModel` → `llm`, `vaeModel` → `vae`).

```js
// BEFORE (≤ 0.2.x)
const model = new ImgStableDiffusion({
  diskPath: '/models',
  modelName: 'flux-2-klein-4b-Q8_0.gguf',
  llmModel: 'Qwen3-4B-Q4_K_M.gguf',
  vaeModel: 'flux2-vae.safetensors',
  logger: console
}, { threads: 8 })

// AFTER (0.3.0)
const model = new ImgStableDiffusion({
  files: {
    model: '/models/flux-2-klein-4b-Q8_0.gguf',
    llm:   '/models/Qwen3-4B-Q4_K_M.gguf',
    vae:   '/models/flux2-vae.safetensors'
  },
  config: { threads: 8 },
  logger: console,
  opts: { stats: true }
})
```

#### `BaseInference` inheritance removed

`ImgStableDiffusion` no longer extends `BaseInference`. The class composes `createJobHandler` and `exclusiveRunQueue` from `@qvac/infer-base@^0.4.0` directly. The public lifecycle (`load` / `run` / `cancel` / `unload` / `getState`) is unchanged in shape; only construction differs. Internal helpers like `_withExclusiveRun` and `_outputCallback` are removed.

#### Caller owns absolute paths — addon no longer joins `diskPath` + filename

Callers that previously relied on the addon to resolve `path.join(diskPath, filename)` must now do that resolution themselves before constructing the model.

#### `getState()` returns a narrower shape

`getState()` previously returned `{ configLoaded, weightsLoaded, destroyed }` (the three-field shape from `BaseInference`). It now returns `{ configLoaded }` only. The `weightsLoaded` and `destroyed` fields are gone — `weightsLoaded` collapsed into `configLoaded` because the refactored `load()` does both in one step, and `destroyed` is no longer tracked since `unload()` resets `configLoaded` and nulls the addon handle instead. Callers reading `state.weightsLoaded` or `state.destroyed` must switch to `state.configLoaded`.

#### Public methods removed from `ImgStableDiffusion`

`ImgStableDiffusion` previously exposed these methods via `BaseInference` inheritance, all of which are now gone:

- `downloadWeights(onDownloadProgress, opts)` — the diffusion addon never used the loader in practice, but the inherited method was still present on the public surface. It is removed along with the base class.
- `pause()` / `unpause()` / `stop()` — BaseInference job-lifecycle helpers. The refactor uses `createJobHandler` directly; use `cancel()` to terminate an in-flight generation.
- `status()` — replaced by `getState()` for the static readiness flag; per-job state is observed via the `QvacResponse` returned by `run()`.
- `destroy()` — folded into `unload()`, which now both releases native resources and nulls `this.addon`.
- `getApiDefinition()` — no longer exposed; consumers should import types from `index.d.ts`.

#### `cancel()` no longer accepts a `jobId`

`BaseInference.cancel(jobId)` took an optional `jobId` argument. The refactor's `cancel()` is parameterless — there is always at most one active generation per instance, owned by `createJobHandler`. Any caller passing a `jobId` will have it ignored; update call sites to `await model.cancel()`.

### Features

#### Constructor input validation

The constructor now throws `TypeError('files.model must be an absolute path string')` when `files.model` is missing or not a string, or `TypeError('files.model must be an absolute path (got: <value>)')` when supplied as a relative path. This produces a clear error for callers porting old code instead of a confusing `Cannot read properties of undefined`. The same validation applies to optional companion fields (`clipL`, `clipG`, `t5Xxl`, `llm`, `vae`) when supplied.

#### `run()`-before-`load()` guard

Calling `run()` before `load()` now throws `Error('Addon not initialized. Call load() first.')` instead of crashing in native code. Covered by a new regression test in `test/integration/api-behavior.test.js`.

#### `load()` is now idempotent when already loaded

A second `load()` call on an already-loaded instance is now a silent no-op instead of unloading and reloading. This aligns with the ReadyResource pattern used elsewhere in QVAC and prevents accidental double-loads from triggering expensive work. Callers that intentionally want to swap weights must call `unload()` first (which clears `configLoaded`) and then `load()` again.

#### Broader split-layout detection

`isSplitLayout` now also triggers when only `clipL` or `clipG` is supplied. This closes a footgun where a FLUX.1 caller passing `{ model, clipL, clipG, vae }` (without `t5Xxl`) would silently mis-route the diffusion model into the all-in-one `path` parameter and fail to load.

### Bug Fixes

#### `unload()` clears the addon reference

`unload()` now sets `this.addon = null` after `await this.addon.unload()`, so post-unload `cancel()` / `run()` calls hit the explicit `if (!this.addon)` guard rather than dereferencing a disposed native handle.

#### Unknown addon events no longer pollute the output stream

`_addonOutputCallback` previously had a fallthrough that pushed any non-error / non-image / non-stats event into `response.output` (including `null` and `undefined`). It now logs unknown events at debug level and does not feed them into the active response.

#### Crash-safe activation

If `addon.activate()` throws during `_load()` (for example a native init failure or a missing model file discovered late), the partially-initialized addon is now best-effort-unloaded, the native logger is released, and `this.addon` is reset to `null`. A subsequent `load()` call starts cleanly instead of leaking a zombie native instance.

#### `load()` is serialized through the exclusive run queue

`load()` is now routed through the same `exclusiveRunQueue` used by `run()` and `unload()`. Previously two overlapping `load()` calls on the same instance could both pass the `configLoaded` guard before it flipped to `true`, both allocate a native addon, and clobber `this.addon` — leaking one native handle. Concurrent `load()` on a single instance is now safe.

### Pull Requests

- [#1496](https://github.com/tetherto/qvac/pull/1496) - chore[bc]: diffusion addon interface refactor — remove BaseInference

## [0.2.0] - 2026-04-15

### Added

- FLUX.2 img2img support with in-context conditioning (`ref_images`) via `init_image` parameter
- JS-side input validation for `readImageDimensions()` with buffer-length guards for truncated PNG/JPEG
- Regression tests for FLUX img2img prediction guard and truncated image handling

### Changed

- FLUX img2img now requires explicit `prediction: 'flux2_flow'` in config to prevent silent fallback to SDEdit
- Updated `prediction` docstring to clarify auto-detection is insufficient for FLUX img2img
- Exported `readImageDimensions()` for testing and external use

### Fixed

- `readImageDimensions()` now safely handles truncated/corrupt PNG and JPEG buffers

## [0.1.3] - 2026-04-15

### Changed

- README, `index.d.ts`, and `index.js` JSDoc no longer claim FLUX.1 support for `clipLModel` and `t5XxlModel`. The addon exposes SDXL, SD3, and FLUX.2-klein only — FLUX.1 was never wired through the JS layer. The example model name in the constructor JSDoc is also corrected to `flux-2-klein-4b-Q8_0.gguf`.

## [0.1.2] - 2026-04-03

### Changed

- Updated qvac-lib-inference-addon-cpp dependancy from 1.1.2 to 1.1.5
- Reason for the version update:
    - addon-cpp v1.1.2's cancelJob() unconditionally set the model's stop flag whenever a job existed, even if that job was only queued and never started processing. Since the queued job never entered process(), the flag was never consumed or reset.
    - In the diffusion addon, this meant that cancelling a request and then submitting a new one would cause the new request to abort instantly on entry — returning no results — because it inherited the stale stop flag from the previous cancel.

## [0.1.1] - 2026-04-02

### Fixed

- Handle absolute companion model paths in `_load()`. Absolute paths for `llmModel`, `vaeModel`, and other companion models were unconditionally joined with `diskPath`, producing doubled paths. Now uses `path.isAbsolute()` to pass absolute paths through unchanged (#1077)
- Correct type declarations and doc misalignments in `index.d.ts` and `index.js` (#1091)
- Fix race condition in integration test download utility (#1019)

### Changed

- Remove stale img2img references from docs (#1122)
- Update package.json URLs to monorepo (#1088)
- Remove overlay ports, build from vcpkg registry (#1066)
- Update dependencies with android-arm64 fix (#1095)

## [0.1.0] - 2026-03-19

### Added

#### Stable Diffusion inference addon

Initial release of the `@qvac/diffusion-cpp` native addon for image generation, supporting SD1.x, SD2.x, SDXL, SD3, and FLUX model families.

#### GPU acceleration

- Metal backend on macOS, iOS
- Vulkan backends on Windows, Linux, Android
- OpenCL backend on Android devices with Adreno GPU
- CPU fallback on all platforms

#### Android dynamic backend loading

Dynamic ggml backend loading (`GGML_BACKEND_DL`) on Android with `libqvac-diffusion-ggml-*` naming to avoid symbol conflicts with system-installed ggml libraries. CPU backends remain statically linked (`GGML_CPU_STATIC`) while GPU backends are loaded at runtime.

#### vcpkg-based build system

vcpkg overlay ports for `ggml` and `stable-diffusion-cpp` with clang override triplets for Linux and PIC static linking. Custom patches for runtime backend selection, abort callbacks, failure-path cleanup, and Android Vulkan diagnostics.
