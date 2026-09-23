#pragma once

#include <atomic>
#include <optional>
#include <string>
#include <unordered_map>

#include "inference-addon-cpp/Logger.hpp"

namespace qvac_lib_inference_addon_sd {
namespace logging {

// Global verbosity level shared across all SD model instances
extern std::atomic<qvac_lib_inference_addon_cpp::logger::Priority>
    g_verbosityLevel;

class ScopedVerbosity {
public:
  explicit ScopedVerbosity(std::optional<int> level);
  ~ScopedVerbosity();
  ScopedVerbosity(const ScopedVerbosity&) = delete;
  ScopedVerbosity& operator=(const ScopedVerbosity&) = delete;
  ScopedVerbosity(ScopedVerbosity&&) = delete;
  ScopedVerbosity& operator=(ScopedVerbosity&&) = delete;
};

/**
 * Parse the "verbosity" key from a config map and set the global log level.
 * 0=error, 1=warn, 2=info, 3=debug. Leaves the level unchanged if absent.
 */
void setVerbosityLevel(std::unordered_map<std::string, std::string>& configMap);

} // namespace logging
} // namespace qvac_lib_inference_addon_sd

// Conditional log macro - only emits if priority <= current global level
// NOLINTNEXTLINE(cppcoreguidelines-macro-usage)
#define QLOG_IF(priority, message)                                             \
  do {                                                                         \
    if (static_cast<int>(priority) <=                                          \
        static_cast<int>(                                                      \
            qvac_lib_inference_addon_sd::logging::g_verbosityLevel.load(       \
                std::memory_order_relaxed))) {                                 \
      QLOG(priority, message);                                                 \
    }                                                                          \
  } while (0)
