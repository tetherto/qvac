# Changelog

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
