# Changelog

## [0.8.0] - 2026-05-16

### Removed

- `'flux_flow'` prediction type removed from the public API (`PredictionType`, JS validator, C++ handler, error messages, and C++ unit tests). Use `'flux2_flow'` for FLUX.2 models. Callers passing `'flux_flow'` will now receive an `InvalidArgument` error from the C++ layer.
- SD1.x references removed across all documentation (README, `index.d.ts` JSDoc, `docs/architecture.md`) and internal C++ source (`SdCtxHandlers.hpp`, `SdGenHandlers.hpp`, `SdGenHandlers.cpp`, `SdModel.hpp`, `SdModel.cpp`, `AddonJs.hpp`). SD1.x models are not supported; the references were misleading. Supported families remain SD2.x, SDXL, SD3, and FLUX.2 [klein].

### Fixed

- FLUX2 img2img OOM on large input images: `_fillDimsFromImage` in `addon.js` was copying the input image's pixel dimensions as the output resolution for any axis the caller omitted, causing allocations proportional to the input image (e.g. ~288 GB for a 2252×4000 photo). `index.js` now defaults each missing axis to 1024 for both single-ref (`init_image`) and fusion (`init_images`) FLUX img2img paths.
- FLUX2 img2img OOM during diffusion: `SdCtxConfig::diffusionFlashAttn` (JS: `diffusion_fa`) now defaults to `true`. Without flash attention, FLUX2 materialises the full Q·Kᵀ joint-attention matrix in VRAM (~288 GB for a 1024×1024 output on Vulkan). The default is safe for all model families: `ggml_ext_attention_ext` falls back to standard attention via `ggml_backend_supports_op` on backends that don't support `ggml_flash_attn_ext`, so SD2.x/SDXL/SD3 callers are unaffected. Callers who need to opt out can pass `diffusion_fa: false` in the config.
- `img2img-flux2.js` and `img2img-flux2-f16.js`: add explicit `diffusion_fa: true` (now the addon default, kept for clarity) and `width: 1024, height: 1024` to `run()` params so examples work with any input image regardless of its dimensions. `generate-image-flux2-i2i.test.js` gains the same `diffusion_fa: true` flag to prevent OOM on GPU runners.
- Generation now throws `StatusError` when the addon produces zero output images (previously silently completed with an empty result). The most common cause is a VAE decode failure.
- Remove `if (gen.width == 512 && gen.height == 512)` block from `SdModel.cpp`. This block overrode output dimensions with the input image's pixel size whenever both axes equalled 512. JS callers relying on the 1024-pixel JS-side defaults were unaffected, but JS callers explicitly requesting `width: 512, height: 512` — and **direct C++ callers** that relied on this block for dimension auto-detection — now receive a fixed 512×512 output instead of one scaled to the input image.

## [0.7.0] - 2026-05-06

### Added

- Standalone ESRGAN upscaler API via named export `EsrganUpscaler` for upscaling existing PNG/JPEG images without loading a diffusion model
- End-to-end ESRGAN integration coverage for both post-generation upscale and standalone upscale output dimensions

### Changed

- Native log routing is no longer connected/released per instance; configure process-global native C++ logs through `addonLogging.setLogger()` for coexistence safety

## [0.6.0] - 2026-05-01

### Added

- Post-generation ESRGAN upscale support via `files.esrgan` and `run({ upscale: true })` / `run({ upscale: { repeats } })`
- ESRGAN upscaler configuration for tile size, direct convolution, CPU parameter offload, and thread count
- JS integration coverage for the ESRGAN upscale public API guard and forwarding path
- Example script for SD2.1 generation followed by ESRGAN upscale (`examples/generate-image-esrgan-upscale.js`)

## [0.5.0] - 2026-04-21

### Added

- **FLUX.2 multi-reference fusion** (`init_images` parameter) — blend multiple reference images into a single output via in-context conditioning with RoPE-separated latent tokens
- `@imageN` tag support in prompts for semantic anchoring of reference images (FLUX.2-klein + Qwen3 text encoder)
- Fusion-specific parameters: `increase_ref_index` (default `false` — refs share one RoPE slot and blend via attention; recommended for FLUX.2-klein) and `auto_resize_ref_image` (default `true`) for fine-grained control over multi-ref conditioning
- Comprehensive integration tests for FLUX.2 multi-reference fusion — both "injective" (spatial composition, `generate-image-flux2-fusion.test.js`) and "surjective" (face morphing / feature averaging, `generate-image-flux2-fusion-surjective.test.js`) scenarios
- Example script demonstrating fusion workflow with two scientists (`examples/generate-fusion.js`)
- Detailed README section on multi-reference fusion, `@imageN` tags, and best practices
- Claude Shannon test image under `assets/` (Bell Labs / Wikimedia Commons, CC BY-SA) alongside the existing von Neumann image, with a credits section documenting both sources and licenses

### Changed

- Input validation for fusion parameters: strict type checking for `init_images` (non-empty array of `Uint8Array`), mutual exclusion against `init_image`, FLUX.2-only gating for `init_images` / `increase_ref_index` / `auto_resize_ref_image`, and dimension alignment checks (width/height multiples of 8)
- Consolidated fusion examples: removed `generate-stepbrothers.js` and `multi-ref-flux2.js`, updated `generate-fusion.js` to a minimal two-scientist demo
- `.gitignore` refined to ignore generated `*.png` at package root while preserving tracked images under `assets/**`

### Removed

- `scripts/download-flux2-small-decoder.sh` (unused)
- `scripts/multi-ref-flux2-anime.sh` (superseded by `examples/generate-fusion.js`)

## [0.4.0] - 2026-04-21

### Added

- LoRA support to diffusion generation via `run({ lora })`, forwarding a LoRA adapter path through the JS bridge and native addon into stable-diffusion.cpp's `sd_img_gen_params_t.loras` runtime path
- Real LoRA integration test that downloads a compatible SD2.1 LoRA adapter, runs image generation with it, and verifies a valid PNG output is produced

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

- Updated inference-addon-cpp dependancy from 1.1.2 to 1.1.5
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
