#pragma once

// Shared input/config types for the ocr-ggml `Pipeline` adapter.
//
// `OcrInput` and `OcrConfig` mirror @qvac/ocr-onnx's JS API surface; the
// `PipelineMode` enum lets `OcrConfig::mode` select between the EasyOCR
// (CRAFT + bounding-box + CRNN gen-2) and DocTR (DBNet + DocTR
// recognition) step sequences at load time, the same way ocr-onnx's
// `PipelineConfig::mode` does.

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

// NOLINTBEGIN(readability-identifier-naming)
// OcrInput / OcrConfig field names follow the @qvac/ocr-onnx JS API
// surface; constructor parameter pairs (pathDetector/pathRecognizer) and
// (imageWidth/imageHeight) are documented at the call site.

namespace qvac_lib_infer_ocr_ggml {

// Selects which backend the `Pipeline` constructs at load time. Mirrors
// `qvac_lib_inference_addon_onnx_ocr_fasttext::PipelineMode`.
enum class PipelineMode {
  EASYOCR, // CRAFT detection + bounding-box extraction + CRNN gen-2 recognition
  DOCTR    // DBNet detection + DocTR recognition
};

// Mirrors @qvac/ocr-onnx's PipelineInput so the JS side can interchangeably
// drive both addons. Either pass an encoded JPEG/PNG byte buffer (set
// `isEncoded`) or a raw RGB image with explicit width/height.
struct OcrInput {
  int imageWidth{};
  int imageHeight{};
  std::vector<uint8_t> data;
  bool isEncoded{false};
  bool paragraph{false};
  std::optional<std::vector<int>> rotationAngles;
  // TODO(clang-tidy): extract OcrInput / OcrConfig defaults as named
  // constants (kDefaultBoxMargin, kDefaultMagRatio, kDefaultRotationAngles,
  // kDefaultLowConfidenceThreshold, kDefaultRecognizerBatchSize).
  // NOLINTNEXTLINE(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)
  float boxMarginMultiplier{0.1F};
};

// NOLINTBEGIN(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)
struct OcrConfig {
  // Pipeline mode (EasyOCR vs DocTR). Default matches the JS / CLI /
  // README contract: EasyOCR is the primary pipeline; callers opt in to
  // DocTR explicitly via `params.pipelineType: 'doctr'`.
  PipelineMode mode{PipelineMode::EASYOCR};
  float magRatio{1.5F};
  std::vector<int> defaultRotationAngles{90, 270};
  bool contrastRetry{false};
  float lowConfidenceThreshold{0.4F};
  int recognizerBatchSize{32};
  // <0 leave GGML default, 0 auto-detect physical cores, >0 explicit override.
  int nThreads{0};
  // Directory that holds dynamic ggml backend shared libraries (libggml-*.so).
  // Default empty -> ggml_backend_load_all() picks up backends via env / dl
  // path.
  std::string backendsDir;
};
// NOLINTEND(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)

} // namespace qvac_lib_infer_ocr_ggml

// NOLINTEND(readability-identifier-naming)
