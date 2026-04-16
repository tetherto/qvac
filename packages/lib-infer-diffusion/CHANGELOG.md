# Changelog

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
