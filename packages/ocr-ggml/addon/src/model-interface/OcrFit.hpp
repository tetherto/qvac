#pragma once

#include <algorithm>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "OcrTypes.hpp"

namespace qvac_lib_infer_ocr_ggml::ocr_fit {
struct OcrFitFootprint {
  uint64_t sourceBytes{};
  uint64_t elements{};
};

struct FitDevice {
  std::string id;
  std::string name;
  bool unified{};
  uint64_t usedBytes{};
  uint64_t freeBytes{};
  uint64_t totalBytes{};
};

struct OcrFitResult {
  // "fits", "does-not-fit", or "unknown" when no reliable verdict exists.
  std::string status{"unknown"};
  std::vector<FitDevice> devices;
};

// Caps every unified row's free memory at the app's memory limit, which iOS
// enforces on all of them together. A limit of 0 is an exhausted limit.
inline void capToAppLimit(std::vector<FitDevice>& rows, uint64_t limit) {
  for (FitDevice& row : rows) {
    if (row.unified) {
      row.freeBytes = std::min(row.freeBytes, limit);
    }
  }
}

// Each row is charged the conservative upper bound. A verdict exists only at
// the two ends: the upper bound fits every row with the margin left free, or on
// the CPU even the source tensors do not. Between them the load may or may not
// fit, so the answer stays unknown.
inline std::string ocrVerdict(
    const std::vector<FitDevice>& rows, uint64_t sourceBytes,
    uint64_t marginBytes, bool cpu) {
  const auto room = [marginBytes](const FitDevice& row) {
    return row.freeBytes > marginBytes ? row.freeBytes - marginBytes : 0;
  };
  if (std::ranges::all_of(rows, [&](const FitDevice& row) {
        return row.usedBytes <= room(row);
      })) {
    return "fits";
  }
  if (cpu && sourceBytes > room(rows.front())) {
    return "does-not-fit";
  }
  return "unknown";
}

// Inspect tensor descriptors only; no tensor data or image is loaded.
std::optional<OcrFitFootprint>
inspectOcrGguf(const std::string& path, const char* requiredTensor);

// Advisory weight-load check. A model that cannot be read, or no backend
// device, throws.
OcrFitResult assessOcrFit(
    const std::string& detectorPath, const std::string& recognizerPath,
    const OcrConfig& config, uint64_t marginBytes);

} // namespace qvac_lib_infer_ocr_ggml::ocr_fit
