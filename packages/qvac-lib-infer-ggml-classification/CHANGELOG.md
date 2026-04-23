# Changelog

All notable changes to `@qvac/classification-ggml` will be documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

### Added

- Initial release of the GGML image classification addon.
- `ImageClassifier` public API (`load`, `classify`, `unload`) implemented on
  top of `@qvac/infer-base`'s `BaseInference`.
- C++ `ClassificationModel` implementing the MobileNetV3-Small architecture
  directly against `libggml` (34 conv + 2 linear layers, with depthwise
  separable convolutions, HardSwish activations, and squeeze-and-excite
  blocks). BatchNorm is applied at runtime with `eps = 0.001`.
- FP16 GGUF weights (2.94 MB) bundled in `weights/` and loaded with
  `gguf_init_from_file()` + `ggml_backend_tensor_set()`.
- Image preprocessing pipeline: JPEG / PNG decode via `stb_image`, bilinear
  resize to 224x224, ImageNet-normalization, WHCN tensor layout.
- Integration tests (brittle + bare) covering happy path, raw-RGB input,
  edge cases, and lifecycle errors.
- C++ unit tests (GoogleTest) covering graph construction, BN epsilon,
  softmax normalization, and FP16 weight loading.
- SDK integration: new canonical model type `ggml-classification` with
  `classification` alias.
- ONNX-to-GGUF conversion guide in `docs/onnx-to-gguf-conversion.md`.
- `nativeLogger` constructor option (default `false`) that gates the shared
  native C++→JS logger bridge; off by default because the underlying
  `qvac-lib-inference-addon-cpp` `JsLogger` singleton's static `uv_async_t`
  lifecycle is not safe across rapid create/destroy cycles. JS-level
  logging always routes through the caller's `logger`.
