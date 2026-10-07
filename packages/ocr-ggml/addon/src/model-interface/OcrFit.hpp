#pragma once

#include <cstdint>
#include <optional>
#include <string>

#include "OcrTypes.hpp"

namespace qvac_lib_infer_ocr_ggml::ocr_fit {
struct OcrFitFootprint {
  uint64_t sourceBytes{};
  uint64_t elements{};
};

struct OcrFitResult {
  std::string status{"error"};
  std::string reason{"uncertain"};
  std::string deviceName;
  uint64_t deviceBytes{};
  uint64_t hostBytes{};
  uint64_t weightsBytes{};
  uint64_t deviceFreeBytes{};
  uint64_t deviceTotalBytes{};
  std::string report;
};

// Inspect tensor descriptors only; no tensor data or image is loaded.
std::optional<OcrFitFootprint> inspectOcrGguf(
    const std::string& path, const char* requiredTensor);

// Advisory weight-load check. Unknown placement or memory yields status=error.
OcrFitResult assessOcrFit(
    const std::string& detectorPath, const std::string& recognizerPath,
    const OcrConfig& config, uint64_t marginBytes);

} // namespace qvac_lib_infer_ocr_ggml::ocr_fit
