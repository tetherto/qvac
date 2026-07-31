#include "AppleMemoryTelemetry.hpp"

#include <sstream>

namespace qvac_lib_inference_addon_sd::apple_memory {

Snapshot capture() noexcept { return {}; }

std::size_t requestPressureRelief() noexcept { return 0; }

std::string describe(const std::string& stage, const Snapshot& snapshot) {
  std::ostringstream oss;
  oss << "iOS memory telemetry [" << stage << "]: unavailable"
      << " phys_footprint_bytes=" << snapshot.physicalFootprintBytes
      << " resident_bytes=" << snapshot.residentBytes
      << " metal_allocated_bytes=" << snapshot.metalAllocatedBytes
      << " metal_recommended_working_set_bytes="
      << snapshot.metalRecommendedWorkingSetBytes
      << " os_available_memory_bytes=" << snapshot.availableMemoryBytes;
  return oss.str();
}

} // namespace qvac_lib_inference_addon_sd::apple_memory
