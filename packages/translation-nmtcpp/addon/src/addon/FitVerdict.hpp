#pragma once

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

namespace qvac_lib_inference_addon_nmt {

struct FitDevice {
  std::string id;
  std::string name;
  bool unified = false;
  uint64_t usedBytes = 0;
  uint64_t freeBytes = 0;
  uint64_t totalBytes = 0;
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

// A verdict exists only at the two ends: every row's charge fits with the
// margin left free, or on the CPU even the source bytes do not. Between them
// the load may or may not fit, so the answer stays unknown.
inline std::string fitVerdict(
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

} // namespace qvac_lib_inference_addon_nmt
