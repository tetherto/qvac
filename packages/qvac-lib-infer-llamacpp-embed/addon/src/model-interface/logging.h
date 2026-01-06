#pragma once

#include <string>
#include <unordered_map>

#include <llama.h>

#include "qvac-lib-inference-addon-cpp/Logger.hpp"

namespace qvac_lib_infer_llamacpp_embed::logging {

// Global verbosity level - same for all instances
extern qvac_lib_inference_addon_cpp::logger::Priority g_verbosityLevel;

// Parse verbosity from config map and set global level
// This should be called before any logging callbacks are registered
void SetVerbosityLevel(
    std::unordered_map<std::string, std::string>& configFilemap);

void llamaLogCallback(ggml_log_level level, const char* text, void* user_data);

} // namespace qvac_lib_infer_llamacpp_embed::logging
//
// Simple logging macro that uses global verbosity level
// Usage: QLOG_IF(Priority::DEBUG, "Debug message");
#define QLOG_IF(priority, message)                                             \
  do {                                                                         \
    if (static_cast<int>(priority) <=                                          \
        static_cast<int>(                                                      \
            qvac_lib_infer_llamacpp_embed::logging::g_verbosityLevel)) {       \
      QLOG(priority, message);                                                 \
    }                                                                          \
  } while (0)
