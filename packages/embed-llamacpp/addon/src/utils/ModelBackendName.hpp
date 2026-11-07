#pragma once

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <mutex>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace qvac_lib_inference_addon_embed::backend_reporting {

// Metadata is set during model loading and read by queued JS callbacks.
class RuntimeBackendName {
public:
  void set(std::string name) {
    std::lock_guard lock(mutex_);
    name_ = std::move(name);
  }

  [[nodiscard]] std::string get() const {
    std::lock_guard lock(mutex_);
    return name_;
  }

private:
  mutable std::mutex mutex_;
  std::string name_;
};

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

} // namespace qvac_lib_inference_addon_embed::backend_reporting
