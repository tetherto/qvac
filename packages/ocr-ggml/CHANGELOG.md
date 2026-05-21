# @qvac/ocr-ggml — Changelog

All notable changes to this package will be documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
