#pragma once

#include <string>
#include <unordered_map>

#include "qvac-lib-inference-addon-cpp/Logger.hpp"

namespace qvac_lib_inference_addon_sd {
namespace logging {

// Global verbosity level shared across all SD model instances
extern qvac_lib_inference_addon_cpp::logger::Priority g_verbosityLevel;

/**
 * Parse the "verbosity" key from a config map and set the global log level.
 * 0=error, 1=warn, 2=info, 3=debug. Defaults to ERROR if not present.
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
            qvac_lib_inference_addon_sd::logging::g_verbosityLevel)) {         \
      QLOG(priority, message);                                                 \
    }                                                                          \
  } while (0)
