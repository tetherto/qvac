#pragma once

// Whether a MobileNet, MegaLoc or BridgeDepth model fits in free memory,
// judged on its measured footprint (ModelFootprint.hpp).

#include <algorithm>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace classification_ggml::fit {

// BridgeDepth input size assumed when the request names none. Upstream
// downsamples inputs above 720p, so 1280x720 is the largest input it runs at
// full size. Pending a product decision.
inline constexpr int DEFAULT_FIT_WIDTH = 1280;
inline constexpr int DEFAULT_FIT_HEIGHT = 720;

inline constexpr uint64_t MAX_JS_SAFE_INTEGER = 9007199254740991ULL;

struct FitDevice {
  std::string id;
  std::string name;
  bool unified = false;
  uint64_t usedBytes = 0;
  uint64_t freeBytes = 0;
  uint64_t totalBytes = 0;
};

struct FitResult {
  // "fits", "does-not-fit", or "unknown" when device memory cannot be read.
  std::string status{"unknown"};
  std::vector<FitDevice> devices;
};

// False when a row's memory cannot be read, which leaves the verdict unknown.
// The backends report a total of 0 for that, and a figure above the safe
// integer range cannot reach JS. A row with a total and nothing free is
// readable, and does not fit.
inline bool memoryIsReadable(const std::vector<FitDevice>& rows) {
  return std::ranges::all_of(rows, [](const FitDevice& row) {
    return row.totalBytes != 0 && row.totalBytes <= MAX_JS_SAFE_INTEGER &&
           row.freeBytes <= MAX_JS_SAFE_INTEGER;
  });
}

// Caps every unified row's free memory at the app's memory limit, which iOS
// enforces on all of them together. A limit of 0 is an exhausted limit.
inline void capToAppLimit(std::vector<FitDevice>& rows, uint64_t limit) {
  for (FitDevice& row : rows) {
    if (row.unified) {
      row.freeBytes = std::min(row.freeBytes, limit);
    }
  }
}

// The footprint is measured, so there is no band between an estimate and a
// bound: the load fits when every memory pool holds its usage plus the margin.
//
// A unified device row and the host row draw on the same physical memory, so
// they are one pool: their usage is summed and judged against the lowest free
// figure among them. Judging each row alone would let a Metal load that takes
// most of host memory on the GPU row and the rest on the CPU row pass twice
// over the same bytes. This is the pooling @qvac/inference applies when it
// combines models (model-fit/sum.ts), so a single model's verdict agrees with
// the pools it reports. A device with its own memory is a pool of its own.
inline std::string
fitVerdict(const std::vector<FitDevice>& rows, uint64_t marginBytes) {
  struct Pool {
    uint64_t usedBytes = 0;
    uint64_t freeBytes = UINT64_MAX;
  };
  std::map<std::string, Pool> pools;
  for (const FitDevice& row : rows) {
    // A device id never collides with this key: ids are bus ids or ggml
    // device names, which are not empty.
    Pool& pool = pools[row.unified ? std::string() : row.id];
    pool.usedBytes += row.usedBytes;
    pool.freeBytes = std::min(pool.freeBytes, row.freeBytes);
  }
  const bool fits = std::ranges::all_of(pools, [marginBytes](const auto& pool) {
    const Pool& value = pool.second;
    return value.freeBytes >= marginBytes &&
           value.usedBytes <= value.freeBytes - marginBytes;
  });
  return fits ? "fits" : "does-not-fit";
}

// The model kind is read from the GGUF. `width` and `height` size the
// BridgeDepth input and are ignored for the other models. A model that cannot
// be read, an unsupported GGUF, an unavailable backend or an input size
// inference would reject throws.
FitResult assessModelFit(
    const std::string& path, const std::string& backend,
    const std::string& backendsDir, int width, int height, int threads,
    uint64_t marginBytes);

} // namespace classification_ggml::fit
