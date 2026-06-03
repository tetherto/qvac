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
enum class PipelineMode : std::uint8_t {
  EASYOCR, // CRAFT detection + bounding-box extraction + CRNN gen-2 recognition
  DOCTR    // DBNet detection + DocTR recognition
};

// Selects which ggml backend device the inference steps run on. `CPU` is the
// always-available default; `VULKAN` opts in to GPU execution when a
// Vulkan-capable device is present, otherwise the steps fall back to CPU
// (see `OcrBackendSelection`). Mirrors the opt-in GPU pattern in
// `vla_backend_selection`.
enum class BackendDevice : std::uint8_t { CPU, VULKAN };

// Mirrors @qvac/ocr-onnx's PipelineInput so the JS side can interchangeably
// drive both addons. Either pass an encoded JPEG/PNG byte buffer (set
// `isEncoded`) or a raw RGB image with explicit width/height.
struct OcrInput {
  int imageWidth{};
  int imageHeight{};
  // NOLINTNEXTLINE(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)
  int bitsPerPixel{24};
  std::vector<uint8_t> data;
  bool isEncoded{false};
  bool paragraph{false};
  std::optional<std::vector<int>> rotationAngles;
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
  // EasyOCR `canvas_size`: detection canvas cap (long side, px) after magRatio
  // scaling. Bounds the CRAFT graph's peak memory; default 2560 matches
  // @qvac/ocr-onnx and EasyOCR. Lower on memory-constrained targets (mobile)
  // to avoid the dense-page OOM in QVAC-19340. EasyOCR only.
  int canvasSize{2560};
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
  // Requested ggml backend device. CPU is the default and is always available;
  // VULKAN opts in to GPU inference and transparently falls back to CPU when no
  // Vulkan-capable device is present (mapped from `params.backendDevice` in
  // AddonJs.hpp).
  BackendDevice backendDevice{BackendDevice::CPU};
};
// NOLINTEND(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)

} // namespace qvac_lib_infer_ocr_ggml

// NOLINTEND(readability-identifier-naming)
