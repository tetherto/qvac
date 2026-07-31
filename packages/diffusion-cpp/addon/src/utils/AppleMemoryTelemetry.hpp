#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace qvac_lib_inference_addon_sd::apple_memory {

struct Snapshot {
  bool available{false};
  uint64_t physicalFootprintBytes{0};
  uint64_t residentBytes{0};
  uint64_t metalAllocatedBytes{0};
  uint64_t metalRecommendedWorkingSetBytes{0};
  uint64_t availableMemoryBytes{0};
};

[[nodiscard]] Snapshot capture() noexcept;
[[nodiscard]] std::size_t requestPressureRelief() noexcept;
[[nodiscard]] std::string describe(const std::string& stage, const Snapshot& snapshot);

} // namespace qvac_lib_inference_addon_sd::apple_memory
