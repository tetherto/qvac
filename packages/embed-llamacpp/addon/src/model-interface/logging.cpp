#include "logging.hpp"

#include "common/common.h"

using namespace qvac_lib_inference_addon_cpp::logger;

namespace qvac_lib_infer_llamacpp_embed::logging {
// Global verbosity level - initialized to ERROR as safe default
// This ensures that if llamaLogCallback is triggered before verbosity is set,
// only ERROR messages will be shown, preventing log spam
Priority g_verbosityLevel = Priority::ERROR;

namespace {
Priority verbosityToPriority(int verbosity) {
  switch (verbosity) {
  case 0:
    return Priority::ERROR;
  case 1:
    return Priority::WARNING;
  case 2:
    return Priority::INFO;
  case 3:
  default:
    return Priority::DEBUG;
  }
}

void logInvalidVerbosity(const std::string& value) {
  QLOG_IF(
      Priority::ERROR,
      string_format(
          "Invalid verbosity value '%s', using default ERROR level",
          value.c_str()));
}
} // namespace

void setVerbosityLevel(
    std::unordered_map<std::string, std::string>& configFilemap) {
  // Parse verbosity level from config and set it globally
  // This must be called before initializeBackend() to ensure llamaLogCallback
  // has the correct verbosity level from the start
  auto configIt = configFilemap.find("verbosity");
  if (configIt == configFilemap.end()) {
    return;
  }
  try {
    int verbosity = std::stoi(configIt->second);
    if (verbosity < 0 || verbosity > 3) {
      logInvalidVerbosity(configIt->second);
      g_verbosityLevel = Priority::ERROR;
      return;
    }
    g_verbosityLevel = verbosityToPriority(verbosity);
  } catch (const std::exception&) {
    logInvalidVerbosity(configIt->second);
    g_verbosityLevel = Priority::ERROR;
  }
  configFilemap.erase(configIt);
}

void llamaLogCallback(ggml_log_level level, const char* text, void* userData) {
  // Convert ggml_log_level to QLOG Priority
  Priority priority;
  switch (level) {
  case GGML_LOG_LEVEL_ERROR:
    priority = Priority::ERROR;
    break;
  case GGML_LOG_LEVEL_WARN:
    priority = Priority::WARNING;
    break;
  case GGML_LOG_LEVEL_INFO:
    priority = Priority::INFO;
    break;
  case GGML_LOG_LEVEL_DEBUG:
    priority = Priority::DEBUG;
    break;
  case GGML_LOG_LEVEL_NONE:
  case GGML_LOG_LEVEL_CONT:
  default:
    priority = Priority::DEBUG;
    break;
  }

  // Only log if the message priority is at or above the configured verbosity
  // level
  QLOG_IF(priority, string_format("[Llama.cpp] %s", text));
}

} // namespace qvac_lib_infer_llamacpp_embed::logging
