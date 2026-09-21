#include "LoggingMacros.hpp"

#include <algorithm>
#include <mutex>
#include <utility>
#include <vector>

using namespace qvac_lib_inference_addon_cpp::logger;

namespace qvac_lib_inference_addon_sd {
namespace logging {

// Default to ERROR to prevent log spam before verbosity is configured
std::atomic<Priority> g_verbosityLevel{Priority::ERROR};

namespace {
std::mutex verbosityMutex;
Priority baseVerbosity = Priority::ERROR;
std::vector<std::pair<const ScopedVerbosity*, Priority>> overrides;

Priority priorityFor(int level) {
  switch (level) {
  case 0:
    return Priority::ERROR;
  case 1:
    return Priority::WARNING;
  case 2:
    return Priority::INFO;
  default:
    return Priority::DEBUG;
  }
}
} // namespace

ScopedVerbosity::ScopedVerbosity(std::optional<int> level) {
  if (!level.has_value())
    return;
  const std::lock_guard<std::mutex> lock(verbosityMutex);
  if (overrides.empty()) {
    baseVerbosity = g_verbosityLevel.load(std::memory_order_relaxed);
  }
  overrides.emplace_back(this, priorityFor(*level));
  g_verbosityLevel.store(overrides.back().second, std::memory_order_relaxed);
}

ScopedVerbosity::~ScopedVerbosity() {
  const std::lock_guard<std::mutex> lock(verbosityMutex);
  const auto it = std::find_if(
      overrides.begin(), overrides.end(), [this](const auto& entry) {
        return entry.first == this;
      });
  if (it == overrides.end())
    return;
  overrides.erase(it);
  g_verbosityLevel.store(
      overrides.empty() ? baseVerbosity : overrides.back().second,
      std::memory_order_relaxed);
}

void setVerbosityLevel(
    std::unordered_map<std::string, std::string>& configMap) {
  auto it = configMap.find("verbosity");
  if (it == configMap.end())
    return;

  Priority priority = Priority::ERROR;
  try {
    priority = priorityFor(std::stoi(it->second));
  } catch (...) {
  }

  const std::lock_guard<std::mutex> lock(verbosityMutex);
  // A later explicit global setting supersedes earlier session overrides.
  overrides.clear();
  baseVerbosity = priority;
  g_verbosityLevel.store(priority, std::memory_order_relaxed);

  configMap.erase(it);
}

} // namespace logging
} // namespace qvac_lib_inference_addon_sd
