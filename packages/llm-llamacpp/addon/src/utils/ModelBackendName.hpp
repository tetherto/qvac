#pragma once

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <set>
#include <string>
#include <vector>

#include <inference-addon-cpp/RuntimeStats.hpp>

namespace qvac_lib_inference_addon_llama::backend_reporting {

inline std::string canonicalBackendFamily(std::string name) {
  std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return name == "mtl" ? "metal" : name;
}

struct ModelBackendAllocation {
  size_t modelBytes = 0;
  std::string backendName;
  bool host = false;
};

// CPU companion buffers do not change the reported accelerator family.
// An unidentified non-host allocation leaves the name unknown.
inline std::string
modelBackendName(const std::vector<ModelBackendAllocation>& allocations) {
  std::set<std::string> names;
  bool cpu = false;
  for (const auto& allocation : allocations) {
    if (allocation.modelBytes == 0) {
      continue;
    }
    if (allocation.host || allocation.backendName == "cpu") {
      cpu = true;
      continue;
    }
    if (allocation.backendName.empty()) {
      return {};
    }
    size_t offset = 0;
    while (offset < allocation.backendName.size()) {
      const size_t end = allocation.backendName.find(',', offset);
      names.insert(allocation.backendName.substr(offset, end - offset));
      if (end == std::string::npos) {
        break;
      }
      offset = end + 1;
    }
  }
  std::string result;
  for (const auto& name : names) {
    if (!result.empty()) {
      result += ",";
    }
    result += name;
  }
  return result.empty() && cpu ? "cpu" : result;
}

// The backendDevice code (0 cpu, 1 gpu, 2 npu) after placement: a model with
// no offloaded layers is on the CPU, and an NPU load keeps its own class.
inline int64_t
placedBackendDevice(int64_t selectedDevice, const std::string& backendName) {
  if (backendName.empty()) {
    return selectedDevice;
  }
  if (backendName == "cpu") {
    return 0;
  }
  return selectedDevice == 0 ? 1 : selectedDevice;
}

// An unknown name is left out of the stats rather than reported as empty.
inline void appendBackendName(
    qvac_lib_inference_addon_cpp::RuntimeStats& stats,
    const std::string& name) {
  if (!name.empty()) {
    stats.emplace_back("backendName", name);
  }
}

} // namespace qvac_lib_inference_addon_llama::backend_reporting
