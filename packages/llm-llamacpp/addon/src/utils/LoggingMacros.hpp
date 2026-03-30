#pragma once

#include <string>
#include <unordered_map>

#include "qvac-lib-inference-addon-cpp/Logger.hpp"

namespace qvac_lib_inference_addon_llama {
namespace logging {
// Global verbosity level - same for all instances
extern qvac_lib_inference_addon_cpp::logger::Priority g_verbosityLevel;

// Parse verbosity from config map and set global level
// This should be called before any logging callbacks are registered
void setVerbosityLevel(
    std::unordered_map<std::string, std::string>& configFilemap);
} // namespace logging
} // namespace qvac_lib_inference_addon_llama

// Simple logging macro that uses global verbosity level
// Usage: QLOG_IF(Priority::DEBUG, "Debug message");
#define QLOG_IF(priority, message)                                             \
  do {                                                                         \
    if (static_cast<int>(priority) <=                                          \
        static_cast<int>(                                                      \
            qvac_lib_inference_addon_llama::logging::g_verbosityLevel)) {      \
      QLOG(priority, message);                                                 \
    }                                                                          \
  } while (0)
