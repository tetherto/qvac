# Changelog

All notable changes to `@qvac/classification-ggml` will be documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.1] - 2026-07-01

### Changed

- Bumped the `qvac-lib-inference-addon-cpp` vcpkg dependency to `1.2.2` (self-pin fix for safe `Worklet.terminate()` on Android).

## [0.7.0] - 2026-06-24

### Changed

- `qvac-fabric` dependency bumped `9341.0.0` → `9341.1.0` (Qwen3.5-VL multi-tile batching; no API change for this package).

## Pull Requests

- [#2838](https://github.com/tetherto/qvac/pull/2838) - QVAC-19119 feat[api]: bump qvac-fabric to 9341.1.0 (classification-ggml)

## [0.6.1] - 2026-06-22

### Changed

- Windows prebuilds now link the static Visual C++ runtime (`/MT`) instead of
  importing `vcruntime140.dll`, `msvcp140.dll`, or UCRT DLLs from the MSVC
  redistributable. Shared monorepo `vcpkg-overlays/triplets/{x64,arm64}-windows.cmake`
  build dependencies with a static CRT; addon CMake no longer links `msvcrt.lib`,
  which had forced the dynamic runtime. Per-package vcpkg overlays were
  consolidated into the shared `vcpkg-overlays/` tree. No public API change.

## Pull Requests

- [#2722](https://github.com/tetherto/qvac/pull/2722) - QVAC-21100: Switch to static C/C++ windows runtimes

## [0.6.0] - 2026-06-22

### Changed

- Updated the `qvac-fabric` vcpkg dependency to registry version `9341.0.0`, which enables `GGML_BACKEND_DL` dynamic backend loading on desktop Linux: the Vulkan GPU backend and runtime-dispatched CPU micro-architecture variants now load as standalone modules from `prebuilds`. No public API change.

## Pull Requests

- [#2733](https://github.com/tetherto/qvac/pull/2733) - QVAC-20827 feat[api]: GGML_BACKEND_DL desktop backends (Vulkan) across fabric consumers

## [0.5.0] - 2026-06-18

### Changed

- Updated the `qvac-fabric` vcpkg dependency to registry version `8828.1.2` (adds the OpenCL DocTR ops — `CONV_2D_DW`, `POOL_2D`, `HARDSWISH`, `HARDSIGMOID` — for the Adreno OpenCL backend; no behavioral change for this package).

## Pull Requests

- [#2617](https://github.com/tetherto/qvac/pull/2617) - feat[api]: DocTR Adreno OpenCL — direct regular conv (~0.72s on S25) + qvac-fabric 8828.1.2

## [0.4.0] - 2026-06-12

### Changed

- Updated the `qvac-fabric` vcpkg dependency to registry version `8828.1.1` (adds the direct Metal `CONV_2D_DW` depthwise-convolution kernel).

## Pull Requests

- [#2536](https://github.com/tetherto/qvac/pull/2536) - feat[api]: DocTR depthwise convs via direct Metal CONV_2D_DW kernel

## [0.3.1] - 2026-06-06

### Changed

- Pinned to the Fabric revision used by the M-RoPE/iM-RoPE sliding-context work.

## Pull Requests

- [#2438](https://github.com/tetherto/qvac/pull/2438) - feat[notask]: add M-RoPE sliding context support

## [0.3.0] - 2026-06-02

### Changed

- Bumped the `qvac-lib-inference-addon-cpp` vcpkg dependency to `1.2.1`.

## [0.2.1] - 2026-05-26

### Changed

- Updated the `qvac-fabric` vcpkg dependency to registry version `8828.0.2`.

## [0.2.0] - 2026-05-23

### Changed

- Updated the `qvac-fabric` vcpkg dependency to registry version `8828.0.1` for mobile and desktop C++ builds.
- Switched environment access in the JS wrapper to `bare-env`, keeping default model path and native logger toggles compatible with Bare runtimes.

## [0.1.0]

### Added

- Initial release of the GGML image classification addon.
- `ImageClassifier` public API (`load`, `classify`, `unload`) orchestrated
  via `@qvac/infer-base`'s `createJobHandler` + `exclusiveRunQueue`,
  mirroring the lifecycle pattern used by `@qvac/llm-llamacpp`.
- C++ `ClassificationModel` implementing the MobileNetV3-Small architecture
  directly against `libggml` (34 conv + 2 linear layers, with depthwise
  separable convolutions, HardSwish activations, and squeeze-and-excite
  blocks). BatchNorm is folded into the preceding convolution at load time
  via `foldBn()` (`eps = 0.001`); the runtime graph evaluates only the
  resulting scale/shift, with no per-inference BN op.
- FP16 GGUF weights (2.94 MB) bundled in `weights/` and loaded with
  `gguf_init_from_file()` + `ggml_backend_tensor_set()`.
- Image preprocessing pipeline: JPEG / PNG decode via `stb_image`, bilinear
  resize to 224x224, ImageNet-normalization, WHCN tensor layout.
- Integration tests (brittle + bare) covering happy path, raw-RGB input,
  edge cases, and lifecycle errors.
- C++ unit tests (GoogleTest) covering graph construction, BN epsilon,
  softmax normalization, and FP16 weight loading.
- ONNX-to-GGUF conversion guide in `docs/onnx-to-gguf-conversion.md`.
- `nativeLogger` constructor option (default `false`) that gates the shared
  native C++→JS logger bridge; off by default because the underlying
  `qvac-lib-inference-addon-cpp` `JsLogger` singleton's static `uv_async_t`
  lifecycle is not safe across rapid create/destroy cycles. JS-level
  logging always routes through the caller's `logger`.

### Removed

- `threads` constructor option. libggml's CPU thread pool now sizes itself
  to `std::thread::hardware_concurrency` on every platform. The knob was
  unimplementable on Android (the `ggml_backend_cpu_set_n_threads` symbol
  lives inside the per-microarch CPU variant `.so` loaded via `dlopen`,
  not in the addon's statically-linked `.bare`), and exposing it only on
  desktop / iOS would have produced silently inconsistent behaviour across
  platforms. Removed for API consistency.

> **Note.** SDK plugin / schema integration (canonical model type
> `ggml-classification` with `classification` alias) is **out of scope** for
> 0.1.0 and will land in a follow-up PR; see the PR description for the
> rationale.
