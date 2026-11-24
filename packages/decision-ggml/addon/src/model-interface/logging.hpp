#pragma once

#include <atomic>
#include <string>
#include <unordered_map>

#include <llama.h>

#include "inference-addon-cpp/Logger.hpp"

namespace qvac_lib_inference_addon_decision::logging {

// Global verbosity level - same for all instances. Atomic: a model being
// constructed sets it while another model's threads log through it.
// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables)
extern std::atomic<qvac_lib_inference_addon_cpp::logger::Priority>
    g_verbosityLevel;

// Parse verbosity from config map and set global level
// This should be called before any logging callbacks are registered
void setVerbosityLevel(
    std::unordered_map<std::string, std::string>& configFilemap);

void llamaLogCallback(ggml_log_level level, const char* text, void* userData);

} // namespace qvac_lib_inference_addon_decision::logging
//
// Simple logging macro that uses global verbosity level
// Usage: QLOG_IF(Priority::DEBUG, "Debug message");
// NOLINTNEXTLINE(cppcoreguidelines-macro-usage)
#define QLOG_IF(priority, message)                                             \
  do {                                                                         \
    if (static_cast<int>(priority) <=                                          \
        static_cast<int>(                                                      \
            qvac_lib_inference_addon_decision::logging::g_verbosityLevel.load( \
                std::memory_order_relaxed))) {                                 \
      QLOG(priority, message);                                                 \
    }                                                                          \
  } while (0)
