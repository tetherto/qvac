#pragma once

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace qvac_lib_inference_addon_llama::backend_reporting {

inline constexpr const char* K_BACKEND_NAME_ID = "_backendNameId";

// Stats capture an index into these names before a reload can change placement.
// Repeated placements reuse their index, so storage does not grow per job.
class RuntimeBackendName {
public:
  void set(std::string name) {
    std::lock_guard lock(mutex_);
    const auto found = std::find(names_.begin(), names_.end(), name);
    if (found == names_.end()) {
      names_.push_back(std::move(name));
      current_ = names_.size() - 1;
    } else {
      current_ = static_cast<size_t>(found - names_.begin());
    }
  }

  [[nodiscard]] int64_t snapshot() const {
    std::lock_guard lock(mutex_);
    return static_cast<int64_t>(current_);
  }

  [[nodiscard]] std::string get(int64_t id) const {
    std::lock_guard lock(mutex_);
    return names_.at(static_cast<size_t>(id));
  }

  [[nodiscard]] std::string get() const {
    std::lock_guard lock(mutex_);
    return names_[current_];
  }

private:
  mutable std::mutex mutex_;
  std::vector<std::string> names_{""};
  size_t current_ = 0;
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

} // namespace qvac_lib_inference_addon_llama::backend_reporting
