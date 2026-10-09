#pragma once

#include <cstdint>
#include <optional>
#include <string>

namespace qvac_lib_inference_addon_bci {

struct EmbedderFootprint {
  uint64_t residentBytes = 0;
  uint64_t projectionCacheBytes = 0;
  uint64_t largestTransientBytes = 0;

  [[nodiscard]] uint64_t hostBytes() const;
};

std::optional<EmbedderFootprint> measureEmbedder(const std::string& path);

std::string colocatedEmbedderPath(const std::string& modelPath);

} // namespace qvac_lib_inference_addon_bci
