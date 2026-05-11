# Changelog

All notable changes to `@qvac/classification-ggml` will be documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

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
