# @qvac/ocr-ggml — Changelog

All notable changes to this package will be documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-06-12

### Added
- Opt-in **Metal** GPU backend on Apple via `params.backendDevice: 'metal'`,
  extending the existing `backendDevice` option (`'cpu'` | `'vulkan'`). The
  Metal backend is compiled into the addon (no extra shared library); requested
  Metal transparently falls back to CPU — with an explicit `fallbackReason` —
  when no Metal-capable device is present. Enabled by requesting the
  `qvac-fabric` `gpu-backends` feature, which builds ggml with Metal on Apple.
  Validated CPU↔Metal output parity on Apple M3 Ultra for both the EasyOCR and
  DocTR pipelines.

### Changed
- **DocTR depthwise convolutions now run on the direct Metal `CONV_2D_DW` kernel**
  (via `qvac-fabric` `8828.1.1`), replacing the `im2col` + per-channel matmul
  lowering that was pathologically slow on Metal. Cuts recognition latency
  ~30–45% on Apple GPUs (M4 and real iOS devices) with identical output;
  detection and recognition feature extractors both switch to
  `ggml_conv_2d_dw_direct`, and depthwise weights load as F32 so the kernel runs
  on every backend.
- **Vulkan auto-selection now skips Adreno GPUs** and falls back to CPU — with
  an explicit `fallbackReason` — instead of silently using Adreno's
  numerically-broken Vulkan compute path (cos-sim ~0.73 vs reference on Adreno
  830 / Galaxy S25, vs >0.999 on Mali / Metal / NVIDIA). An explicit
  `params.gpuDevice` index still selects a specific device — including an Adreno
  one — for deliberate use (e.g. benchmarking / driver bring-up). Metal
  selection is unaffected.

## [0.1.1] - 2026-06-02

### Changed
- Bumped the `qvac-lib-inference-addon-cpp` vcpkg dependency to `1.2.1`.

## [0.1.0] - 2026-05-25

Initial release.

### Added
- Bare addon (`@qvac/ocr-ggml`) wrapping the
  [`tetherto/easy-ocr-ggml`](https://github.com/tetherto/easy-ocr-ggml)
  CRAFT detector + CRNN gen-2 recognizer pipeline.
- `OcrGgml` JS class with the same surface as `@qvac/ocr-onnx`:
  `load() / run() / unload() / destroy() / getState()`.
- C++ `Pipeline` `IModel` adapter (composes EasyOCR steps
  `StepDetectionInference`, `StepBoundingBox`, `StepRecognizeText`, or
  DocTR steps `StepDoctrDetectionGGML`, `StepDoctrRecognitionGGML`,
  selected at load time via `OcrConfig::mode` / `PipelineMode`).
- Single bare module that ships `ggml::ggml` plus every dynamic ggml
  backend exported by `qvac-fabric` (CPU + GPU backend `.so` files
  installed under `prebuilds/`).
- Optional config knobs: `magRatio`, `defaultRotationAngles`,
  `contrastRetry`, `lowConfidenceThreshold`, `recognizerBatchSize`,
  `nThreads`, `backendsDir`.
- Runtime stats (`totalTime`, `detectionTime`, `recognitionTime`,
  `numBoxes`).
- BMP-in-JS / JPEG-PNG-in-C++ image decoding (same convention as
  `@qvac/ocr-onnx`).
- Examples (`examples/quickstart.js`), JS unit tests
  (`test/unit/api.test.js`), and per-pipeline integration tests
  (`test/integration/easyocr.test.js`, `test/integration/doctr.test.js`)
  sharing a `test/integration/helpers.js` utility module.
