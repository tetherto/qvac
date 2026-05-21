#pragma once

// Shared input/config types for ocr-ggml `IModel` adapters.
//
// `OcrInput` and `OcrConfig` mirror @qvac/ocr-onnx's JS API surface and are
// consumed by every IModel adapter in this addon (EasyOcrModel,
// DoctrOcrModel, …). They live in this header so adapters do not have to
// include one another just to access the shared payload type.

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

// NOLINTBEGIN(readability-identifier-naming)
// OcrInput / OcrConfig field names follow the @qvac/ocr-onnx JS API
// surface; constructor parameter pairs (pathDetector/pathRecognizer) and
// (imageWidth/imageHeight) are documented at the call site.

namespace qvac_lib_infer_ocr_ggml {

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
